/**
 * A scriptable stand-in for the Swift module.
 *
 * The provider takes its native resolver by injection (`new AppleProvider(config, resolver)`)
 * rather than reaching for a module-mocking framework, so these tests exercise
 * the real code path — including the `requestId` demultiplexing and the
 * cancellation calls, which a `vi.mock` of the module would hide behind a
 * stub.
 */

import type {
  AppleNativeModule,
  NativeAvailability,
  NativeCapabilities,
  NativeCountTokensOutcome,
  NativeGenerateOutcome,
  NativeStreamEvent,
  NativeSubscription,
  NativeToolDefinition,
} from '../native/types';

export class FakeNativeModule implements AppleNativeModule {
  availabilityResult: NativeAvailability = { available: true };
  capabilitiesResult: NativeCapabilities = {
    contextWindow: 8192,
    locales: ['en', 'nl', 'fr', 'de', 'es'],
    modelLabel: 'AFM 3 Core Advanced',
    supportsVision: true,
    supportsGuidedGeneration: true,
    supportsToolCalling: true,
    supportsReasoning: false,
  };
  supportedLocales = new Set(['en', 'nl', 'nl-NL', 'fr', 'de', 'es']);
  generateResult: NativeGenerateOutcome = {
    ok: true,
    result: { text: 'hello', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 2 } },
  };

  /** Throw from a given method instead of resolving. */
  throwFrom: Partial<Record<'availability' | 'capabilities' | 'supportsLocale', Error>> = {};

  countTokensResult: NativeCountTokensOutcome = { ok: true, count: 42 };

  readonly calls: {
    generate: unknown[][];
    startStream: unknown[][];
    cancel: string[];
    prewarm: unknown[];
    countTokens: unknown[];
    resolveToolCall: { callId: string; resultJson: string | null; errorMessage: string | null }[];
  } = {
    generate: [],
    startStream: [],
    cancel: [],
    prewarm: [],
    countTokens: [],
    resolveToolCall: [],
  };

  /**
   * Call ids this fake still considers open. `resolveToolCall` answers `false`
   * for anything else, which is how the real registry reports a call that timed
   * out, was cancelled, or was already answered.
   */
  readonly openToolCalls = new Set<string>();

  /** Resolves when `startStream` has been called. */
  startStreamCalled: Promise<void>;
  private resolveStartStreamCalled!: () => void;

  private listeners = new Set<(event: NativeStreamEvent) => void>();

  constructor() {
    this.startStreamCalled = new Promise<void>((resolve) => {
      this.resolveStartStreamCalled = resolve;
    });
  }

  /** Number of listeners currently attached — proves `remove()` is called. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  async availability(): Promise<NativeAvailability> {
    if (this.throwFrom.availability) throw this.throwFrom.availability;
    return this.availabilityResult;
  }

  async capabilities(): Promise<NativeCapabilities> {
    if (this.throwFrom.capabilities) throw this.throwFrom.capabilities;
    return this.capabilitiesResult;
  }

  async supportsLocale(tag: string): Promise<boolean> {
    if (this.throwFrom.supportsLocale) throw this.throwFrom.supportsLocale;
    return this.supportedLocales.has(tag);
  }

  async generate(
    requestId: string,
    messages: readonly { readonly role: string; readonly content: string }[],
    temperature: number | null,
    maxOutputTokens: number | null,
    schemaJson: string | null
  ): Promise<NativeGenerateOutcome> {
    this.calls.generate.push([requestId, messages, temperature, maxOutputTokens, schemaJson]);
    return this.generateResult;
  }

  async startStream(
    requestId: string,
    messages: readonly { readonly role: string; readonly content: string }[],
    temperature: number | null,
    maxOutputTokens: number | null,
    schemaJson: string | null,
    tools: readonly NativeToolDefinition[],
    toolCallTimeoutMs: number | null
  ): Promise<void> {
    this.calls.startStream.push([
      requestId,
      messages,
      temperature,
      maxOutputTokens,
      schemaJson,
      tools,
      toolCallTimeoutMs,
    ]);
    this.resolveStartStreamCalled();
  }

  async cancel(requestId: string): Promise<boolean> {
    this.calls.cancel.push(requestId);
    // The real bridge resumes every suspended tool call for the request, after
    // which a reply is too late.
    this.openToolCalls.clear();
    return true;
  }

  async prewarm(
    messages: readonly { readonly role: string; readonly content: string }[] | null
  ): Promise<boolean> {
    this.calls.prewarm.push(messages);
    return true;
  }

  async countTokens(
    messages: readonly { readonly role: string; readonly content: string }[]
  ): Promise<NativeCountTokensOutcome> {
    this.calls.countTokens.push(messages);
    return this.countTokensResult;
  }

  async resolveToolCall(
    callId: string,
    resultJson: string | null,
    errorMessage: string | null
  ): Promise<boolean> {
    this.calls.resolveToolCall.push({ callId, resultJson, errorMessage });
    return this.openToolCalls.delete(callId);
  }

  /**
   * Emit a `toolCall` event the way native does, and remember the call as open
   * so exactly one reply to it counts.
   */
  emitToolCall(options: {
    requestId?: string;
    callId: string;
    toolName: string;
    argumentsJson: string;
  }): void {
    this.openToolCalls.add(options.callId);
    this.emit({
      requestId: options.requestId ?? this.lastStreamRequestId,
      type: 'toolCall',
      callId: options.callId,
      toolName: options.toolName,
      argumentsJson: options.argumentsJson,
    });
  }

  addListener(
    _eventName: 'onStreamEvent',
    listener: (event: NativeStreamEvent) => void
  ): NativeSubscription {
    this.listeners.add(listener);
    return {
      remove: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Push an event as the native side would. */
  emit(event: NativeStreamEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** The id of the most recent `startStream` call. */
  get lastStreamRequestId(): string {
    const last = this.calls.startStream[this.calls.startStream.length - 1];
    return last?.[0] as string;
  }
}
