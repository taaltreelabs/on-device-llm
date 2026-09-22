/**
 * The fallback chain: which codes move a request to the next provider, which
 * ones never do, and what happens when nobody answers.
 */
import { describe, expect, it } from 'vitest';

import { LLMError, isLLMError, type LLMErrorDetails } from '../errors';
import type { GenerateRequest } from '../generation';
import { MockProvider } from '../mock-provider';
import { DEFAULT_FALLBACK_TRIGGERS, createRouter, type FallbackTriggers } from '../router';

const request: GenerateRequest = { messages: [{ role: 'user', content: 'hallo' }] };

function failing(id: string, details: LLMErrorDetails): MockProvider {
  return new MockProvider({
    id,
    turns: [{ type: 'error', error: new LLMError(details, { providerId: id }) }],
  });
}

function answering(id: string, text = 'from cloud'): MockProvider {
  return new MockProvider({ id, turns: [{ type: 'result', text }] });
}

/** Each trigger, the failure that fires it, and the switch that turns it off. */
const TRIGGERS: readonly {
  readonly name: keyof FallbackTriggers;
  readonly details: LLMErrorDetails;
  readonly defaultOn: boolean;
}[] = [
  {
    name: 'unavailable',
    details: { code: 'unavailable', reason: 'modelNotReady' },
    defaultOn: true,
  },
  {
    name: 'contextOverflow',
    details: { code: 'contextOverflow', tokenCount: 9000 },
    defaultOn: true,
  },
  { name: 'network', details: { code: 'network', status: 503 }, defaultOn: true },
  { name: 'rateLimited', details: { code: 'rateLimited' }, defaultOn: true },
  { name: 'guardrail', details: { code: 'guardrail' }, defaultOn: false },
  {
    name: 'unsupportedLocale',
    details: { code: 'unsupportedLocale', locale: 'pl' },
    defaultOn: true,
  },
  { name: 'unknownTransient', details: { code: 'unknown', transient: true }, defaultOn: true },
  { name: 'unknown', details: { code: 'unknown', transient: false }, defaultOn: false },
];

/** One switch flipped, the rest at their defaults. */
function only(name: keyof FallbackTriggers, on: boolean): FallbackTriggers {
  const triggers: Record<string, boolean> = {};
  triggers[name] = on;
  return triggers as FallbackTriggers;
}

describe('fallback triggers', () => {
  it('matches the documented default table', () => {
    expect(DEFAULT_FALLBACK_TRIGGERS).toEqual({
      unavailable: true,
      contextOverflow: true,
      network: true,
      rateLimited: true,
      guardrail: false,
      unsupportedLocale: true,
      unknownTransient: true,
      unknown: false,
    });
    for (const trigger of TRIGGERS) {
      expect(DEFAULT_FALLBACK_TRIGGERS[trigger.name]).toBe(trigger.defaultOn);
    }
  });

  for (const trigger of TRIGGERS) {
    it(`falls back on ${trigger.name} when the switch is on`, async () => {
      const cloud = answering('cloud');
      const router = createRouter({
        providers: [failing('device', trigger.details), cloud],
        fallback: only(trigger.name, true),
      });
      await expect(router.generate(request)).resolves.toMatchObject({
        text: 'from cloud',
        providerId: 'cloud',
      });
      expect(cloud.requests).toHaveLength(1);
    });

    it(`propagates ${trigger.name} when the switch is off`, async () => {
      const cloud = answering('cloud');
      const router = createRouter({
        providers: [failing('device', trigger.details), cloud],
        fallback: only(trigger.name, false),
      });
      await expect(router.generate(request)).rejects.toMatchObject({
        code: trigger.details.code,
        providerId: 'device',
      });
      expect(cloud.requests).toHaveLength(0);
    });
  }

  it('leaves a non-transient `unknown` alone while still failing over a transient one', async () => {
    // `transient: undefined` is a provider that does not know, and "don't
    // know" is not "retryable" (DECISIONS.md D9/D30).
    const silent = createRouter({
      providers: [failing('device', { code: 'unknown' }), answering('cloud')],
    });
    await expect(silent.generate(request)).rejects.toMatchObject({ code: 'unknown' });

    const hinted = createRouter({
      providers: [failing('device', { code: 'unknown', transient: true }), answering('cloud')],
    });
    await expect(hinted.generate(request)).resolves.toMatchObject({ providerId: 'cloud' });
  });
});

describe('the two codes that never fall back', () => {
  // `{ cancelled: true }` does not typecheck — that is the point of the
  // FallbackTriggers shape. The cast proves the runtime agrees with the type.
  const everythingOn = {
    unavailable: true,
    contextOverflow: true,
    network: true,
    rateLimited: true,
    guardrail: true,
    unsupportedLocale: true,
    unknownTransient: true,
    unknown: true,
    cancelled: true,
    invalidRequest: true,
  } as unknown as FallbackTriggers;

  for (const code of ['cancelled', 'invalidRequest'] as const) {
    it(`never falls back on ${code}, even when configured to`, async () => {
      const cloud = answering('cloud');
      const router = createRouter({
        providers: [failing('device', { code }), cloud],
        fallback: everythingOn,
      });
      await expect(router.generate(request)).rejects.toMatchObject({ code });
      expect(cloud.requests).toHaveLength(0);
    });
  }

  it('reports an already-aborted request as cancelled without asking any provider', async () => {
    const device = answering('device');
    const router = createRouter({ providers: [device] });
    const controller = new AbortController();
    controller.abort();
    await expect(router.generate(request, { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(device.requests).toHaveLength(0);
  });
});

describe('exhaustion', () => {
  it('rethrows the LAST real error, not a synthetic router error', async () => {
    const router = createRouter({
      providers: [
        failing('a', { code: 'network', status: 500 }),
        failing('b', { code: 'unavailable', reason: 'notEnabled' }),
        failing('c', { code: 'rateLimited' }),
      ],
    });
    const error = await router.generate(request).catch((thrown: unknown) => thrown);
    expect(isLLMError(error)).toBe(true);
    expect((error as LLMError).code).toBe('rateLimited');
    // Provider-scoped, not router-scoped: the error is the provider's own.
    expect((error as LLMError).providerId).toBe('c');
  });

  it('tries each provider at most once — no same-provider retry', async () => {
    const device = failing('device', { code: 'network' });
    const router = createRouter({ providers: [device, answering('cloud')] });
    await router.generate(request);
    expect(device.requests).toHaveLength(1);
    expect(device.remainingTurns).toBe(0);
  });

  it('synthesizes `unavailable` when every provider was skipped for being unavailable', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          availability: { available: false, reason: 'deviceNotEligible' },
        }),
        new MockProvider({
          id: 'cloud',
          availability: { available: false, reason: 'modelNotReady' },
        }),
      ],
    });
    const error = await router.generate(request).catch((thrown: unknown) => thrown);
    expect(isLLMError(error, 'unavailable')).toBe(true);
    if (isLLMError(error, 'unavailable')) {
      // The most hopeful reason wins the aggregate: a download in progress is
      // actionable, an ineligible device is not.
      expect(error.details.reason).toBe('modelNotReady');
      expect(error.providerId).toBe('router');
      expect(error.message).toContain('device: deviceNotEligible');
      expect(error.message).toContain('cloud: modelNotReady');
    }
  });

  it('synthesizes `contextOverflow` when the only skips were window skips', async () => {
    const router = createRouter({
      providers: [new MockProvider({ id: 'device', capabilities: { contextWindow: 4 } })],
    });
    const error = await router
      .generate({ messages: [{ role: 'user', content: 'a much longer prompt than four tokens' }] })
      .catch((thrown: unknown) => thrown);
    expect(isLLMError(error, 'contextOverflow')).toBe(true);
    if (isLLMError(error, 'contextOverflow')) {
      expect(error.details.contextSize).toBe(4);
      expect(error.details.tokenCount).toBeGreaterThan(4);
    }
  });

  it('synthesizes `invalidRequest` when a capability requirement left nothing', async () => {
    const router = createRouter({
      providers: [new MockProvider({ id: 'device', capabilities: { tools: false } })],
      policy: { require: { tools: true } },
    });
    const error = await router.generate(request).catch((thrown: unknown) => thrown);
    expect(isLLMError(error, 'invalidRequest')).toBe(true);
    expect((error as LLMError).message).toContain('device: capability');
  });
});

describe('construction', () => {
  it('rejects an empty provider list, duplicate ids, and a negative TTL', () => {
    expect(() => createRouter({ providers: [] })).toThrow(/at least one provider/);
    expect(() =>
      createRouter({ providers: [new MockProvider({ id: 'a' }), new MockProvider({ id: 'a' })] })
    ).toThrow(/unique/);
    expect(() => createRouter({ providers: [new MockProvider()], cacheTtlMs: -1 })).toThrow(
      /cacheTtlMs/
    );
  });
});
