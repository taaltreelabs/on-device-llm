/**
 * `AppleProvider` — an `LLMProvider` backed by the Swift module wrapping
 * Apple's FoundationModels framework (docs/plan.md §5, Phase 3).
 *
 * Steps 1-3 only: availability with reason codes, capabilities and locales;
 * `generate` with instructions and sampling options, a session built from the
 * messages per request; `stream` converted to deltas with cancellation that
 * really stops native generation. Prewarming, token counting, structured
 * output and tool calling (steps 4-7) come after the maintainer checkpoint;
 * `capabilities()` reports them as absent rather than as broken.
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
  type RequestOptions,
  type StreamEvent,
  type UnknownValue,
} from '../core';
import { toLLMErrorFromNative, toUnavailableReason } from './errors';
import { resolveNativeModule } from './native/resolve';
import type { AppleNativeModule } from './native/types';
import { bridgeNativeStream } from './stream-bridge';
import { buildNativeRequest, nextRequestId, toFinishReason, toTokenUsage } from './wire';

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
   * `structuredOutput`, `tools` and `tokenCounting` are reported as absent
   * because the bridge has not implemented steps 5-7 yet, even though
   * `LanguageModelCapabilities` reports `guidedGeneration` and `toolCalling`
   * as `true` on this hardware. Advertising a capability the bridge cannot
   * honour would make the Phase 4 router route *toward* a provider that is
   * about to fail.
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
      // Phase 3 step 6.
      structuredOutput: false,
      // Phase 3 step 7.
      tools: false,
      // Phase 3 step 5. `SystemLanguageModel.tokenCount(for:)` exists and is
      // exact (docs/research/sdk-surface.md §1); until it is wired, `'none'`
      // is the honest answer and makes the context manager use the wider
      // estimate margin (D10).
      tokenCounting: 'none',
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

  async generate(request: GenerateRequest, options?: RequestOptions): Promise<GenerateResult> {
    const native = this.requireNative();
    const signal = options?.signal;
    this.throwIfAborted(signal);

    const args = buildNativeRequest(request, this.id);
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
        args.maxOutputTokens
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
    const args = buildNativeRequest(request, this.id);
    const requestId = nextRequestId();

    return bridgeNativeStream({
      native,
      requestId,
      providerId: this.id,
      start: () =>
        native.startStream(requestId, args.messages, args.temperature, args.maxOutputTokens),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  // ---- helpers -----------------------------------------------------------

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
