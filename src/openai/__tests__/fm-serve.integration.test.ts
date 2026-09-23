/**
 * Integration tests against a live `fm serve` (docs/plan.md §5 Phase 1,
 * DECISIONS.md D8). Targets `process.env.FM_SERVE_URL ?? 'http://127.0.0.1:1976/v1'`.
 *
 * `fm serve` is a local-dev-only test rig (D8) — never a shipped
 * dependency — so this suite runs opportunistically: it probes reachability
 * *and* a real completion before deciding whether to run at all, and skips
 * cleanly with a clear reason otherwise. Two probes, not one, because D9's
 * lesson generalizes here too: a server can accept connections (health
 * passes) while every real generation 500s (as has been directly observed
 * on the maintainer's Mac — `SensitiveContentAnalysisML error 15` — the
 * exact scenario this suite must not hang or fail CI on).
 *
 * Schemas used below deliberately avoid recursive `$defs` — D8 records that
 * those hang `fm serve` *permanently*, surviving past the offending
 * request, so a broken test here would poison every later local run.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createOpenAIProvider } from '../index';

const BASE_URL = process.env.FM_SERVE_URL ?? 'http://127.0.0.1:1976/v1';
const MODEL = process.env.FM_SERVE_MODEL ?? 'system';
const PROBE_TIMEOUT_MS = 5_000;

async function probeFmServe(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
  // Health: can we even reach the server?
  try {
    await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `fm serve unreachable at ${BASE_URL}: ${String(err)}` };
  }

  // Generation: can it actually answer? Health alone is not sufficient
  // (DECISIONS.md D9) — the stack has been observed reporting healthy while
  // every real generation 500s.
  try {
    const provider = createOpenAIProvider({ baseUrl: BASE_URL, model: MODEL });
    const result = await provider.generate(
      {
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        maxOutputTokens: 8,
      },
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
    );
    if (result.text.trim() === '') {
      return { ok: false, reason: 'fm serve answered with empty text on the completion probe' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `fm serve completion probe failed: ${String(err)}` };
  }
}

const probe = await probeFmServe();

if (!probe.ok) {
  console.warn(
    `[fm-serve.integration.test] Skipping suite: ${probe.reason}\n` +
      `  This is expected when fm serve is not running, or when the on-device stack is` +
      ' wedged (see DECISIONS.md D9); it is not a bug in this package.'
  );
}

describe.skipIf(!probe.ok)('OpenAIProvider against a live fm serve', () => {
  afterAll(() => {
    // Nothing to tear down — the provider is stateless per docs/plan.md §2.
  });

  it('holds a multi-turn non-streaming conversation', async () => {
    const provider = createOpenAIProvider({ baseUrl: BASE_URL, model: MODEL });
    const first = await provider.generate({
      messages: [{ role: 'user', content: 'My favorite color is teal. Just acknowledge briefly.' }],
    });
    expect(first.text.length).toBeGreaterThan(0);
    expect(first.providerId).toBe('openai');

    const second = await provider.generate({
      messages: [
        { role: 'user', content: 'My favorite color is teal. Just acknowledge briefly.' },
        { role: 'assistant', content: first.text },
        { role: 'user', content: 'What color did I say? Answer with one word.' },
      ],
    });
    expect(second.text.toLowerCase()).toContain('teal');
  });

  it('streams a response with correct delta accumulation', async () => {
    const provider = createOpenAIProvider({ baseUrl: BASE_URL, model: MODEL });
    let accumulated = '';
    let finishSeen = false;
    for await (const event of provider.stream({
      messages: [{ role: 'user', content: 'Count from one to five, comma-separated.' }],
    })) {
      if (event.type === 'textDelta') accumulated += event.delta;
      if (event.type === 'finish') {
        finishSeen = true;
        expect(event.result.text).toBe(accumulated);
      }
    }
    expect(finishSeen).toBe(true);
    expect(accumulated.length).toBeGreaterThan(0);
  });

  it('cancels mid-stream and surfaces LLMError code cancelled', async () => {
    const provider = createOpenAIProvider({ baseUrl: BASE_URL, model: MODEL });
    const controller = new AbortController();
    const iterate = async () => {
      let count = 0;
      for await (const event of provider.stream(
        { messages: [{ role: 'user', content: 'Write a long story about a lighthouse keeper.' }] },
        { signal: controller.signal }
      )) {
        if (event.type === 'textDelta') {
          count += 1;
          if (count === 1) controller.abort();
        }
      }
    };
    await expect(iterate()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('produces schema-valid structured output', async () => {
    const provider = createOpenAIProvider({ baseUrl: BASE_URL, model: MODEL });
    const schema = {
      type: 'object',
      title: 'Greeting',
      properties: {
        greeting: { type: 'string' },
      },
      required: ['greeting'],
      additionalProperties: false,
    };
    const result = await provider.generate({
      messages: [{ role: 'user', content: 'Produce a short greeting.' }],
      schema,
    });
    expect(result.object).toBeDefined();
    expect(typeof (result.object as { greeting?: unknown }).greeting).toBe('string');
  });
});
