/**
 * The router *as a provider*: its `id`, `availability`, `capabilities`,
 * `countTokens` and `prewarm`, its telemetry payload, and the fact that a
 * router is just another provider to the router above it.
 */
import { describe, expect, it } from 'vitest';

import { UNKNOWN, type Capabilities } from '../capabilities';
import { LLMError, isLLMError } from '../errors';
import type { GenerateRequest } from '../generation';
import { MockProvider } from '../mock-provider';
import type { LLMProvider } from '../provider';
import { createRouter, type RouteReport } from '../router';
import { stubProvider } from './router-helpers';

const request: GenerateRequest = { messages: [{ role: 'user', content: 'hallo' }] };

describe('id', () => {
  it('defaults to "router" and is configurable for nesting', () => {
    expect(createRouter({ providers: [new MockProvider()] }).id).toBe('router');
    expect(createRouter({ providers: [new MockProvider()], id: 'on-device-first' }).id).toBe(
      'on-device-first'
    );
  });
});

describe('availability', () => {
  it('is available when ANY provider is', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          availability: { available: false, reason: 'notEnabled' },
        }),
        new MockProvider({ id: 'cloud' }),
      ],
    });
    await expect(router.availability()).resolves.toEqual({ available: true });
  });

  it('aggregates the reasons when none is, most hopeful first', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          availability: { available: false, reason: 'unsupportedPlatform' },
        }),
        new MockProvider({
          id: 'cloud',
          availability: { available: false, reason: 'modelNotReady' },
        }),
      ],
    });
    await expect(router.availability()).resolves.toEqual({
      available: false,
      reason: 'modelNotReady',
      detail: 'device: unsupportedPlatform; cloud: modelNotReady',
    });
  });

  it('refreshes rather than reading the routing cache', async () => {
    let available = false;
    const provider: LLMProvider = {
      ...stubProvider({ id: 'device' }),
      availability: async () =>
        available ? { available: true } : { available: false, reason: 'modelNotReady' },
    };
    const router = createRouter({ providers: [provider] });
    await expect(router.availability()).resolves.toMatchObject({ available: false });
    available = true;
    // No TTL wait: the explicit call is the "check now" call.
    await expect(router.availability()).resolves.toEqual({ available: true });
  });
});

describe('capabilities', () => {
  const device: Partial<Capabilities> = {
    contextWindow: 4096,
    structuredOutput: true,
    tools: false,
    tokenCounting: 'exact',
    locales: ['en', 'nl'],
    modelLabel: 'AFM 3 Core',
  };
  const cloud: Partial<Capabilities> = {
    contextWindow: UNKNOWN,
    structuredOutput: false,
    tools: true,
    tokenCounting: 'estimated',
    locales: UNKNOWN,
    modelLabel: 'gpt-x',
  };

  it('reports the preferred available provider verbatim — never a merge', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', capabilities: device, countTokens: 1 }),
        new MockProvider({ id: 'cloud', capabilities: cloud }),
      ],
    });
    const caps = await router.capabilities();
    expect(caps.modelLabel).toBe('AFM 3 Core');
    // A merge would claim tools (union) or deny structured output
    // (intersection), and would have to invent a context window.
    expect(caps.tools).toBe(false);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.contextWindow).toBe(4096);
  });

  it('moves to the next provider the moment the preferred one is unavailable', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          capabilities: device,
          availability: { available: false, reason: 'modelNotReady' },
        }),
        new MockProvider({ id: 'cloud', capabilities: cloud }),
      ],
    });
    await expect(router.capabilities()).resolves.toMatchObject({ modelLabel: 'gpt-x' });
  });

  it('follows policy.preferred rather than configured order', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', capabilities: device }),
        new MockProvider({ id: 'cloud', capabilities: cloud }),
      ],
      policy: { preferred: 'cloud' },
    });
    await expect(router.capabilities()).resolves.toMatchObject({ modelLabel: 'gpt-x' });
  });

  it('answers with the first provider rather than throwing when nothing is available', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          capabilities: device,
          availability: { available: false, reason: 'notEnabled' },
        }),
      ],
    });
    await expect(router.capabilities()).resolves.toMatchObject({ modelLabel: 'AFM 3 Core' });
  });
});

describe('countTokens', () => {
  it('is absent when no provider can count, and present when one can', () => {
    const none = createRouter({ providers: [new MockProvider({ id: 'a' })] });
    expect(none.countTokens).toBeUndefined();

    const some = createRouter({
      providers: [new MockProvider({ id: 'a' }), new MockProvider({ id: 'b', countTokens: 11 })],
    });
    expect(typeof some.countTokens).toBe('function');
  });

  it('delegates to the preferred available provider that can count', async () => {
    const device = new MockProvider({
      id: 'device',
      availability: { available: false, reason: 'modelNotReady' },
      countTokens: 5,
    });
    const cloud = new MockProvider({ id: 'cloud', countTokens: 42 });
    const router = createRouter({ providers: [device, cloud] });
    await expect(router.countTokens?.(request.messages)).resolves.toBe(42);
    expect(device.calls).toHaveLength(0);
  });

  it('throws rather than estimating when no available provider can count', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          countTokens: 5,
          availability: { available: false, reason: 'deviceNotEligible' },
        }),
      ],
    });
    // `createMeasure` catches exactly this and widens the safety margin (D10);
    // a silent estimate would keep the narrow margin under an exact-looking
    // number.
    const error = await router.countTokens?.(request.messages).catch((thrown: unknown) => thrown);
    expect(isLLMError(error, 'unavailable')).toBe(true);
  });

  it('lets the provider’s own counter failure surface (D27)', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          countTokens: new LLMError({ code: 'unknown', transient: true }, { providerId: 'device' }),
        }),
      ],
    });
    await expect(router.countTokens?.(request.messages)).rejects.toMatchObject({
      code: 'unknown',
      providerId: 'device',
    });
  });
});

describe('prewarm', () => {
  it('is absent when no provider can prewarm', () => {
    expect(createRouter({ providers: [new MockProvider()] }).prewarm).toBeUndefined();
  });

  it('forwards to the preferred available provider and passes the messages through', async () => {
    const seen: (readonly { role: string; content: string }[] | undefined)[] = [];
    const device = stubProvider({
      id: 'device',
      availability: { available: false, reason: 'notEnabled' },
      prewarm: async () => true,
    });
    const cloud = stubProvider({
      id: 'cloud',
      prewarm: async (messages) => {
        seen.push(messages);
        return true;
      },
    });
    const router = createRouter({ providers: [device, cloud] });
    await expect(router.prewarm?.(request.messages)).resolves.toBe(true);
    expect(seen).toEqual([request.messages]);
  });

  it('answers false instead of throwing when there is nothing to warm', async () => {
    const router = createRouter({
      providers: [
        stubProvider({
          id: 'device',
          availability: { available: false, reason: 'notEnabled' },
          prewarm: async () => {
            throw new Error('should not be reached');
          },
        }),
      ],
    });
    await expect(router.prewarm?.()).resolves.toBe(false);
  });

  it('swallows a provider’s prewarm failure — a hint that failed is still a hint (D26)', async () => {
    const router = createRouter({
      providers: [
        stubProvider({
          id: 'device',
          prewarm: async () => {
            throw new Error('bridge is asleep');
          },
        }),
      ],
    });
    await expect(router.prewarm?.()).resolves.toBe(false);
  });
});

describe('routers compose', () => {
  it('looks like one provider to the router above it', async () => {
    const outerReports: RouteReport[] = [];
    const innerReports: RouteReport[] = [];

    const inner = createRouter({
      id: 'on-device',
      providers: [
        new MockProvider({
          id: 'apple',
          turns: [{ type: 'error', error: new LLMError({ code: 'unknown', transient: true }) }],
        }),
        new MockProvider({ id: 'apple-fallback', turns: [{ type: 'result', text: 'local' }] }),
      ],
      onRoute: (report) => innerReports.push(report),
    });
    const outer = createRouter({
      providers: [inner, new MockProvider({ id: 'cloud' })],
      onRoute: (report) => outerReports.push(report),
    });

    await expect(outer.generate(request)).resolves.toMatchObject({ providerId: 'apple-fallback' });

    // The inner router absorbed the failure; the outer one saw one provider
    // answer on the first try.
    expect(outerReports[0]?.attempts).toMatchObject([{ providerId: 'on-device', outcome: 'ok' }]);
    expect(outerReports[0]?.fellBack).toBe(false);
    expect(innerReports[0]?.fellBack).toBe(true);
  });

  it('lets the outer router fall back when the inner one runs out', async () => {
    const inner = createRouter({
      id: 'on-device',
      providers: [
        new MockProvider({
          id: 'apple',
          turns: [
            { type: 'error', error: new LLMError({ code: 'network' }, { providerId: 'apple' }) },
          ],
        }),
      ],
    });
    const reports: RouteReport[] = [];
    const outer = createRouter({
      providers: [
        inner,
        new MockProvider({ id: 'cloud', turns: [{ type: 'result', text: 'hi' }] }),
      ],
      onRoute: (report) => reports.push(report),
    });
    await expect(outer.generate(request)).resolves.toMatchObject({ providerId: 'cloud' });
    // The inner provider's error reached the outer router with its own code
    // intact, which is what let the outer router branch on it.
    expect(reports[0]?.attempts).toMatchObject([
      { providerId: 'on-device', outcome: 'network' },
      { providerId: 'cloud', outcome: 'ok' },
    ]);
  });
});

describe('onRoute', () => {
  it('carries exactly the documented fields, and no request or response content', async () => {
    const secret = 'my landlord is called Wouter and lives at 12 Kerkstraat';
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          turns: [
            { type: 'error', error: new LLMError({ code: 'network' }, { providerId: 'device' }) },
          ],
        }),
        new MockProvider({ id: 'cloud', turns: [{ type: 'result', text: 'Dag Wouter' }] }),
      ],
      onRoute: (report) => reports.push(report),
    });

    await router.generate({ messages: [{ role: 'user', content: secret }] });

    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(Object.keys(report ?? {}).sort()).toEqual([
      'attempts',
      'fellBack',
      'providerId',
      'requestId',
      'why',
    ]);
    expect(report?.requestId).toMatch(/^router-1-[a-z0-9]+$/);
    expect(report?.providerId).toBe('cloud');
    expect(report?.why).toBe('fallback');
    expect(report?.fellBack).toBe(true);
    expect(report?.attempts.map((attempt) => attempt.providerId)).toEqual(['device', 'cloud']);
    expect(report?.attempts.map((attempt) => attempt.outcome)).toEqual(['network', 'ok']);
    for (const attempt of report?.attempts ?? []) {
      expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(attempt).sort()).toEqual(['durationMs', 'outcome', 'providerId']);
    }

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('Wouter');
    expect(serialized).not.toContain('Kerkstraat');
    expect(serialized).not.toContain('Dag');
  });

  it('gives every request its own id', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', turns: [{ type: 'result' }, { type: 'result' }] }),
      ],
      onRoute: (report) => reports.push(report),
    });
    await router.generate(request);
    await router.generate(request);
    expect(reports[0]?.requestId).not.toBe(reports[1]?.requestId);
  });

  it('never lets a throwing callback fail the generation', async () => {
    const router = createRouter({
      providers: [new MockProvider({ id: 'device', turns: [{ type: 'result', text: 'ok' }] })],
      onRoute: () => {
        throw new Error('telemetry backend is down');
      },
    });
    await expect(router.generate(request)).resolves.toMatchObject({ text: 'ok' });
  });
});
