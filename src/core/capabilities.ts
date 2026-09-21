/**
 * What a provider can do, so callers (and the Phase 4 router) can decide
 * *whether* to send a request instead of finding out by failing.
 */

/**
 * Sentinel for "this provider cannot report that value".
 *
 * Chosen over `undefined`/optional fields on purpose. DECISIONS.md D9: the
 * native side has been observed returning `contextSize === 0` while
 * reporting itself available, and a `0` treated as a real window silently
 * turns every budget calculation into "nothing fits" (or, worse, into a
 * negative budget that reads as "everything fits" after a subtraction). An
 * optional number invites `caps.contextWindow ?? 4096` written in a hurry;
 * a *required* field whose type is `number | 'unknown'` makes the missing
 * case impossible to overlook — `'unknown' - 100` does not typecheck.
 */
export const UNKNOWN = 'unknown';

/** Type of the {@link UNKNOWN} sentinel. */
export type UnknownValue = typeof UNKNOWN;

/** Narrowing helper: is this value the {@link UNKNOWN} sentinel? */
export function isUnknown<T>(value: T | UnknownValue): value is UnknownValue {
  return value === UNKNOWN;
}

/**
 * How trustworthy `LLMProvider.countTokens()` is.
 *
 * - `exact` — the provider counts with the model's own tokenizer. Apple
 *   ships this publicly (`SystemLanguageModel.tokenCount(for:)`, iOS 26.4+,
 *   inside our OS floor — docs/research/sdk-surface.md §1).
 * - `estimated` — a heuristic (see `estimateTokens`). The Phase 2 context
 *   manager applies a larger safety margin when it sees this.
 * - `none` — no counting available; `countTokens` is absent.
 */
export type TokenCounting = 'exact' | 'estimated' | 'none';

/**
 * Static-ish description of a provider's abilities. Returned as a promise
 * because discovering it can require touching the native layer or the
 * network; callers may cache it for the lifetime of a process but should not
 * persist it across app launches (a model download or OS update changes it).
 *
 * FORWARD-COMPAT: further capability flags arrive as *optional* fields —
 * iOS 27 exposes `vision` and `reasoning` alongside `guidedGeneration` and
 * `toolCalling` (docs/research/sdk-surface.md §1) and those will be added
 * when a feature in this package consumes them. The four required booleans
 * below are the ones the router and the context manager branch on today.
 */
export interface Capabilities {
  /**
   * Total token budget for one request, **including the generated
   * response** — Apple's `contextSize` is documented as a combined
   * input+output budget, which is why the Phase 2 formula is
   * `window - reservedForOutput - safetyMargin`.
   *
   * `UNKNOWN` when the provider genuinely cannot say. Per DECISIONS.md D9 a
   * native `contextSize <= 0` must map to `UNKNOWN` and never be reported as
   * a real window; use {@link normalizeContextWindow} to do that mapping.
   */
  readonly contextWindow: number | UnknownValue;
  /** Whether `stream()` really streams (rather than emitting one delta at the end). */
  readonly streaming: boolean;
  /** Whether `GenerateRequest.schema` is honoured. */
  readonly structuredOutput: boolean;
  /** Whether tool calling is supported. Always `false` until Phase 3. */
  readonly tools: boolean;
  /** Trustworthiness of `countTokens()`; `'none'` iff `countTokens` is absent. */
  readonly tokenCounting: TokenCounting;
  /**
   * BCP-47 language tags the model supports, or `UNKNOWN` when the provider
   * cannot enumerate them (most cloud endpoints cannot).
   *
   * Apple *can*: it reports 24 tags via `supportedLanguages`
   * (docs/research/sdk-surface.md §1). Per DECISIONS.md D7 this list is how
   * a caller predicts an `unsupportedLocale` failure before paying for a
   * request; an empty array means "explicitly none", which is different from
   * `UNKNOWN` and must not be conflated.
   */
  readonly locales: readonly string[] | UnknownValue;
  /**
   * Human-readable model/variant label for logs and telemetry — Apple's
   * `variant.displayName` (e.g. `"AFM 3 Core"`), or a cloud model name.
   * Optional and purely informational: it explains why two devices report
   * different context windows, and it never drives routing decisions.
   */
  readonly modelLabel?: string;
}

/**
 * Map a raw, possibly untrustworthy context size onto
 * `Capabilities.contextWindow`.
 *
 * Exists so the D9 guard lives in exactly one place instead of being
 * re-derived (or forgotten) by each provider: anything that is not a finite
 * number greater than zero — `0` from a broken model state, `-1`, `NaN`,
 * `null`, a missing field — becomes `UNKNOWN`. Non-integers are floored,
 * since a fractional window is meaningless and rounding up would overstate
 * the budget.
 */
export function normalizeContextWindow(value: number | null | undefined): number | UnknownValue {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return UNKNOWN;
  }
  return Math.floor(value);
}
