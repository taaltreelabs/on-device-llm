/**
 * `AppleProvider` against a scriptable fake of the Swift module.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isLLMError, UNKNOWN, type GenerateRequest } from '../../core';
import { AppleProvider } from '../provider';
import { FakeNativeModule } from './fake-native';

let native: FakeNativeModule;
const make = (config = {}): AppleProvider => new AppleProvider(config, () => native);

beforeEach(() => {
  native = new FakeNativeModule();
});

const ask: GenerateRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('availability', () => {
  it('passes through `available`', async () => {
    await expect(make().availability()).resolves.toEqual({ available: true });
  });

  it.each([
    ['deviceNotEligible', 'deviceNotEligible'],
    ['notEnabled', 'notEnabled'],
    ['modelNotReady', 'modelNotReady'],
  ])('maps the native reason %s', async (nativeReason, expected) => {
    native.availabilityResult = { available: false, reason: nativeReason, detail: 'because' };
    await expect(make().availability()).resolves.toEqual({
      available: false,
      reason: expected,
      detail: 'because',
    });
  });

  it('falls back to modelNotReady for a reason this version does not know', async () => {
    // A native module newer than the JS half. `modelNotReady` is the only
    // recoverable reason, so an unknown one must not permanently write the
    // device off.
    native.availabilityResult = { available: false, reason: 'somethingNew' };
    await expect(make().availability()).resolves.toMatchObject({ reason: 'modelNotReady' });
  });

  it('reports modelNotReady when the bridge itself fails', async () => {
    native.throwFrom.availability = new Error('bridge is wedged');
    await expect(make().availability()).resolves.toMatchObject({
      available: false,
      reason: 'modelNotReady',
      detail: 'bridge is wedged',
    });
  });

  it('does not check the locale when none is configured', async () => {
    native.supportedLocales.clear();
    await expect(make().availability()).resolves.toEqual({ available: true });
  });

  it('stays available for a supported configured locale', async () => {
    await expect(make({ locale: 'nl-NL' }).availability()).resolves.toEqual({ available: true });
  });

  it('reports unavailable for an unsupported configured locale (D19)', async () => {
    const availability = await make({ locale: 'pl-PL' }).availability();
    expect(availability).toMatchObject({ available: false, reason: 'deviceNotEligible' });
    expect(availability.available === false && availability.detail).toMatch(/pl-PL/);
  });

  it('does not invent an unavailability when the locale check itself fails', async () => {
    native.throwFrom.supportsLocale = new Error('nope');
    await expect(make({ locale: 'pl-PL' }).availability()).resolves.toEqual({ available: true });
  });
});

describe('capabilities', () => {
  it('reports what the bridge supports today, not what the model supports', async () => {
    await expect(make().capabilities()).resolves.toEqual({
      contextWindow: 8192,
      streaming: true,
      // Phase 3 steps 5-7 are not built; advertising them would make the
      // router route toward a provider that is about to fail.
      structuredOutput: false,
      tools: false,
      tokenCounting: 'none',
      locales: ['en', 'nl', 'fr', 'de', 'es'],
      modelLabel: 'AFM 3 Core Advanced',
    });
  });

  it('normalizes a zero context window to UNKNOWN (D9/D11)', async () => {
    native.capabilitiesResult = { ...native.capabilitiesResult, contextWindow: 0 };
    await expect(make().capabilities()).resolves.toMatchObject({ contextWindow: UNKNOWN });
  });

  it.each([-1, Number.NaN, 0.5])('normalizes %s to UNKNOWN or an integer', async (value) => {
    native.capabilitiesResult = { ...native.capabilitiesResult, contextWindow: value };
    const { contextWindow } = await make().capabilities();
    expect(contextWindow === UNKNOWN || Number.isInteger(contextWindow)).toBe(true);
  });

  it('reports UNKNOWN locales rather than an empty list', async () => {
    native.capabilitiesResult = { contextWindow: 8192, locales: [] };
    await expect(make().capabilities()).resolves.toMatchObject({ locales: UNKNOWN });
  });

  it('degrades to an all-unknown shape when the bridge throws', async () => {
    native.throwFrom.capabilities = new Error('wedged');
    await expect(make().capabilities()).resolves.toMatchObject({
      contextWindow: UNKNOWN,
      streaming: false,
      tokenCounting: 'none',
    });
  });
});

describe('request validation (rejected before crossing the bridge)', () => {
  const rejects = async (request: GenerateRequest, pattern: RegExp): Promise<void> => {
    await expect(make().generate(request)).rejects.toSatisfy(
      (err: unknown) => isLLMError(err, 'invalidRequest') && pattern.test((err as Error).message)
    );
    expect(native.calls.generate).toHaveLength(0);
  };

  it('rejects a schema until structured output lands (step 6)', async () => {
    await rejects({ ...ask, schema: { type: 'object' } }, /structured output/i);
  });

  it('rejects an empty message list', async () => {
    await rejects({ messages: [] }, /empty/i);
  });

  it('rejects a system-only conversation', async () => {
    await rejects({ messages: [{ role: 'system', content: 'be nice' }] }, /only system messages/i);
  });

  it('rejects a conversation ending with an assistant message (D17)', async () => {
    await rejects(
      {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      },
      /end with a user message/i
    );
  });

  it('rejects a non-finite temperature', async () => {
    await rejects({ ...ask, temperature: Number.POSITIVE_INFINITY }, /finite/i);
  });

  it.each([0, -1, 1.5])('rejects maxOutputTokens=%s', async (value) => {
    await rejects({ ...ask, maxOutputTokens: value }, /positive integer/i);
  });

  it('accepts a trailing user message after a non-pinned system summary', async () => {
    await expect(
      make().generate({
        messages: [
          { role: 'system', content: 'be nice' },
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'system', content: '[summary of earlier conversation] …' },
          { role: 'user', content: 'c' },
        ],
      })
    ).resolves.toMatchObject({ text: 'hello' });
  });
});

describe('generate', () => {
  it('returns a GenerateResult carrying the provider id', async () => {
    await expect(make().generate(ask)).resolves.toEqual({
      text: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 7, outputTokens: 2 },
      providerId: 'apple',
    });
  });

  it('forwards sampling options, and null for the ones not set', async () => {
    await make().generate({ ...ask, temperature: 0.3 });
    expect(native.calls.generate[0]).toEqual([
      expect.stringMatching(/^apple-/),
      [{ role: 'user', content: 'hi' }],
      0.3,
      null,
    ]);
  });

  it('omits usage when the native side reported none', async () => {
    native.generateResult = { ok: true, result: { text: 'x', finishReason: 'stop' } };
    await expect(make().generate(ask)).resolves.not.toHaveProperty('usage');
  });

  it('maps an unrecognised finish reason to `other`', async () => {
    native.generateResult = { ok: true, result: { text: 'x', finishReason: 'wat' } };
    await expect(make().generate(ask)).resolves.toMatchObject({ finishReason: 'other' });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    await expect(make().generate(ask, { signal: AbortSignal.abort('stop it') })).rejects.toSatisfy(
      (err: unknown) => isLLMError(err, 'cancelled')
    );
    expect(native.calls.generate).toHaveLength(0);
  });

  it('cancels natively when the signal fires mid-request', async () => {
    const controller = new AbortController();
    let resolveGenerate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGenerate = resolve;
    });
    native.generate = async (requestId: string) => {
      native.calls.generate.push([requestId]);
      await gate;
      return native.generateResult;
    };

    const promise = make().generate(ask, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    resolveGenerate();

    await expect(promise).rejects.toSatisfy((err: unknown) => isLLMError(err, 'cancelled'));
    expect(native.calls.cancel).toHaveLength(1);
  });
});

describe('native error payloads map onto the taxonomy', () => {
  const failWith = async (error: Record<string, unknown>): Promise<unknown> => {
    native.generateResult = { ok: false, error: error as never };
    return make()
      .generate(ask)
      .then(
        () => {
          throw new Error('expected a rejection');
        },
        (err: unknown) => err
      );
  };

  it('unavailable carries the reason', async () => {
    const err = await failWith({ code: 'unavailable', message: 'assets', reason: 'modelNotReady' });
    expect(isLLMError(err, 'unavailable') && err.details.reason).toBe('modelNotReady');
  });

  it('contextOverflow carries contextSize and tokenCount', async () => {
    const err = await failWith({
      code: 'contextOverflow',
      message: 'too big',
      contextSize: 8192,
      tokenCount: 40061,
    });
    expect(isLLMError(err, 'contextOverflow') && err.details).toEqual({
      code: 'contextOverflow',
      contextSize: 8192,
      tokenCount: 40061,
    });
  });

  it('guardrail', async () => {
    expect(isLLMError(await failWith({ code: 'guardrail', message: 'blocked' }), 'guardrail')).toBe(
      true
    );
  });

  it('unsupportedLocale carries the locale', async () => {
    const err = await failWith({ code: 'unsupportedLocale', message: 'no', locale: 'pl' });
    expect(isLLMError(err, 'unsupportedLocale') && err.details.locale).toBe('pl');
  });

  it('rateLimited turns the epoch millis into a Date', async () => {
    const at = Date.UTC(2026, 8, 21, 12, 0, 0);
    const err = await failWith({ code: 'rateLimited', message: 'slow down', resetDate: at });
    expect(isLLMError(err, 'rateLimited') && err.details.resetDate?.getTime()).toBe(at);
  });

  it('cancelled', async () => {
    expect(isLLMError(await failWith({ code: 'cancelled', message: 'stopped' }), 'cancelled')).toBe(
      true
    );
  });

  it('invalidRequest', async () => {
    expect(
      isLLMError(await failWith({ code: 'invalidRequest', message: 'bad' }), 'invalidRequest')
    ).toBe(true);
  });

  it('unknown keeps the transient hint and the native diagnostics (D9)', async () => {
    const err = await failWith({
      code: 'unknown',
      message: 'The operation couldn’t be completed.',
      transient: true,
      nativeDomain: 'com.apple.SensitiveContentAnalysisML',
      nativeCode: 15,
      nativeDetail: 'ModelManagerError 1013',
    });
    expect(isLLMError(err, 'unknown') && err.details.transient).toBe(true);
    expect((err as Error).cause).toEqual({
      nativeCode: 'unknown',
      nativeMessage: 'The operation couldn’t be completed.',
      nativeDomain: 'com.apple.SensitiveContentAnalysisML',
      nativeErrorCode: 15,
      nativeDetail: 'ModelManagerError 1013',
    });
  });

  it('treats a code it does not recognise as unknown, without guessing transience', async () => {
    const err = await failWith({ code: 'somethingNewInIOS28', message: '?' });
    expect(isLLMError(err, 'unknown') && err.details.transient).toBeUndefined();
  });
});

describe('supportsLocale', () => {
  it('delegates to the native check', async () => {
    await expect(make().supportsLocale('nl-NL')).resolves.toBe(true);
    await expect(make().supportsLocale('pl-PL')).resolves.toBe(false);
  });
});
