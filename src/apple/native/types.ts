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
  /**
   * Structured output as JSON text (`GeneratedContent.jsonString`), present iff
   * the request carried a schema. Crossing the bridge as text rather than as a
   * dictionary keeps `null`s and number types intact — and means `JSON.parse`
   * is the only JSON reader involved on this side.
   */
  readonly objectJson?: string;
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
  /**
   * The text the model produced, for structured output that failed to parse
   * (`GeneratedContent.ParsingError.rawContent`). The only evidence of what
   * went wrong, so it is never dropped.
   */
  readonly rawContent?: string;
}

/**
 * A tool as the bridge takes it: flat strings, like `messages`. The parameter
 * schema travels as JSON text because it is already a document — encoding it
 * into a native dictionary and back would only give both sides a chance to
 * disagree about numbers.
 */
export interface NativeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parametersJson: string;
}

/** What `generate` resolves to. */
export type NativeGenerateOutcome =
  | { readonly ok: true; readonly result: NativeResult }
  | { readonly ok: false; readonly error: NativeErrorPayload };

/** What `countTokens` resolves to. */
export type NativeCountTokensOutcome =
  | { readonly ok: true; readonly count: number }
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
  | {
      readonly requestId: string;
      readonly type: 'objectSnapshot';
      /** Partially generated structured output as JSON text; may not parse yet. */
      readonly snapshotJson: string;
    }
  | {
      readonly requestId: string;
      readonly type: 'toolCall';
      /** Unique per call. Answer with `resolveToolCall(callId, …)`. */
      readonly callId: string;
      readonly toolName: string;
      /** Arguments as JSON text, from `GeneratedContent.jsonString`. */
      readonly argumentsJson: string;
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
    maxOutputTokens: number | null,
    schemaJson: string | null
  ): Promise<NativeGenerateOutcome>;
  /**
   * Starts a stream and resolves as soon as it is registered — *not* when
   * generation finishes. Results, errors, tool calls and cancellation all
   * arrive as `onStreamEvent` events.
   */
  startStream(
    requestId: string,
    messages: readonly { readonly role: string; readonly content: string }[],
    temperature: number | null,
    maxOutputTokens: number | null,
    schemaJson: string | null,
    tools: readonly NativeToolDefinition[],
    toolCallTimeoutMs: number | null
  ): Promise<void>;
  /**
   * Cancels the Swift `Task` *and* resumes any tool call suspended for this
   * request. Resolves `false` when the id is already gone.
   */
  cancel(requestId: string): Promise<boolean>;
  /**
   * Answer a `toolCall` event. Exactly one of `resultJson`/`errorMessage`.
   *
   * Resolves `false` when the call was no longer waiting — it timed out, the
   * request was cancelled, or it was already answered. That is a normal race
   * (JavaScript cannot know the native timer fired), so it is a return value
   * rather than a rejection, and callers ignore it.
   *
   * Optional on the type so a JS half newer than the native half degrades to
   * "tools unsupported" instead of throwing `undefined is not a function`.
   */
  resolveToolCall?(
    callId: string,
    resultJson: string | null,
    errorMessage: string | null
  ): Promise<boolean>;
  /** Hint that a request is coming. Resolves `false` if the hint could not be delivered. */
  prewarm?(
    messages: readonly { readonly role: string; readonly content: string }[] | null
  ): Promise<boolean>;
  /** Exact token count for these messages, via `SystemLanguageModel.tokenCount(for:)`. */
  countTokens?(
    messages: readonly { readonly role: string; readonly content: string }[]
  ): Promise<NativeCountTokensOutcome>;
  addListener(
    eventName: 'onStreamEvent',
    listener: (event: NativeStreamEvent) => void
  ): NativeSubscription;
}
