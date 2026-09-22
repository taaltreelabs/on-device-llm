/**
 * The JavaScript half of the tool protocol (DECISIONS.md D24), over the fake
 * native module.
 *
 * The native half — continuations, the timeout, cancellation cleanup — is
 * verified against the real model in `harness/Sources/Runner/ToolChecks.swift`.
 * What is checked here is everything that happens on this side of the bridge:
 * which handler runs, what it is passed, what goes back through
 * `resolveToolCall`, and what the iterator does when any of it goes wrong.
 *
 * Every wait in this file has a deadline. A tool protocol is exactly the kind of
 * code that hangs when it is wrong, and a test that hangs tells you nothing.
 */
import { describe, expect, it } from 'vitest';

import { isLLMError, type GenerateRequest, type StreamEvent, type ToolCall } from '../../core';
import { AppleProvider } from '../provider';
import { FakeNativeModule } from './fake-native';

/** Poll `condition` until it holds, or fail after `timeoutMs`. */
async function until(condition: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Reject rather than hang if a promise never settles. */
async function withDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const weatherParameters = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
} as const;

function weatherRequest(
  execute: GenerateRequest['tools'] extends readonly (infer T)[] | undefined
    ? T extends { execute?: infer E }
      ? E
      : never
    : never
): GenerateRequest {
  return {
    messages: [{ role: 'user', content: 'What is the weather in Utrecht?' }],
    tools: [
      {
        name: 'getWeather',
        description: 'Current weather for a city.',
        parameters: weatherParameters,
        execute,
      },
    ],
  };
}

function finishEvent(native: FakeNativeModule, text = 'It is sunny.'): void {
  native.emit({
    requestId: native.lastStreamRequestId,
    type: 'finish',
    result: { text, finishReason: 'stop' },
  });
}

describe('tool calling over the bridge', () => {
  it('round-trips a call: event out, handler runs, result back, generation finishes', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const seen: ToolCall[] = [];

    const stream = provider.stream(
      weatherRequest((call) => {
        seen.push(call);
        return { tempC: 21, summary: 'sunny' };
      })
    );
    const iterator = stream[Symbol.asyncIterator]();

    const firstEvent = iterator.next();
    await withDeadline(native.startStreamCalled, 'startStream');

    // The tool declaration crossed the bridge in the documented shape.
    const [, , , , schemaJson, tools, timeout] = native.calls.startStream[0]!;
    expect(schemaJson).toBeNull();
    expect(timeout).toBe(30_000);
    const declared = tools as { name: string; description: string; parametersJson: string }[];
    expect(declared[0]?.name).toBe('getWeather');
    expect(JSON.parse(declared[0]!.parametersJson)).toMatchObject({
      type: 'object',
      title: 'getWeatherArguments',
      'x-order': ['city'],
      additionalProperties: false,
    });

    native.emitToolCall({
      callId: 'call-1',
      toolName: 'getWeather',
      argumentsJson: '{"city":"Utrecht"}',
    });

    const event = (await withDeadline(firstEvent, 'toolCall event')).value as StreamEvent;
    expect(event).toEqual({
      type: 'toolCall',
      callId: 'call-1',
      toolName: 'getWeather',
      arguments: { city: 'Utrecht' },
    });

    await until(() => native.calls.resolveToolCall.length === 1, 'the reply to native');
    expect(native.calls.resolveToolCall[0]).toEqual({
      callId: 'call-1',
      // A non-string result is JSON-stringified for the model.
      resultJson: '{"tempC":21,"summary":"sunny"}',
      errorMessage: null,
    });
    expect(seen[0]?.arguments).toEqual({ city: 'Utrecht' });
    expect(seen[0]?.signal.aborted).toBe(false);

    finishEvent(native);
    const last = await withDeadline(iterator.next(), 'finish event');
    expect((last.value as StreamEvent & { type: 'finish' }).result.text).toBe('It is sunny.');
    // Handlers are told the request is over, so long-running work can stop.
    expect(seen[0]?.signal.aborted).toBe(true);
  });

  it('passes a string result through unchanged', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const iterator = provider.stream(weatherRequest(() => 'sunny'))[Symbol.asyncIterator]();
    const first = iterator.next();
    await withDeadline(native.startStreamCalled, 'startStream');
    native.emitToolCall({ callId: 'c', toolName: 'getWeather', argumentsJson: '{"city":"A"}' });
    await withDeadline(first, 'toolCall event');
    await until(() => native.calls.resolveToolCall.length === 1, 'the reply');
    expect(native.calls.resolveToolCall[0]?.resultJson).toBe('sunny');
    finishEvent(native);
    await withDeadline(iterator.next(), 'finish');
  });

  it('reports a handler exception to native and fails the request, keeping the cause', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const handlerError = new Error('the weather service is down');

    const iterator = provider
      .stream(
        weatherRequest(() => {
          throw handlerError;
        })
      )
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await withDeadline(native.startStreamCalled, 'startStream');
    native.emitToolCall({ callId: 'c1', toolName: 'getWeather', argumentsJson: '{"city":"A"}' });
    await withDeadline(first, 'toolCall event');

    await until(() => native.calls.resolveToolCall.length === 1, 'the failure reply');
    expect(native.calls.resolveToolCall[0]).toEqual({
      callId: 'c1',
      resultJson: null,
      errorMessage: 'the weather service is down',
    });

    // Native answers by failing the request, the way the framework's
    // ToolCallError does.
    native.emit({
      requestId: native.lastStreamRequestId,
      type: 'error',
      error: {
        code: 'unknown',
        message: 'Tool "getWeather" failed: the handler failed',
        transient: false,
        nativeDomain: 'OnDeviceLlm.ToolCall',
      },
    });

    const failure = await withDeadline(
      iterator.next().then(
        () => undefined,
        (error: unknown) => error
      ),
      'the request failure'
    );
    expect(isLLMError(failure, 'unknown')).toBe(true);
    // The handler's own error is what a developer needs; the native
    // diagnostics ride alongside it.
    const cause = (failure as Error).cause as {
      toolName: string;
      callId: string;
      handlerError: unknown;
      native: unknown;
    };
    expect(cause.toolName).toBe('getWeather');
    expect(cause.callId).toBe('c1');
    expect(cause.handlerError).toBe(handlerError);
    expect(cause.native).toMatchObject({ nativeDomain: 'OnDeviceLlm.ToolCall' });
  });

  it('surfaces a native tool-call timeout as a transient failure', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({ toolCallTimeoutMs: 50 }, () => native);
    const never = deferred<string>();

    const iterator = provider
      .stream(weatherRequest(() => never.promise))
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await withDeadline(native.startStreamCalled, 'startStream');
    expect(native.calls.startStream[0]![6]).toBe(50);

    native.emitToolCall({ callId: 'slow', toolName: 'getWeather', argumentsJson: '{"city":"A"}' });
    await withDeadline(first, 'toolCall event');

    // The native timer fires and abandons the request. Nothing on this side has
    // to know in advance.
    native.openToolCalls.delete('slow');
    native.emit({
      requestId: native.lastStreamRequestId,
      type: 'error',
      error: {
        code: 'unknown',
        message: 'The tool "getWeather" did not answer within 50ms; the request was abandoned.',
        transient: true,
        nativeDomain: 'OnDeviceLlm.ToolCall',
      },
    });

    const failure = await withDeadline(
      iterator.next().then(
        () => undefined,
        (error: unknown) => error
      ),
      'the timeout failure'
    );
    expect(isLLMError(failure, 'unknown')).toBe(true);
    expect((failure as { details: { transient?: boolean } }).details.transient).toBe(true);
    expect((failure as Error).message).toMatch(/did not answer within 50ms/);

    // A late reply from the handler is a no-op, not a crash.
    never.resolve('too late');
    await until(() => native.calls.resolveToolCall.length === 1, 'the late reply');
    expect(native.calls.resolveToolCall[0]?.callId).toBe('slow');
  });

  it('cancels a request while a tool call is in flight, then ignores the late reply', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const controller = new AbortController();
    const pending = deferred<string>();
    let handlerSignal: AbortSignal | undefined;

    const iterator = provider
      .stream(
        weatherRequest((call) => {
          handlerSignal = call.signal;
          return pending.promise;
        }),
        { signal: controller.signal }
      )
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await withDeadline(native.startStreamCalled, 'startStream');
    native.emitToolCall({ callId: 'c', toolName: 'getWeather', argumentsJson: '{"city":"A"}' });
    await withDeadline(first, 'toolCall event');

    controller.abort();
    await until(() => native.calls.cancel.length === 1, 'native cancel');
    // The native side resumes the suspended call and reports the request as
    // cancelled.
    native.emit({
      requestId: native.lastStreamRequestId,
      type: 'error',
      error: { code: 'cancelled', message: 'The request was cancelled' },
    });

    const failure = await withDeadline(
      iterator.next().then(
        () => undefined,
        (error: unknown) => error
      ),
      'the cancellation'
    );
    expect(isLLMError(failure, 'cancelled')).toBe(true);
    expect(handlerSignal?.aborted).toBe(true);

    pending.resolve('too late');
    await until(() => native.calls.resolveToolCall.length === 1, 'the late reply');
    // The fake cleared its open calls on cancel, so the reply is refused —
    // which is exactly what the native registry does, and it must not throw.
    await expect(
      native.resolveToolCall('c', 'too late', null)
    ).resolves.toBe(false);
  });

  it('runs two concurrent calls independently, keyed by callId', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();

    const request: GenerateRequest = {
      messages: [{ role: 'user', content: 'Compare Utrecht and Delft.' }],
      tools: [
        {
          name: 'getWeather',
          description: 'Current weather for a city.',
          parameters: weatherParameters,
          execute: (call) => {
            const gate = deferred<string>();
            gates.set(call.callId, gate);
            return gate.promise;
          },
        },
      ],
    };

    const iterator = provider.stream(request)[Symbol.asyncIterator]();
    const first = iterator.next();
    await withDeadline(native.startStreamCalled, 'startStream');

    native.emitToolCall({ callId: 'a', toolName: 'getWeather', argumentsJson: '{"city":"Utrecht"}' });
    native.emitToolCall({ callId: 'b', toolName: 'getWeather', argumentsJson: '{"city":"Delft"}' });
    await withDeadline(first, 'first toolCall event');
    const second = await withDeadline(iterator.next(), 'second toolCall event');
    expect((second.value as StreamEvent & { type: 'toolCall' }).callId).toBe('b');

    // Both handlers are running at once: the second call is not queued behind
    // the first, which is what a single-slot registry would do.
    await until(() => gates.size === 2, 'both handlers to start');
    // Answer out of order.
    gates.get('b')!.resolve('Delft: rain');
    gates.get('a')!.resolve('Utrecht: sun');

    await until(() => native.calls.resolveToolCall.length === 2, 'both replies');
    expect(native.calls.resolveToolCall).toEqual([
      { callId: 'b', resultJson: 'Delft: rain', errorMessage: null },
      { callId: 'a', resultJson: 'Utrecht: sun', errorMessage: null },
    ]);

    finishEvent(native, 'Utrecht is sunny, Delft is wet.');
    await withDeadline(iterator.next(), 'finish');
  });

  it('uses options.onToolCall for a tool with no execute of its own', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const calls: string[] = [];

    const iterator = provider
      .stream(
        {
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [
            { name: 'getWeather', description: 'weather', parameters: weatherParameters },
          ],
        },
        {
          onToolCall: (call) => {
            calls.push(call.toolName);
            return 'sunny';
          },
        }
      )
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await withDeadline(native.startStreamCalled, 'startStream');
    native.emitToolCall({ callId: 'c', toolName: 'getWeather', argumentsJson: '{"city":"A"}' });
    await withDeadline(first, 'toolCall event');
    await until(() => native.calls.resolveToolCall.length === 1, 'the reply');
    expect(calls).toEqual(['getWeather']);
    finishEvent(native);
    await withDeadline(iterator.next(), 'finish');
  });

  it('rejects a tool with no handler before anything starts', () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    expect(() =>
      provider.stream({
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'getWeather', description: 'weather', parameters: weatherParameters }],
      })
    ).toThrowError(/no `execute` handler/);
    expect(native.calls.startStream).toHaveLength(0);
  });

  it('rejects duplicate tool names', () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const tool = {
      name: 'getWeather',
      description: 'weather',
      parameters: weatherParameters,
      execute: () => 'x',
    };
    expect(() =>
      provider.stream({ messages: [{ role: 'user', content: 'x' }], tools: [tool, tool] })
    ).toThrowError(/Two tools are named "getWeather"/);
  });

  it('rejects tools when the native module cannot run them', () => {
    const native = new FakeNativeModule();
    // A native half older than this JavaScript: the protocol is not there.
    (native as { resolveToolCall?: unknown }).resolveToolCall = undefined;
    const provider = new AppleProvider({}, () => native);
    expect(() => provider.stream(weatherRequest(() => 'x'))).toThrowError(/cannot run tools/);
  });

  it('generate() with tools folds the stream into a result', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const result = provider.generate(weatherRequest(() => 'sunny'));

    await withDeadline(native.startStreamCalled, 'startStream');
    native.emitToolCall({ callId: 'c', toolName: 'getWeather', argumentsJson: '{"city":"A"}' });
    await until(() => native.calls.resolveToolCall.length === 1, 'the reply');
    finishEvent(native, 'It is sunny in Utrecht.');

    await expect(withDeadline(result, 'generate')).resolves.toMatchObject({
      text: 'It is sunny in Utrecht.',
      finishReason: 'stop',
      providerId: 'apple',
    });
    // `generate` never touches the non-streaming bridge call for a tool request.
    expect(native.calls.generate).toHaveLength(0);
  });
});
