/**
 * Phase 3 steps 4-6 on the TypeScript side: prewarming, token counting (and
 * the context manager's behaviour when it fails), and structured output.
 */
import { describe, expect, it } from 'vitest';

import { createMeasure, isLLMError, type GenerateRequest, type StreamEvent } from '../../core';
import { AppleProvider } from '../provider';
import { FakeNativeModule } from './fake-native';

const schemaRequest: GenerateRequest = {
  messages: [{ role: 'user', content: 'Invent a person.' }],
  schema: {
    type: 'object',
    title: 'Person',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer', minimum: 0, maximum: 120 },
    },
    required: ['name', 'age'],
  },
};

describe('capabilities', () => {
  it('reports what the model and the native half can actually do', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    await expect(provider.capabilities()).resolves.toMatchObject({
      contextWindow: 8192,
      streaming: true,
      structuredOutput: true,
      tools: true,
      tokenCounting: 'exact',
    });
  });

  it('does not advertise a protocol the native half cannot speak', async () => {
    const native = new FakeNativeModule();
    (native as { resolveToolCall?: unknown }).resolveToolCall = undefined;
    (native as { countTokens?: unknown }).countTokens = undefined;
    const provider = new AppleProvider({}, () => native);
    await expect(provider.capabilities()).resolves.toMatchObject({
      tools: false,
      tokenCounting: 'none',
    });
  });

  it('follows the model when it reports a capability as absent', async () => {
    const native = new FakeNativeModule();
    native.capabilitiesResult = {
      ...native.capabilitiesResult,
      supportsGuidedGeneration: false,
      supportsToolCalling: false,
    };
    const provider = new AppleProvider({}, () => native);
    await expect(provider.capabilities()).resolves.toMatchObject({
      structuredOutput: false,
      tools: false,
    });
  });
});

describe('prewarm', () => {
  it('passes the conversation through and resolves true', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    await expect(provider.prewarm([{ role: 'user', content: 'Hello' }])).resolves.toBe(true);
    expect(native.calls.prewarm[0]).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('sends null when there is no conversation yet', async () => {
    const native = new FakeNativeModule();
    await expect(new AppleProvider({}, () => native).prewarm()).resolves.toBe(true);
    expect(native.calls.prewarm[0]).toBeNull();
  });

  it('is a no-op that resolves false off-platform, or when the native half is older', async () => {
    await expect(new AppleProvider({}, () => undefined).prewarm()).resolves.toBe(false);
    const native = new FakeNativeModule();
    (native as { prewarm?: unknown }).prewarm = undefined;
    await expect(new AppleProvider({}, () => native).prewarm()).resolves.toBe(false);
  });

  it('never throws, even when the bridge call fails', async () => {
    const native = new FakeNativeModule();
    native.prewarm = async () => {
      throw new Error('bridge is gone');
    };
    await expect(new AppleProvider({}, () => native).prewarm()).resolves.toBe(false);
  });
});

describe('countTokens', () => {
  it('returns the native count', async () => {
    const native = new FakeNativeModule();
    native.countTokensResult = { ok: true, count: 17 };
    const provider = new AppleProvider({}, () => native);
    await expect(provider.countTokens([{ role: 'user', content: 'hi' }])).resolves.toBe(17);
    expect(native.calls.countTokens[0]).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('throws a typed LLMError when the counter fails (D9: ModelManagerError 1013)', async () => {
    const native = new FakeNativeModule();
    native.countTokensResult = {
      ok: false,
      error: {
        code: 'unknown',
        message: 'The model failed for an unrecognised reason',
        transient: true,
        nativeDomain: 'ModelManagerError',
        nativeCode: 1013,
      },
    };
    const provider = new AppleProvider({}, () => native);
    const error = await provider.countTokens([{ role: 'user', content: 'hi' }]).catch((e) => e);
    expect(isLLMError(error, 'unknown')).toBe(true);
    expect(error.details.transient).toBe(true);
    expect(error.cause).toMatchObject({ nativeDomain: 'ModelManagerError', nativeErrorCode: 1013 });
  });

  it('rejects a nonsense count rather than budgeting against it', async () => {
    const native = new FakeNativeModule();
    native.countTokensResult = { ok: true, count: Number.NaN };
    const error = await new AppleProvider({}, () => native)
      .countTokens([{ role: 'user', content: 'hi' }])
      .catch((e) => e);
    expect(isLLMError(error, 'unknown')).toBe(true);
  });

  it('lets the context manager fall back to estimates and widen its margin', async () => {
    // The D9/D10 integration: a provider that claims `exact` and then throws is
    // measuring by estimate, and must be treated as such.
    const native = new FakeNativeModule();
    native.countTokensResult = {
      ok: false,
      error: { code: 'unknown', message: 'counter is wedged', transient: true },
    };
    const provider = new AppleProvider({}, () => native);
    const measure = createMeasure({
      tokenCounting: 'exact',
      countTokens: (messages) => provider.countTokens(messages),
    });

    const measurement = await measure([{ role: 'user', content: 'hello there' }]);
    expect(measurement.kind).toBe('estimated');
    expect(measurement.source).toBe('estimatorAfterCounterFailure');
    expect(measurement.tokens).toBeGreaterThan(0);
    expect(isLLMError(measurement.cause, 'unknown')).toBe(true);
  });
});

describe('structured output', () => {
  it('encodes the schema for the bridge and parses the object back', async () => {
    const native = new FakeNativeModule();
    native.generateResult = {
      ok: true,
      result: {
        text: '{"name":"Ada","age":36}',
        finishReason: 'stop',
        objectJson: '{"name":"Ada","age":36}',
      },
    };
    const provider = new AppleProvider({}, () => native);
    const result = await provider.generate(schemaRequest);

    expect(result.object).toEqual({ name: 'Ada', age: 36 });
    expect(result.text).toBe('{"name":"Ada","age":36}');
    const schemaJson = native.calls.generate[0]![4] as string;
    expect(JSON.parse(schemaJson)).toMatchObject({
      type: 'object',
      title: 'Person',
      required: ['name', 'age'],
      'x-order': ['name', 'age'],
      additionalProperties: false,
    });
  });

  it('rejects an unsupported schema construct before the bridge hop', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const error = await provider
      .generate({
        messages: [{ role: 'user', content: 'x' }],
        schema: { type: 'object', properties: { a: { type: 'string', minLength: 3 } } },
      })
      .catch((e) => e);
    expect(isLLMError(error, 'invalidRequest')).toBe(true);
    expect(error.message).toMatch(/`minLength`/);
    expect(native.calls.generate).toHaveLength(0);
  });

  it('streams object snapshots, skipping the ones that do not parse yet', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const events: StreamEvent[] = [];

    const iteration = (async () => {
      for await (const event of provider.stream(schemaRequest)) {
        events.push(event);
      }
    })();

    await native.startStreamCalled;
    const requestId = native.lastStreamRequestId;
    // Partial JSON is the normal case mid-generation, not an error.
    native.emit({ requestId, type: 'objectSnapshot', snapshotJson: '{"name":"Ad' });
    native.emit({ requestId, type: 'objectSnapshot', snapshotJson: '{"name":"Ada"}' });
    native.emit({
      requestId,
      type: 'finish',
      result: {
        text: '{"name":"Ada","age":36}',
        finishReason: 'stop',
        objectJson: '{"name":"Ada","age":36}',
      },
    });
    await iteration;

    expect(events).toEqual([
      { type: 'objectSnapshot', snapshot: { name: 'Ada' } },
      {
        type: 'finish',
        result: {
          text: '{"name":"Ada","age":36}',
          object: { name: 'Ada', age: 36 },
          finishReason: 'stop',
          providerId: 'apple',
        },
      },
    ]);
  });

  it('keeps the raw text when the model produces output that does not parse', async () => {
    const native = new FakeNativeModule();
    native.generateResult = {
      ok: false,
      error: {
        code: 'unknown',
        message: 'The model’s structured output could not be parsed against the schema',
        transient: true,
        rawContent: '{"name":"Ada", "age":',
        nativeDomain: 'FoundationModels.GeneratedContent.ParsingError',
      },
    };
    const provider = new AppleProvider({}, () => native);
    const error = await provider.generate(schemaRequest).catch((e) => e);
    expect(isLLMError(error, 'unknown')).toBe(true);
    expect(error.details.transient).toBe(true);
    expect(error.cause).toMatchObject({
      nativeDomain: 'FoundationModels.GeneratedContent.ParsingError',
      // Never lost: it is the only evidence of what the model actually said.
      rawContent: '{"name":"Ada", "age":',
    });
  });
});
