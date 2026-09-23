import { describe, expect, it } from 'vitest';

import {
  LLMError,
  MockProvider,
  estimateTokens,
  isLLMError,
  type GenerateRequest,
  type LLMProvider,
  type Message,
  type StreamEvent,
} from '../index';

const messages: readonly Message[] = [
  { role: 'system', content: 'You are terse.', pinned: true },
  { role: 'user', content: 'Hallo' },
];

const request: GenerateRequest = { messages };

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('MockProvider: shape', () => {
  it('satisfies LLMProvider and defaults its id', () => {
    const provider: LLMProvider = new MockProvider();
    expect(provider.id).toBe('mock');
    expect(new MockProvider({ id: 'cloud' }).id).toBe('cloud');
  });

  it('reports configurable availability and capabilities', async () => {
    const defaults = new MockProvider();
    await expect(defaults.availability()).resolves.toEqual({ available: true });
    await expect(defaults.capabilities()).resolves.toMatchObject({
      contextWindow: 4096,
      streaming: true,
      structuredOutput: true,
      tools: false,
      tokenCounting: 'none',
      locales: 'unknown',
    });

    const offline = new MockProvider({
      availability: { available: false, reason: 'unsupportedPlatform', detail: 'android' },
      capabilities: { contextWindow: 'unknown', locales: ['nl-NL', 'fr-FR'], streaming: false },
    });
    await expect(offline.availability()).resolves.toEqual({
      available: false,
      reason: 'unsupportedPlatform',
      detail: 'android',
    });
    const capabilities = await offline.capabilities();
    expect(capabilities.contextWindow).toBe('unknown');
    expect(capabilities.locales).toEqual(['nl-NL', 'fr-FR']);
    expect(capabilities.streaming).toBe(false);
  });
});

describe('MockProvider: countTokens', () => {
  it('has no countTokens method unless configured', () => {
    expect(new MockProvider().countTokens).toBeUndefined();
  });

  it('returns a constant, a computed value, or throws', async () => {
    const constant = new MockProvider({ countTokens: 42 });
    expect(constant.countTokens).toBeTypeOf('function');
    await expect(constant.countTokens?.(messages)).resolves.toBe(42);
    await expect(constant.capabilities()).resolves.toMatchObject({ tokenCounting: 'exact' });

    const computed = new MockProvider({ countTokens: (msgs) => estimateTokens(msgs) });
    await expect(computed.countTokens?.(messages)).resolves.toBe(estimateTokens(messages));

    const broken = new MockProvider({
      countTokens: new LLMError({ code: 'unknown', transient: true }),
    });
    await expect(broken.countTokens?.(messages)).rejects.toSatisfy((err: unknown) =>
      isLLMError(err, 'unknown')
    );
  });

  it('records countTokens calls', async () => {
    const provider = new MockProvider({ countTokens: 7 });
    await provider.countTokens?.(messages);
    expect(provider.calls).toEqual([{ method: 'countTokens', messages }]);
  });
});

describe('MockProvider: generate', () => {
  it('returns the scripted result, defaulting text and finishReason', async () => {
    const provider = new MockProvider({
      turns: [
        { type: 'result', text: 'Hoi', usage: { inputTokens: 11, outputTokens: 2 } },
        { type: 'result' },
      ],
    });

    await expect(provider.generate(request)).resolves.toEqual({
      text: 'Hoi',
      finishReason: 'stop',
      usage: { inputTokens: 11, outputTokens: 2 },
      providerId: 'mock',
    });
    await expect(provider.generate(request)).resolves.toEqual({
      text: '',
      finishReason: 'stop',
      providerId: 'mock',
    });
  });

  it('returns structured output and non-default finish reasons', async () => {
    const provider = new MockProvider({
      turns: [{ type: 'result', object: { level: 'A2' }, finishReason: 'length' }],
    });
    const result = await provider.generate({
      messages,
      schema: { type: 'object', title: 'Level' },
    });
    expect(result.object).toEqual({ level: 'A2' });
    expect(result.finishReason).toBe('length');
  });

  it('throws the scripted error verbatim', async () => {
    const error = new LLMError({ code: 'contextOverflow', contextSize: 4096, tokenCount: 5200 });
    const provider = new MockProvider({ turns: [{ type: 'error', error }] });
    await expect(provider.generate(request)).rejects.toBe(error);
  });

  it('plays a stream turn to completion, concatenating the chunks', async () => {
    const provider = new MockProvider({
      turns: [{ type: 'stream', chunks: ['Hal', 'lo ', 'daar'], finishReason: 'stop' }],
    });
    await expect(provider.generate(request)).resolves.toMatchObject({ text: 'Hallo daar' });
  });

  it('propagates a stream turn mid-flight error', async () => {
    const error = new LLMError({ code: 'guardrail' }, { providerId: 'mock' });
    const provider = new MockProvider({ turns: [{ type: 'stream', chunks: ['Hal'], error }] });
    await expect(provider.generate(request)).rejects.toBe(error);
  });

  it('throws invalidRequest once the script runs out', async () => {
    const provider = new MockProvider({ turns: [{ type: 'result', text: 'one' }] });
    await provider.generate(request);
    expect(provider.remainingTurns).toBe(0);
    await expect(provider.generate(request)).rejects.toSatisfy((err: unknown) => {
      return isLLMError(err, 'invalidRequest') && /no scripted turns left/.test(err.message);
    });
  });
});

describe('MockProvider: stream', () => {
  it('emits deltas in order, then exactly one finish carrying the full result', async () => {
    const provider = new MockProvider({
      turns: [
        {
          type: 'stream',
          chunks: ['Hal', 'lo'],
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      ],
    });

    const events = await collect(provider.stream(request));
    expect(events).toEqual([
      { type: 'textDelta', delta: 'Hal' },
      { type: 'textDelta', delta: 'lo' },
      {
        type: 'finish',
        result: {
          text: 'Hallo',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 2 },
          providerId: 'mock',
        },
      },
    ]);
    // Deltas, not snapshots (DECISIONS.md D5).
    expect(events.filter((event) => event.type === 'finish')).toHaveLength(1);
  });

  it('streams a result turn as one delta plus finish', async () => {
    const provider = new MockProvider({ turns: [{ type: 'result', text: 'Hoi' }] });
    expect(await collect(provider.stream(request))).toEqual([
      { type: 'textDelta', delta: 'Hoi' },
      { type: 'finish', result: { text: 'Hoi', finishReason: 'stop', providerId: 'mock' } },
    ]);
  });

  it('emits an object snapshot before finish when structured output is scripted', async () => {
    const provider = new MockProvider({
      turns: [{ type: 'stream', chunks: ['{'], object: { level: 'B1' } }],
    });
    const events = await collect(provider.stream(request));
    expect(events.map((event) => event.type)).toEqual(['textDelta', 'objectSnapshot', 'finish']);
    expect(events[1]).toEqual({ type: 'objectSnapshot', snapshot: { level: 'B1' } });
  });

  it('honours per-chunk delays', async () => {
    const provider = new MockProvider({
      turns: [{ type: 'stream', chunks: ['a', { text: 'b', delayMs: 15 }] }],
    });
    const started = Date.now();
    const events = await collect(provider.stream(request));
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(events).toHaveLength(3);
  });

  it('surfaces a scripted mid-stream error after the chunks it scripted', async () => {
    const error = new LLMError({ code: 'unknown', transient: true }, { providerId: 'mock' });
    const provider = new MockProvider({
      turns: [{ type: 'stream', chunks: ['partial '], error }],
    });

    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of provider.stream(request)) seen.push(event);
      })()
    ).rejects.toBe(error);
    expect(seen).toEqual([{ type: 'textDelta', delta: 'partial ' }]);
  });

  it('reports script exhaustion on iteration, not synchronously', async () => {
    const provider = new MockProvider();
    const events = provider.stream(request); // does not throw
    await expect(collect(events)).rejects.toSatisfy((err: unknown) =>
      isLLMError(err, 'invalidRequest')
    );
  });
});

describe('MockProvider: cancellation', () => {
  it('rejects generate immediately when the signal is already aborted', async () => {
    const provider = new MockProvider({ turns: [{ type: 'result', text: 'never' }] });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.generate(request, { signal: controller.signal })).rejects.toSatisfy(
      (err: unknown) => isLLMError(err, 'cancelled')
    );
    // The call is still recorded, and the turn is left untouched for the retry.
    expect(provider.calls).toHaveLength(1);
    expect(provider.remainingTurns).toBe(1);
  });

  it('rejects generate when the signal fires during a scripted delay', async () => {
    const provider = new MockProvider({ turns: [{ type: 'result', text: 'slow', delayMs: 500 }] });
    const controller = new AbortController();
    const pending = provider.generate(request, { signal: controller.signal });
    controller.abort();
    const started = Date.now();
    await expect(pending).rejects.toSatisfy((err: unknown) => isLLMError(err, 'cancelled'));
    // Aborted promptly rather than after the scripted 500ms.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('rejects a stream before the first event when already aborted', async () => {
    const provider = new MockProvider({ turns: [{ type: 'stream', chunks: ['a'] }] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(provider.stream(request, { signal: controller.signal }))
    ).rejects.toSatisfy((err: unknown) => isLLMError(err, 'cancelled'));
  });

  it('throws cancelled when aborted between chunks', async () => {
    const provider = new MockProvider({
      turns: [{ type: 'stream', chunks: ['first', 'second', 'third'] }],
    });
    const controller = new AbortController();
    const iterator = provider
      .stream(request, { signal: controller.signal })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'textDelta', delta: 'first' },
    });
    controller.abort();
    await expect(iterator.next()).rejects.toSatisfy((err: unknown) => isLLMError(err, 'cancelled'));
  });

  it('throws cancelled when aborted during a mid-stream delay, and records the signal', async () => {
    const provider = new MockProvider({
      turns: [{ type: 'stream', chunks: ['first', { text: 'second', delayMs: 500 }] }],
    });
    const controller = new AbortController();
    const events: StreamEvent[] = [];

    const pending = (async () => {
      for await (const event of provider.stream(request, { signal: controller.signal })) {
        events.push(event);
        controller.abort(new Error('user tapped stop'));
      }
    })();

    await expect(pending).rejects.toSatisfy((err: unknown) => {
      return isLLMError(err, 'cancelled') && err.cause instanceof Error;
    });
    expect(events).toEqual([{ type: 'textDelta', delta: 'first' }]);
    expect(provider.calls[0]?.signal).toBe(controller.signal);
  });
});

describe('MockProvider: recording', () => {
  it('records every request in order, across generate and stream', async () => {
    const provider = new MockProvider({
      turns: [
        { type: 'result', text: 'one' },
        { type: 'stream', chunks: ['two'] },
      ],
    });
    const first: GenerateRequest = { messages, temperature: 0.2, maxOutputTokens: 64 };
    const second: GenerateRequest = { messages, schema: { type: 'object', title: 'Answer' } };

    await provider.generate(first);
    await collect(provider.stream(second));

    expect(provider.requests).toEqual([first, second]);
    expect(provider.calls.map((call) => call.method)).toEqual(['generate', 'stream']);
    // Recorded by reference: assertions can inspect the exact messages the
    // context manager produced, including the pinned flag.
    expect(provider.requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: 'You are terse.',
      pinned: true,
    });
  });

  it('appends turns with script() and clears state with reset()', async () => {
    const provider = new MockProvider();
    provider.script({ type: 'result', text: 'a' }, { type: 'result', text: 'b' });
    expect(provider.remainingTurns).toBe(2);

    await provider.generate(request);
    expect(provider.calls).toHaveLength(1);

    provider.reset();
    expect(provider.calls).toHaveLength(0);
    expect(provider.remainingTurns).toBe(0);
  });
});
