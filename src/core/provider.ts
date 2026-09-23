/**
 * The provider interface — the contract this whole package is built around.
 *
 * Bespoke rather than Vercel AI SDK-shaped (DECISIONS.md D1): that spec has
 * no native place for availability with reason codes, token counting, or
 * capability discovery, which are the three things the router depends on. A
 * thin `LanguageModelV3` adapter over this interface stays possible later.
 *
 * Third parties are expected to implement this from outside the repo
 * (docs/plan.md §2), so the contract below is normative, not advisory.
 */

import type { Availability } from './availability';
import type { Capabilities } from './capabilities';
import type { GenerateRequest, GenerateResult } from './generation';
import type { Message } from './messages';
import type { StreamEvent } from './stream';
import type { ToolExecutor } from './tools';

/** Per-call options common to `generate` and `stream`. */
export interface RequestOptions {
  /**
   * Cancels the request. Aborting must stop real work (for the Apple
   * provider, cancel the Swift `Task` — not merely stop forwarding events)
   * and must surface as an `LLMError` with code `cancelled`, whether the
   * signal was already aborted at call time or fires mid-flight.
   */
  readonly signal?: AbortSignal;
  /**
   * Fallback handler for tool calls, used for any tool in
   * `GenerateRequest.tools` that has no `execute` of its own.
   *
   * Provided for the app that routes every tool through one dispatcher (a
   * `switch` on `toolName`, a generated client). Per-tool `execute` wins when
   * both are present, and a tool with neither makes the request
   * `invalidRequest` before generation starts.
   */
  readonly onToolCall?: ToolExecutor;
}

/**
 * A source of completions.
 *
 * Implementation contract:
 *
 * 1. **Stateless.** Every request carries the full conversation; hold no
 *    conversation state between calls. Native session objects may be cached
 *    as an optimization, but only when the incoming messages are exactly the
 *    cached history plus one new turn (docs/plan.md §2).
 * 2. **Never throw at import time.** Resolve native modules lazily inside
 *    method bodies, so importing the package root on Android or web works
 *    and simply reports `unavailable` / `unsupportedPlatform`
 *    (docs/plan.md §4).
 * 3. **Throw only `LLMError`.** Map every failure onto the taxonomy and run
 *    unclassified throws through `toLLMError` so the original is preserved
 *    as `cause`. Set `providerId` to this provider's `id`.
 * 4. **Routers are providers.** `createRouter()` (Phase 4) returns an
 *    `LLMProvider`, so routers compose and callers cannot tell how many
 *    providers sit behind the one they hold.
 */
export interface LLMProvider {
  /**
   * Stable identifier, surfaced on every `GenerateResult` and `LLMError`.
   * Short, lowercase, and unique within an app (`'apple'`, `'openai'`,
   * `'mock'`); used in telemetry and routing callbacks, so keep it stable
   * across versions.
   */
  readonly id: string;

  /**
   * Can this provider be used at all right now?
   *
   * Cheap enough to call on app start and on foreground (a model download
   * may have finished). Remember DECISIONS.md D9: `available` means "nothing
   * known is blocking", not "the next request will succeed" — never treat it
   * as a guarantee.
   */
  availability(): Promise<Availability>;

  /**
   * What this provider can do. May touch the native layer or the network,
   * hence async. Must not throw for a merely unavailable provider: report
   * the best-known capabilities (with `UNKNOWN` where honest) and let
   * `availability()` carry the bad news.
   */
  capabilities(): Promise<Capabilities>;

  /**
   * Count the tokens these messages will consume, for the context manager's
   * budget.
   *
   * Optional: present iff `capabilities().tokenCounting !== 'none'`. Apple
   * can answer exactly (iOS 26.4+ `tokenCount(for:)`), a cloud provider
   * usually cannot. Counting the *messages* rather than a string is
   * deliberate — per-message framing overhead is provider-specific and only
   * the provider knows it.
   *
   * Implementations should throw rather than guess when the underlying call
   * fails (Apple's has been observed throwing `ModelManagerError 1013`); the
   * caller can fall back to `estimateTokens` and knows to widen its margin.
   */
  countTokens?(messages: readonly Message[]): Promise<number>;

  /**
   * Ask the provider to get ready for a request that is coming.
   *
   * A **hint, not a contract**: it resolves `true` when the hint was delivered
   * and `false` when there was nothing to prewarm (wrong platform, no such
   * facility), and neither answer says anything about how fast the next
   * request will be. Never throws, and never required — a caller that skips it
   * gets identical results, only later.
   *
   * `messages` is the conversation so far, if known, so a provider can warm a
   * prompt prefix as well as its model. Unlike `generate`, it does not have to
   * end with a user message: the case this is for is a screen that has opened
   * and a user who has not finished typing.
   */
  prewarm?(messages?: readonly Message[]): Promise<boolean>;

  /** Produce one complete response. Rejects with an `LLMError` on any failure. */
  generate(request: GenerateRequest, options?: RequestOptions): Promise<GenerateResult>;

  /**
   * Produce a response incrementally.
   *
   * Returns the iterable **synchronously** (not a promise) so callers can
   * wire it up without an extra `await`, and so recording/validation happens
   * at call time. Work should not start until iteration begins. The last
   * event of a successful stream is exactly one `finish` carrying the same
   * `GenerateResult` that `generate()` would have produced; failures throw
   * out of the iterator rather than arriving as an event (see
   * `StreamEvent`).
   *
   * A provider whose backend cannot stream may emit a single `textDelta`
   * followed by `finish`, and must report `capabilities().streaming` as
   * `false` so callers can choose not to pretend.
   */
  stream(request: GenerateRequest, options?: RequestOptions): AsyncIterable<StreamEvent>;
}
