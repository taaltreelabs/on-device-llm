/**
 * The streaming rule: the fallback window closes on the first event handed to
 * the consumer, and nothing reopens it.
 *
 * docs/plan.md §4 — "a response that switches models halfway through is worse
 * than an error".
 */
import { describe, expect, it } from 'vitest';

import { LLMError } from '../errors';
import type { GenerateRequest } from '../generation';
import { MockProvider } from '../mock-provider';
import { createRouter, type RouteReport } from '../router';
import type { StreamEvent } from '../stream';
import { collect, deltas, stubProvider } from './router-helpers';

const request: GenerateRequest = { messages: [{ role: 'user', content: 'hallo' }] };

const transient = (providerId: string): LLMError =>
  new LLMError({ code: 'unknown', transient: true }, { providerId });

describe('stream fallback before the first event', () => {
  it('starts the next provider transparently when the first fails before emitting', async () => {
    const device = new MockProvider({
      id: 'device',
      turns: [{ type: 'error', error: transient('device') }],
    });
    const cloud = new MockProvider({
      id: 'cloud',
      turns: [{ type: 'stream', chunks: ['Hal', 'lo'] }],
    });
    const reports: RouteReport[] = [];
    const router = createRouter({ providers: [device, cloud], onRoute: (r) => reports.push(r) });

    const events = await collect(router.stream(request));
    expect(deltas(events)).toEqual(['Hal', 'lo']);
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
    expect(reports[0]).toMatchObject({
      providerId: 'cloud',
      why: 'fallback',
      fellBack: true,
      attempts: [
        { providerId: 'device', outcome: 'unknown' },
        { providerId: 'cloud', outcome: 'ok' },
      ],
    });
  });

  it('does not consume a turn from a provider it never reaches', async () => {
    const cloud = new MockProvider({ id: 'cloud', turns: [{ type: 'result', text: 'hi' }] });
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', turns: [{ type: 'result', text: 'hi' }] }),
        cloud,
      ],
    });
    await collect(router.stream(request));
    expect(cloud.remainingTurns).toBe(1);
  });
});

describe('no fallback once an event has been yielded', () => {
  it('propagates a failure that arrives after a textDelta', async () => {
    const device = new MockProvider({
      id: 'device',
      turns: [{ type: 'stream', chunks: ['Hal'], error: transient('device') }],
    });
    const cloud = new MockProvider({ id: 'cloud', turns: [{ type: 'stream', chunks: ['other'] }] });
    const reports: RouteReport[] = [];
    const router = createRouter({ providers: [device, cloud], onRoute: (r) => reports.push(r) });

    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of router.stream(request)) seen.push(event);
      })()
    ).rejects.toMatchObject({ code: 'unknown', providerId: 'device' });

    expect(deltas(seen)).toEqual(['Hal']);
    // The trigger is ON by default — it is the *yield* that closed the window.
    expect(cloud.requests).toHaveLength(0);
    expect(reports[0]).toMatchObject({
      providerId: 'device',
      fellBack: false,
      attempts: [{ providerId: 'device', outcome: 'unknown' }],
    });
  });

  it('propagates a failure that arrives after a toolCall event', async () => {
    // A toolCall means an app-written handler has already run. A second
    // provider would run it again, so the window is closed just as firmly as
    // it is by text (DECISIONS.md D24).
    const device = stubProvider({
      id: 'device',
      events: [{ type: 'toolCall', callId: 'c1', toolName: 'lookup', arguments: { q: 'x' } }],
      error: transient('device'),
    });
    const cloud = new MockProvider({ id: 'cloud', turns: [{ type: 'stream', chunks: ['other'] }] });
    const router = createRouter({ providers: [device, cloud] });

    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of router.stream(request)) seen.push(event);
      })()
    ).rejects.toMatchObject({ code: 'unknown' });

    expect(seen).toEqual([
      { type: 'toolCall', callId: 'c1', toolName: 'lookup', arguments: { q: 'x' } },
    ]);
    expect(cloud.requests).toHaveLength(0);
  });

  it('does not pre-buffer: the consumer sees the first delta before the stream can fail', async () => {
    const device = new MockProvider({
      id: 'device',
      turns: [{ type: 'stream', chunks: ['one', 'two'], error: transient('device') }],
    });
    const router = createRouter({ providers: [device, new MockProvider({ id: 'cloud' })] });
    const seen: string[] = [];
    try {
      for await (const event of router.stream(request)) {
        if (event.type === 'textDelta') seen.push(event.delta);
      }
    } catch {
      // expected
    }
    // Both deltas arrived at the consumer rather than being held back to keep
    // the fallback window open.
    expect(seen).toEqual(['one', 'two']);
  });
});

describe('abort during a stream', () => {
  it('propagates to the active provider and ends the chain', async () => {
    const device = new MockProvider({
      id: 'device',
      turns: [{ type: 'stream', chunks: ['one', { text: 'two', delayMs: 50 }] }],
    });
    const cloud = new MockProvider({ id: 'cloud', turns: [{ type: 'stream', chunks: ['cloud'] }] });
    const router = createRouter({ providers: [device, cloud] });
    const controller = new AbortController();

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of router.stream(request, { signal: controller.signal })) {
          if (event.type === 'textDelta') {
            seen.push(event.delta);
            controller.abort();
          }
        }
      })()
    ).rejects.toMatchObject({ code: 'cancelled' });

    expect(seen).toEqual(['one']);
    expect(cloud.requests).toHaveLength(0);
    // The signal reached the provider rather than being intercepted.
    expect(device.calls[0]?.signal).toBe(controller.signal);
  });

  it('never falls back on an abort raised before the first event', async () => {
    const device = new MockProvider({
      id: 'device',
      turns: [
        { type: 'error', error: new LLMError({ code: 'cancelled' }, { providerId: 'device' }) },
      ],
    });
    const cloud = new MockProvider({ id: 'cloud', turns: [{ type: 'stream', chunks: ['cloud'] }] });
    const router = createRouter({ providers: [device, cloud] });
    await expect(collect(router.stream(request))).rejects.toMatchObject({ code: 'cancelled' });
    expect(cloud.requests).toHaveLength(0);
  });

  it('records a consumer that breaks out early as cancelled, not as a success', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [
        new MockProvider({ id: 'device', turns: [{ type: 'stream', chunks: ['a', 'b', 'c'] }] }),
      ],
      onRoute: (r) => reports.push(r),
    });
    for await (const event of router.stream(request)) {
      if (event.type === 'textDelta') break;
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]?.attempts).toEqual([
      { providerId: 'device', outcome: 'cancelled', durationMs: expect.any(Number) },
    ]);
  });
});

describe('stream telemetry', () => {
  it('reports exactly once per stream, even when nothing can serve it', async () => {
    const reports: RouteReport[] = [];
    const router = createRouter({
      providers: [
        new MockProvider({
          id: 'device',
          availability: { available: false, reason: 'notEnabled' },
        }),
      ],
      onRoute: (r) => reports.push(r),
    });
    await expect(collect(router.stream(request))).rejects.toMatchObject({ code: 'unavailable' });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      why: 'exhausted',
      fellBack: false,
      attempts: [{ providerId: 'device', outcome: 'skipped:unavailable', durationMs: 0 }],
    });
    expect(reports[0]?.providerId).toBeUndefined();
  });
});
