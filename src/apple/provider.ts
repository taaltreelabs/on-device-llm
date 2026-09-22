/**
 * `AppleProvider` — an `LLMProvider` backed by the Swift module wrapping
 * Apple's FoundationModels framework (docs/plan.md §5, Phase 3).
 *
 * All of Phase 3 steps 1-7: availability with reason codes, capabilities and
 * locales; `generate` and `stream` (deltas, with cancellation that really stops
 * native generation) from a session built per request; prewarming; exact token
 * counting; structured output from a normalized JSON Schema; and tool calling,
 * where a native tool call suspends on a continuation while the request's
 * handler runs in JavaScript (DECISIONS.md D23-D26).
 */

import {
  LLMError,
  normalizeContextWindow,
  toLLMError,
  UNKNOWN,
  type Availability,
  type Capabilities,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type Message,
  type RequestOptions,
  type StreamEvent,
  type ToolExecutor,
  type UnknownValue,
} from '../core';
import { toLLMErrorFromNative, toUnavailableReason } from './errors';
import { resolveNativeModule } from './native/resolve';
import type { AppleNativeModule } from './native/types';
import { bridgeNativeStream } from './stream-bridge';
import {
  buildNativeRequest,
  nextRequestId,
  parseObjectJson,
  toFinishReason,
  toTokenUsage,
} from './wire';

/** Default per-tool-call budget. See {@link AppleProviderConfig.toolCallTimeoutMs}. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;

/** How the native module is obtained. Swapped in tests; not part of the public API. */
export type NativeResolver = () => AppleNativeModule | undefined;

/** Configuration for {@link createAppleProvider}. Deliberately small. */
export interface AppleProviderConfig {
  /** Stable provider id surfaced on results and errors. Defaults to `'apple'`. */
  readonly id?: string;
  /**
   * BCP-47 tag of the language this app will actually talk to the model in
   * (`'nl-NL'`, `'fr'`). Optional, and when set it is checked against
   * `SystemLanguageModel.supportsLocale` by `availability()` — see
   * DECISIONS.md D19. It does not add a per-request check: that would cost a
   * bridge hop on every call to re-answer a question whose answer cannot
   * change while the process is running.
   *
   * There is deliberately no `instructions` option: instructions come from the
   * `system` messages in each request, because the context manager and the
   * router own the conversation and a provider that owns a second, invisible
   * system prompt breaks that (docs/plan.md §2).
   */
  readonly locale?: string;
  /**
   * How long a tool call may wait for its handler before the request fails,
   * in milliseconds. Defaults to {@link DEFAULT_TOOL_CALL_TIMEOUT_MS}.
   *
   * There is a timeout at all because the alternative — which every bridge we
   * surveyed ships (DECISIONS.md D2) — is a handler that forgets to answer
   * pinning the neural engine for the life of the process, with no error and
   * nothing in the log. Timing out fails the request as `unknown`/transient
   * (D25), which a router can retry.
   */
  readonly toolCallTimeoutMs?: number;
}

const PLATFORM_DETAIL =
  'Apple FoundationModels is not available in this process. Expected on Android, on web, ' +
  'under Node, and on any iOS build without the native module (the package floor is iOS 27, ' +
  'DECISIONS.md D4).';

export class AppleProvider implements LLMProvider {
  readonly id: string;

  private readonly config: AppleProviderConfig;
  private readonly resolveNative: NativeResolver;

  /**
   * @param resolveNative - injection seam for tests. Production code uses the
   * default, which resolves lazily and never throws (`./native/resolve`).
   */
  constructor(
    config: AppleProviderConfig = {},
    resolveNative: NativeResolver = resolveNativeModule
  ) {
    this.config = config;
    this.id = config.id ?? 'apple';
    this.resolveNative = resolveNative;
  }

  /**
   * Availability, with reason codes.
   *
   * Three sources, in order:
   *
   * 1. **No native module** -> `unsupportedPlatform`. This is the branch that
   *    makes the package root importable everywhere (docs/plan.md §4): the
   *    module is resolved inside this method, in a `try`/`catch`, never at
   *    import time.
   * 2. **`SystemLanguageModel.availability`** -> its three reasons, renamed.
   * 3. **The configured `locale`**, if any -> see D19.
   */
  async availability(): Promise<Availability> {
    const native = this.resolveNative();
    if (native === undefined) {
      return { available: false, reason: 'unsupportedPlatform', detail: PLATFORM_DETAIL };
    }

    let nativeAvailability;
    try {
      nativeAvailability = await native.availability();
    } catch (err) {
      // A bridge that resolved but cannot answer is not a platform problem —
      // report it as the transient system failure it is (D9).
      return {
        available: false,
        reason: 'modelNotReady',
        detail:
          err instanceof Error ? err.message : 'The native module failed to report availability.',
      };
    }

    if (!nativeAvailability.available) {
      return {
        available: false,
        reason: toUnavailableReason(nativeAvailability.reason),
        ...(nativeAvailability.detail !== undefined ? { detail: nativeAvailability.detail } : {}),
      };
    }

    const locale = this.config.locale;
    if (locale !== undefined) {
      let supported = true;
      try {
        supported = await native.supportsLocale(locale);
      } catch {
        // Cannot tell — do not invent an unavailability. A real locale
        // failure will still surface as `unsupportedLocale` from generate().
        supported = true;
      }
      if (!supported) {
        // DECISIONS.md D19. `UnavailableReason` has no locale member (D7), and
        // of the three it does have, `deviceNotEligible` is the only one that
        // is permanent and non-retryable — which is what this is. The `detail`
        // carries the truth. Note this check is not merely an optimisation:
        // measured against the live model, a fully Polish prompt (`pl` is not
        // in `supportedLanguages`) was answered in fluent Polish rather than
        // raising `unsupportedLanguageOrLocale`, so the generation-time error
        // cannot be relied on and the pre-check is the only honest signal.
        return {
          available: false,
          reason: 'deviceNotEligible',
          detail: `The on-device model does not support the configured locale "${locale}".`,
        };
      }
    }

    return { available: true };
  }

  /**
   * What this provider can do *today*, not what the model can do.
   *
   * Every flag is answered from the model's own `LanguageModelCapabilities`
   * where it has an opinion, and from what the bridge implements otherwise:
   * `structuredOutput` follows `guidedGeneration`, `tools` follows
   * `toolCalling` *and* the presence of `resolveToolCall` on the native module
   * (a JS half newer than the native half must not advertise a protocol the
   * native side cannot speak), and `tokenCounting` is `'exact'` when
   * `countTokens` is there — `SystemLanguageModel.tokenCount(for:)` is the
   * model's own tokenizer, not an estimate. Advertising a capability the bridge
   * cannot honour would make the Phase 4 router route *toward* a provider that
   * is about to fail.
   */
  async capabilities(): Promise<Capabilities> {
    const unavailable: Capabilities = {
      contextWindow: UNKNOWN,
      streaming: false,
      structuredOutput: false,
      tools: false,
      tokenCounting: 'none',
      locales: UNKNOWN,
    };

    const native = this.resolveNative();
    if (native === undefined) return unavailable;

    let nativeCapabilities;
    try {
      nativeCapabilities = await native.capabilities();
    } catch {
      return unavailable;
    }

    // `0` (or anything non-positive) means the framework could not tell us —
    // observed live on a machine whose model assets were wedged (D9). It
    // becomes the typed `UNKNOWN`, which the Phase 2 context manager handles
    // explicitly (D11), rather than a guessed 4096.
    const contextWindow: number | UnknownValue = normalizeContextWindow(
      nativeCapabilities.contextWindow
    );

    const locales = Array.isArray(nativeCapabilities.locales)
      ? [...nativeCapabilities.locales]
      : undefined;

    return {
      contextWindow,
      streaming: true,
      structuredOutput: nativeCapabilities.supportsGuidedGeneration !== false,
      tools:
        nativeCapabilities.supportsToolCalling !== false &&
        typeof native.resolveToolCall === 'function',
      tokenCounting: typeof native.countTokens === 'function' ? 'exact' : 'none',
      locales: locales !== undefined && locales.length > 0 ? locales : UNKNOWN,
      ...(nativeCapabilities.modelLabel !== undefined
        ? { modelLabel: nativeCapabilities.modelLabel }
        : {}),
    };
  }

  /** `SystemLanguageModel.supportsLocale`, exposed so apps can pre-check without configuring one. */
  async supportsLocale(tag: string): Promise<boolean> {
    const native = this.resolveNative();
    if (native === undefined) return false;
    try {
      return await native.supportsLocale(tag);
    } catch {
      return false;
    }
  }

  /**
   * Hint that a request is coming. Never throws; resolves `false` when the hint
   * could not be delivered (no native module, or the framework declined).
   *
   * Explicitly **not** a performance contract (docs/plan.md §5 step 4):
   * `prewarm(promptPrefix:)` returns immediately and reports nothing, and
   * Apple's guidance is to call it only when a second or more will pass before
   * the request. Treat it as free and optional — the harness verifies that
   * prewarming then generating works, and deliberately asserts nothing about
   * how long either took.
   */
  async prewarm(messages?: readonly Message[]): Promise<boolean> {
    const native = this.resolveNative();
    if (native?.prewarm === undefined) return false;
    try {
      return await native.prewarm(
        messages !== undefined
          ? messages.map((message) => ({ role: message.role, content: message.content }))
          : null
      );
    } catch {
      return false;
    }
  }

  /**
   * Exact token count for these messages, from the model's own tokenizer.
   *
   * Throws rather than falling back to an estimate. That is the contract
   * `LLMProvider.countTokens` asks for and it matters: `createMeasure` catches
   * the throw, estimates instead, and records
   * `source: 'estimatorAfterCounterFailure'`, which widens the context
   * manager's safety margin from 64 tokens to 256 (D10). A silent estimate here
   * would report an exact-looking number and keep the narrow margin — which is
   * how a "measured" budget overflows. `ModelManagerError 1013` from these
   * overloads is not hypothetical (D9).
   */
  async countTokens(messages: readonly Message[]): Promise<number> {
    const native = this.requireNative();
    if (native.countTokens === undefined) {
      throw new LLMError(
        { code: 'unknown', transient: false },
        {
          message:
            'This build of the native module does not implement token counting. ' +
            '`capabilities().tokenCounting` reports `none`, so callers should estimate.',
          providerId: this.id,
        }
      );
    }
    const outcome = await native.countTokens(
      messages.map((message) => ({ role: message.role, content: message.content }))
    );
    if (!outcome.ok) throw toLLMErrorFromNative(outcome.error, this.id);
    if (!Number.isFinite(outcome.count) || outcome.count < 0) {
      throw new LLMError(
        { code: 'unknown', transient: true },
        {
          message: `The native token count was not a usable number (${outcome.count}).`,
          providerId: this.id,
        }
      );
    }
    return outcome.count;
  }

  async generate(request: GenerateRequest, options?: RequestOptions): Promise<GenerateResult> {
    // Tool calling needs an event channel to reach the handler mid-generation,
    // and `native.generate` is one promise with no channel. Rather than build a
    // second tool protocol for the non-streaming path, a request carrying tools
    // runs on the streaming path and the events are collapsed into a result
    // here (DECISIONS.md D24) — the `finish` event already carries exactly the
    // `GenerateResult` this method returns.
    if (request.tools !== undefined && request.tools.length > 0) {
      return this.generateViaStream(request, options);
    }

    const native = this.requireNative();
    const signal = options?.signal;
    this.throwIfAborted(signal);

    const args = buildNativeRequest(request, this.id, this.buildOptions(options));
    const requestId = nextRequestId();

    const onAbort = (): void => {
      native.cancel(requestId).catch(() => {
        // Already finished, most likely; nothing useful to do.
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const outcome = await native.generate(
        requestId,
        args.messages,
        args.temperature,
        args.maxOutputTokens,
        args.schemaJson
      );
      if (!outcome.ok) throw toLLMErrorFromNative(outcome.error, this.id);
      // The abort may have lost the race: native can finish normally between
      // `abort()` firing and `cancel()` landing. `RequestOptions.signal`
      // promises that an abort *always* surfaces as `cancelled`, so a result
      // the caller has already said they do not want is discarded here rather
      // than returned.
      this.throwIfAborted(signal);

      const usage = toTokenUsage(outcome.result.usage);
      return {
        text: outcome.result.text,
        ...(outcome.result.objectJson !== undefined
          ? { object: parseObjectJson(outcome.result.objectJson, this.id) }
          : {}),
        finishReason: toFinishReason(outcome.result.finishReason),
        ...(usage !== undefined ? { usage } : {}),
        providerId: this.id,
      };
    } catch (err) {
      // An abort that raced the response: the native side may have answered
      // normally before the cancel landed. The caller asked to stop, so
      // report `cancelled` either way.
      if (signal?.aborted === true) {
        throw new LLMError({ code: 'cancelled' }, { providerId: this.id, cause: signal.reason });
      }
      throw toLLMError(err, { providerId: this.id, transient: true });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  stream(request: GenerateRequest, options?: RequestOptions): AsyncIterable<StreamEvent> {
    // Not an `async function*` itself: argument validation must reject before
    // the first `next()`, not lazily at it, so a bad request fails where the
    // caller made it.
    const native = this.requireNative();
    const args = buildNativeRequest(request, this.id, this.buildOptions(options));
    if (args.tools.length > 0 && typeof native.resolveToolCall !== 'function') {
      throw new LLMError(
        { code: 'invalidRequest' },
        {
          message:
            'This build of the native module cannot run tools (it has no `resolveToolCall`). ' +
            'Check `capabilities().tools` before sending a request with tools.',
          providerId: this.id,
        }
      );
    }
    const requestId = nextRequestId();

    return bridgeNativeStream({
      native,
      requestId,
      providerId: this.id,
      start: () =>
        native.startStream(
          requestId,
          args.messages,
          args.temperature,
          args.maxOutputTokens,
          args.schemaJson,
          args.tools,
          args.toolCallTimeoutMs
        ),
      toolHandlers: args.toolHandlers,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  // ---- helpers -----------------------------------------------------------

  /**
   * Drive a request through `stream` and collapse it into a `GenerateResult`.
   *
   * The `finish` event carries the same result `generate` would have returned,
   * so this is a fold, not a reimplementation: text deltas and tool-call events
   * are dropped (a `generate` caller asked for the answer, not the commentary)
   * and any failure throws out of the iterator exactly as it would have
   * rejected the promise.
   */
  private async generateViaStream(
    request: GenerateRequest,
    options?: RequestOptions
  ): Promise<GenerateResult> {
    for await (const event of this.stream(request, options)) {
      if (event.type === 'finish') return event.result;
    }
    // Unreachable against the real bridge: the native side guarantees exactly
    // one terminal event, and an error throws rather than ending the stream.
    throw new LLMError(
      { code: 'unknown', transient: true },
      {
        message: 'The native stream ended without a result.',
        providerId: this.id,
      }
    );
  }

  private buildOptions(options?: RequestOptions): {
    onToolCall?: ToolExecutor;
    toolCallTimeoutMs?: number;
  } {
    const timeout = this.config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    return {
      ...(options?.onToolCall !== undefined ? { onToolCall: options.onToolCall } : {}),
      toolCallTimeoutMs: timeout,
    };
  }

  private requireNative(): AppleNativeModule {
    const native = this.resolveNative();
    if (native === undefined) {
      throw new LLMError(
        { code: 'unavailable', reason: 'unsupportedPlatform' },
        { providerId: this.id, message: PLATFORM_DETAIL }
      );
    }
    return native;
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new LLMError({ code: 'cancelled' }, { providerId: this.id, cause: signal.reason });
    }
  }
}
