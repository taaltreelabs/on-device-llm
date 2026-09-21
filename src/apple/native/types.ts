/**
 * The shape of the Swift module, as seen from JavaScript.
 *
 * Mirrors `ios/OnDeviceLlmModule.swift`. Nothing here imports anything —
 * these are types only, so the file is safe to load on any platform.
 *
 * Two conventions worth knowing before reading the rest of `src/apple`:
 *
 * 1. **Failures are returned, not thrown.** `generate` resolves to a
 *    discriminated union, and `startStream` reports every outcome through
 *    events. Expo's exception channel carries a code and a message; our
 *    taxonomy also carries `contextSize`/`tokenCount`, `resetDate`, `locale`
 *    and the native domain/code (DECISIONS.md D9), and none of that survives
 *    an exception. One shape for both paths also means one decoder.
 * 2. **Every streaming payload carries its `requestId`.** All streams share
 *    the single `onStreamEvent` event, so the bridge demultiplexes on that id
 *    and concurrent streams cannot interleave into the wrong consumer.
 */

/** `SystemLanguageModel.Availability`, flattened. `reason` is one of the three native unavailable reasons, already renamed to our vocabulary. */
export interface NativeAvailability {
  readonly available: boolean;
  /** `'deviceNotEligible' | 'notEnabled' | 'modelNotReady'`. Absent when available. */
  readonly reason?: string;
  readonly detail?: string;
}

/** What the model can report about itself. */
export interface NativeCapabilities {
  /**
   * `SystemLanguageModel.contextSize`, already guarded: the native side sends
   * `0` rather than a negative or nonsense value, and `0` means "unknown"
   * (DECISIONS.md D9 — it really has been observed on a wedged install).
   */
  readonly contextWindow: number;
  /** BCP-47 tags, minimal form (`'nl'`, `'en-GB'`, `'es-419'`). */
  readonly locales: readonly string[];
  /** `SystemLanguageModel.Variant.displayName`, e.g. `'AFM 3 Core Advanced'`. */
  readonly modelLabel?: string;
  // The four `LanguageModelCapabilities` flags, reported as the model sees
  // them. Steps 4-7 of Phase 3 consume these; `capabilities()` does not
  // advertise a feature the bridge has not implemented yet just because the
  // model supports it.
  readonly supportsVision?: boolean;
  readonly supportsGuidedGeneration?: boolean;
  readonly supportsToolCalling?: boolean;
  readonly supportsReasoning?: boolean;
}

/** Token usage, shaped like `core`'s `TokenUsage`. */
export interface NativeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

/** A finished generation. `providerId` is added by the TypeScript side. */
export interface NativeResult {
  readonly text: string;
  /** A `core` `FinishReason` string. */
  readonly finishReason: string;
  readonly usage?: NativeUsage;
}

/**
 * A failure already mapped onto an `LLMErrorCode` by `ios/Core/ErrorMapping.swift`.
 * Every optional field belongs to exactly one `LLMErrorDetails` variant.
 */
export interface NativeErrorPayload {
  /** An `LLMErrorCode`. Anything unrecognised is treated as `unknown`. */
  readonly code: string;
  readonly message: string;
  /** `unavailable` only. */
  readonly reason?: string;
  /** `contextOverflow` only. */
  readonly contextSize?: number;
  /** `contextOverflow` only. */
  readonly tokenCount?: number;
  /** `unsupportedLocale` only. */
  readonly locale?: string;
  /** `rateLimited` only — milliseconds since the epoch. */
  readonly resetDate?: number;
  /** `unknown` only — the D9 router hint. */
  readonly transient?: boolean;
  /** Diagnostics for the untyped-`NSError` branch (D9). */
  readonly nativeDomain?: string;
  readonly nativeCode?: number;
  readonly nativeDetail?: string;
}

/** What `generate` resolves to. */
export type NativeGenerateOutcome =
  | { readonly ok: true; readonly result: NativeResult }
  | { readonly ok: false; readonly error: NativeErrorPayload };

/** One `onStreamEvent` payload. Exactly one terminal event per request. */
export type NativeStreamEvent =
  | {
      readonly requestId: string;
      readonly type: 'delta';
      readonly delta: string;
      /** The DECISIONS.md D18 snapshot-diff fallback fired for this delta. */
      readonly reset: boolean;
    }
  | { readonly requestId: string; readonly type: 'finish'; readonly result: NativeResult }
  | { readonly requestId: string; readonly type: 'error'; readonly error: NativeErrorPayload };

/** What Expo's `addListener` hands back. */
export interface NativeSubscription {
  remove(): void;
}

/** The Swift module's exported surface. */
export interface AppleNativeModule {
  availability(): Promise<NativeAvailability>;
  capabilities(): Promise<NativeCapabilities>;
  /** `SystemLanguageModel.supportsLocale`, the exact check behind the D7 pre-check. */
  supportsLocale(tag: string): Promise<boolean>;
  generate(
    requestId: string,
    messages: readonly { readonly role: string; readonly content: string }[],
    temperature: number | null,
    maxOutputTokens: number | null
  ): Promise<NativeGenerateOutcome>;
  /**
   * Starts a stream and resolves as soon as it is registered — *not* when
   * generation finishes. Results, errors and cancellation all arrive as
   * `onStreamEvent` events.
   */
  startStream(
    requestId: string,
    messages: readonly { readonly role: string; readonly content: string }[],
    temperature: number | null,
    maxOutputTokens: number | null
  ): Promise<void>;
  /** Cancels the Swift `Task`. Resolves `false` when the id is already gone. */
  cancel(requestId: string): Promise<boolean>;
  addListener(
    eventName: 'onStreamEvent',
    listener: (event: NativeStreamEvent) => void
  ): NativeSubscription;
}
