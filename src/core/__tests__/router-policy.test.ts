/**
 * Policy: which provider is asked first, and which ones are never asked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UNKNOWN } from '../capabilities';
import type { GenerateRequest } from '../generation';
import { MockProvider } from '../mock-provider';
import {
  DEFAULT_ROUTE_CACHE_TTL_MS,
  createRouter,
  type RoutePolicyContext,
  type RouteReport,
} from '../router';
import { countingProvider } from './router-helpers';

const short: GenerateRequest = { messages: [{ role: 'user', content: 'hallo' }] };
const long: GenerateRequest = {
  messages: [{ role: 'user', content: 'x'.repeat(4000) }],
};

function answering(id: string, turns = 1): MockProvider {
  return new MockProvider({
    id,
    turns: Array.from({ length: turns }, () => ({ type: 'result', text: id }) as const),
  });
}

describe('picking the first provider', () => {
  it('follows configured order by default', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [answering('device'), answering('cloud')],
      onRoute: (report) => reports.push(report),
    });
    await expect(router.generate(short)).resolves.toMatchObject({ providerId: 'device' });
    expect(reports[0]).toMatchObject({ providerId: 'device', why: 'order', fellBack: false });
  });

  it('honours `preferred`, and ignores it when that provider is not eligible', async () => {
    const preferred = createRouter({
      providers: [answering('device'), answering('cloud')],
      policy: { preferred: 'cloud' },
    });
    await expect(preferred.generate(short)).resolves.toMatchObject({ providerId: 'cloud' });

    const unavailablePreference = createRouter({
      providers: [
        answering('device'),
        new MockProvider({ id: 'cloud', availability: { available: false, reason: 'notEnabled' } }),
      ],
      policy: { preferred: 'cloud' },
    });
    // A preference is not a requirement: configured order takes over.
    await expect(unavailablePreference.generate(short)).resolves.toMatchObject({
      providerId: 'device',
    });
  });

  it('routes on the request task tag', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [answering('device', 2), answering('cloud', 2)],
      policy: { tags: { reasoning: { preferred: 'cloud' } } },
      onRoute: (report) => reports.push(report),
    });

    await expect(router.generate({ ...short, taskTag: 'reasoning' })).resolves.toMatchObject({
      providerId: 'cloud',
    });
    expect(reports[0]).toMatchObject({ why: 'tag' });

    // A tag with no rule routes exactly like an untagged request.
    await expect(router.generate({ ...short, taskTag: 'chitchat' })).resolves.toMatchObject({
      providerId: 'device',
    });
    expect(reports[1]).toMatchObject({ why: 'order' });
  });

  it('lets a tag rule tighten `require` without restating the rest', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          capabilities: { tools: false },
          turns: [{ type: 'result' }],
        }),
        new MockProvider({
          id: 'cloud',
          capabilities: { tools: true },
          turns: [{ type: 'result', text: 'cloud' }],
        }),
      ],
      policy: { require: { streaming: true }, tags: { agent: { require: { tools: true } } } },
    });
    await expect(router.generate({ ...short, taskTag: 'agent' })).resolves.toMatchObject({
      providerId: 'cloud',
    });
  });

  it('applies a `where` predicate, recorded as skipped:policy', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [answering('device'), answering('cloud')],
      policy: { where: (candidate) => candidate.id !== 'device' },
      onRoute: (report) => reports.push(report),
    });
    await expect(router.generate(short)).resolves.toMatchObject({ providerId: 'cloud' });
    expect(reports[0]?.attempts).toMatchObject([
      { providerId: 'device', outcome: 'skipped:policy' },
      { providerId: 'cloud', outcome: 'ok' },
    ]);
  });

  it('accepts the function form, which sees the same facts the router used', async () => {
    let seen: RoutePolicyContext | undefined;
    const router = createRouter({
      providers: [answering('device'), answering('cloud')],
      policy: (context) => {
        seen = context;
        return 'cloud';
      },
    });
    const reports: RouteReport[] = [];
    const withReport = createRouter({
      providers: [answering('device'), answering('cloud')],
      policy: () => 'cloud',
      onRoute: (report) => reports.push(report),
    });

    await expect(router.generate(short)).resolves.toMatchObject({ providerId: 'cloud' });
    await withReport.generate(short);
    expect(reports[0]).toMatchObject({ why: 'policy' });

    expect(seen?.taskTag).toBeUndefined();
    expect(seen?.estimatedTokens).toBeGreaterThan(0);
    expect(seen?.candidates.map((candidate) => candidate.id)).toEqual(['device', 'cloud']);
    expect(seen?.candidates[0]).toMatchObject({
      index: 0,
      availability: { available: true },
      fitsContextWindow: true,
      tokenSource: 'estimate',
    });
  });

  it('ignores a function-form choice that names no configured provider', async () => {
    const router = createRouter({
      providers: [answering('device'), answering('cloud')],
      policy: () => 'nonexistent',
    });
    await expect(router.generate(short)).resolves.toMatchObject({ providerId: 'device' });
  });
});

describe('the context-window check', () => {
  it('skips a provider whose known window cannot hold the request', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', capabilities: { contextWindow: 64 } }),
        answering('cloud'),
      ],
      onRoute: (report) => reports.push(report),
    });
    await expect(router.generate(long)).resolves.toMatchObject({ providerId: 'cloud' });
    expect(reports[0]?.attempts).toMatchObject([
      { providerId: 'device', outcome: 'skipped:contextWindow' },
      { providerId: 'cloud', outcome: 'ok' },
    ]);
  });

  it('counts `maxOutputTokens` against the same window', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', capabilities: { contextWindow: 100 } }),
        answering('cloud'),
      ],
    });
    // The prompt alone fits 100 tokens; the prompt plus the reservation does not.
    await expect(router.generate({ ...short, maxOutputTokens: 512 })).resolves.toMatchObject({
      providerId: 'cloud',
    });
  });

  it('does NOT skip a provider whose window is UNKNOWN (DECISIONS.md D11)', async () => {
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'cloud',
          capabilities: { contextWindow: UNKNOWN },
          turns: [{ type: 'result', text: 'cloud' }],
        }),
      ],
    });
    await expect(router.generate(long)).resolves.toMatchObject({ providerId: 'cloud' });
  });

  it('uses the provider’s own counter when the window is known, and not otherwise', async () => {
    const exact = new MockProvider({
      id: 'device',
      capabilities: { contextWindow: 4096 },
      countTokens: 7,
      turns: [{ type: 'result', text: 'device' }],
    });
    await createRouter({ providers: [exact] }).generate(long);
    expect(exact.calls.filter((call) => call.method === 'countTokens')).toHaveLength(1);

    const unbounded = new MockProvider({
      id: 'cloud',
      capabilities: { contextWindow: UNKNOWN },
      countTokens: 7,
      turns: [{ type: 'result', text: 'cloud' }],
    });
    await createRouter({ providers: [unbounded] }).generate(long);
    // Nothing to compare the number against, so the bridge hop is not spent.
    expect(unbounded.calls.filter((call) => call.method === 'countTokens')).toHaveLength(0);
  });

  it('falls back to the estimate when the provider’s counter throws (D9)', async () => {
    const device = new MockProvider({
      id: 'device',
      capabilities: { contextWindow: 4096 },
      countTokens: new (await import('../errors')).LLMError({ code: 'unknown', transient: true }),
      turns: [{ type: 'result', text: 'device' }],
    });
    await expect(createRouter({ providers: [device] }).generate(short)).resolves.toMatchObject({
      providerId: 'device',
    });
  });
});

describe('capability and locale requirements', () => {
  it('skips a provider that cannot do what the request needs', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', capabilities: { structuredOutput: false } }),
        answering('cloud'),
      ],
      policy: { require: { structuredOutput: true } },
      onRoute: (report) => reports.push(report),
    });
    await router.generate(short);
    expect(reports[0]?.attempts).toMatchObject([
      { providerId: 'device', outcome: 'skipped:capability' },
      { providerId: 'cloud', outcome: 'ok' },
    ]);
  });

  it('matches `require.locale` on the language subtag and never fails UNKNOWN locales', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', capabilities: { locales: ['en', 'nl', 'fr'] } }),
        answering('cloud'), // locales: UNKNOWN
      ],
      policy: { require: { locale: 'pl' } },
      onRoute: (report) => reports.push(report),
    });
    await expect(router.generate(short)).resolves.toMatchObject({ providerId: 'cloud' });
    expect(reports[0]?.attempts).toMatchObject([
      { providerId: 'device', outcome: 'skipped:locale' },
      { providerId: 'cloud', outcome: 'ok' },
    ]);

    const dutch = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          capabilities: { locales: ['en', 'nl'] },
          turns: [{ type: 'result', text: 'device' }],
        }),
        answering('cloud'),
      ],
      policy: { require: { locale: 'nl-BE' } },
    });
    await expect(dutch.generate(short)).resolves.toMatchObject({ providerId: 'device' });
  });

  it('can be told to attempt an unavailable provider anyway', async () => {
    const device = new MockProvider({
      id: 'device',
      availability: { available: false, reason: 'modelNotReady' },
      turns: [{ type: 'result', text: 'device' }],
    });
    const router = createRouter({
      providers: [device, answering('cloud')],
      policy: { require: { available: false } },
    });
    await expect(router.generate(short)).resolves.toMatchObject({ providerId: 'device' });
  });
});

describe('introspection caching', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('introspects once per provider per TTL, then again after it expires', async () => {
    vi.useFakeTimers();
    const { provider, counts } = countingProvider(answering('device', 3));
    const router = createRouter({ providers: [provider] });

    await router.generate(short);
    expect(counts).toEqual({ availability: 1, capabilities: 1 });

    await router.generate(short);
    expect(counts).toEqual({ availability: 1, capabilities: 1 });

    vi.advanceTimersByTime(DEFAULT_ROUTE_CACHE_TTL_MS + 1);
    await router.generate(short);
    expect(counts).toEqual({ availability: 2, capabilities: 2 });
  });

  it('honours a configured TTL, and `0` disables caching entirely', async () => {
    vi.useFakeTimers();
    const shortTtl = countingProvider(answering('device', 3));
    const router = createRouter({ providers: [shortTtl.provider], cacheTtlMs: 1_000 });
    await router.generate(short);
    vi.advanceTimersByTime(500);
    await router.generate(short);
    expect(shortTtl.counts.availability).toBe(1);
    vi.advanceTimersByTime(600);
    await router.generate(short);
    expect(shortTtl.counts.availability).toBe(2);

    const uncached = countingProvider(answering('cloud', 2));
    const always = createRouter({ providers: [uncached.provider], cacheTtlMs: 0 });
    await always.generate(short);
    await always.generate(short);
    expect(uncached.counts.availability).toBe(2);
  });

  it('shares one in-flight lookup between concurrent requests', async () => {
    const { provider, counts } = countingProvider(answering('device', 3));
    const router = createRouter({ providers: [provider] });
    await Promise.all([router.generate(short), router.generate(short), router.generate(short)]);
    expect(counts.availability).toBe(1);
  });

  it('routes around a provider whose availability() rejects, instead of failing the request', async () => {
    const broken: MockProvider = new MockProvider({ id: 'device' });
    const rejecting = {
      ...broken,
      id: 'device',
      availability: () => Promise.reject(new Error('native module missing')),
      capabilities: () => Promise.reject(new Error('native module missing')),
      generate: broken.generate.bind(broken),
      stream: broken.stream.bind(broken),
    };
    const router = createRouter({ providers: [rejecting, answering('cloud')] });
    await expect(router.generate(short)).resolves.toMatchObject({ providerId: 'cloud' });
  });
});
