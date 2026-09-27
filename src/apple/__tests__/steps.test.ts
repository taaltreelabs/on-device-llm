/**
 * Phase 3 steps 4-6 on the TypeScript side: prewarming, token counting (and
 * the context manager's behaviour when it fails), and structured output.
 */
import { describe, expect, it } from 'vitest';

import {
  createMeasure,
  DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS,
  fitContext,
  isLLMError,
  type GenerateRequest,
  type StreamEvent,
} from '../../core';
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
    // The model reports `tokenCounting: 'exact'`, but there is no
    // `countTokens` function to call it on (a JS half newer than the native
    // half) — `'estimated'` is what stays honest, not `'none'` (that is
    // reserved for "no native module at all"; `countTokens()` itself still
    // answers via the core estimator, see steps below).
    await expect(provider.capabilities()).resolves.toMatchObject({
      tools: false,
      tokenCounting: 'estimated',
    });
  });

  it("defaults tokenCounting to 'estimated' when the wire omits it (older native build)", async () => {
    const native = new FakeNativeModule();
    // No `tokenCounting`/`usageReporting` at all — a native module built
    // before this field existed. Missing must read as the *safe* direction,
    // not as 'exact': an unreported native module is an unknown quantity.
    native.capabilitiesResult = { contextWindow: 8192, locales: ['en'] };
    const provider = new AppleProvider({}, () => native);
    await expect(provider.capabilities()).resolves.toMatchObject({ tokenCounting: 'estimated' });
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
  it("returns the native count when the model reports tokenCounting: 'exact' (iOS 26.4+)", async () => {
    const native = new FakeNativeModule();
    native.countTokensResult = { ok: true, count: 17 };
    const provider = new AppleProvider({}, () => native);
    await expect(provider.countTokens([{ role: 'user', content: 'hi' }])).resolves.toBe(17);
    expect(native.calls.countTokens[0]).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it(
    'estimates instead of calling native when the model reports tokenCounting: ' +
      "'estimated' (iOS 26.0-26.3, no exact tokenCount(for:) at all)",
    async () => {
      const native = new FakeNativeModule();
      native.capabilitiesResult = { ...native.capabilitiesResult, tokenCounting: 'estimated' };
      const provider = new AppleProvider({}, () => native);

      await expect(provider.capabilities()).resolves.toMatchObject({ tokenCounting: 'estimated' });

      const tokens = await provider.countTokens([{ role: 'user', content: 'hello there' }]);
      expect(tokens).toBeGreaterThan(0);
      // The fixed native contract has `countTokens` resolve `{ ok: false, … }`
      // on these OS versions — calling it would spend a bridge hop only to
      // fail, so it must never be reached.
      expect(native.calls.countTokens).toHaveLength(0);
    }
  );

  it('asks native capabilities() once for the counting mode, not once per countTokens call', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const messages = [{ role: 'user' as const, content: 'hello there' }];

    await provider.countTokens(messages);
    await provider.countTokens(messages);
    await provider.countTokens(messages);

    // The OS version cannot change while the process runs, so the mode is
    // settled by one round trip; every `fitContext` measurement after that
    // goes straight to the counter.
    expect(native.calls.capabilities).toBe(1);
    expect(native.calls.countTokens).toHaveLength(3);
  });

  it('retries the counting-mode lookup after a transient capabilities() failure', async () => {
    const native = new FakeNativeModule();
    const provider = new AppleProvider({}, () => native);
    const messages = [{ role: 'user' as const, content: 'hello there' }];

    native.throwFrom.capabilities = new Error('bridge hiccup');
    await expect(provider.countTokens(messages)).rejects.toSatisfy((e) => isLLMError(e));

    native.throwFrom.capabilities = undefined;
    await expect(provider.countTokens(messages)).resolves.toBe(42);
    expect(native.calls.capabilities).toBe(2);
  });

  it("estimates instead of calling native when tokenCounting is missing from the wire (defaults to 'estimated')", async () => {
    const native = new FakeNativeModule();
    native.capabilitiesResult = { contextWindow: 8192, locales: ['en'] };
    const provider = new AppleProvider({}, () => native);

    const tokens = await provider.countTokens([{ role: 'user', content: 'hello there' }]);
    expect(tokens).toBeGreaterThan(0);
    expect(native.calls.countTokens).toHaveLength(0);
  });

  it('throws a typed LLMError when the counter fails (ModelManagerError 1013)', async () => {
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
    // Token-counting fallback: a provider that claims `exact` and then throws is
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

  it(
    'fitContext widens the safety margin to 256 for a device reporting ' +
      "tokenCounting: 'estimated' (iOS 26.0-26.3)",
    async () => {
      const native = new FakeNativeModule();
      native.capabilitiesResult = {
        ...native.capabilitiesResult,
        contextWindow: 4096,
        tokenCounting: 'estimated',
      };
      const provider = new AppleProvider({}, () => native);

      const result = await fitContext([{ role: 'user', content: 'hello there' }], {
        provider,
        reservedForOutput: 100,
      });

      // This is the steady-state shape on that OS range, not a counter
      // failure: the measurement source is `providerEstimated`, not
      // `estimatorAfterCounterFailure`, and native `countTokens` is never
      // reached to produce it.
      expect(result.measurement).toMatchObject({ kind: 'estimated', source: 'providerEstimated' });
      expect(result.budget).toMatchObject({
        kind: 'bounded',
        safetyMargin: DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS,
      });
      expect(native.calls.countTokens).toHaveLength(0);
    }
  );
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
