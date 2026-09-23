/**
 * Phase 2 acceptance against a live `fm serve` (docs/plan.md §5: "an
 * integration test against `fm serve` that runs a conversation well past the
 * window without an overflow error").
 *
 * The provider is told `contextWindow: 1024` — far smaller than anything the
 * real model has — so a dozen short turns comfortably exceed it. That is the
 * point: the deliberately small window makes the context manager do real work
 * against a real model rather than against a mock, and a regression that lets
 * history grow unbounded fails here as a `contextOverflow`.
 *
 * Skipped cleanly when `fm serve` is not reachable, following the same
 * two-probe pattern as `src/openai/__tests__/fm-serve.integration.test.ts`
 * (DECISIONS.md D8, D9: a server can accept connections while every real
 * generation fails).
 */
import { describe, expect, it } from 'vitest';

import { createOpenAIProvider } from '../../openai';
import { fitContext, isSummaryMessage, type FitContextResult, type Message } from '../index';

const BASE_URL = process.env.FM_SERVE_URL ?? 'http://127.0.0.1:1976/v1';
const MODEL = process.env.FM_SERVE_MODEL ?? 'system';
const PROBE_TIMEOUT_MS = 5_000;

/** A small enough window that a short conversation outgrows it within a few turns. */
const CONTEXT_WINDOW = 1024;
const RESERVED_FOR_OUTPUT = 512;
const SAFETY_MARGIN = 128;
const BUDGET = CONTEXT_WINDOW - RESERVED_FOR_OUTPUT - SAFETY_MARGIN;

async function probeFmServe(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
  try {
    await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `fm serve unreachable at ${BASE_URL}: ${String(err)}` };
  }
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
    `[fm-serve-context.integration.test] Skipping suite: ${probe.reason}\n` +
      '  This is expected when fm serve is not running, or when the on-device stack is' +
      ' wedged (see DECISIONS.md D9); it is not a bug in this package.'
  );
}

/** Deliberately wordy so the conversation outgrows 1024 tokens in about ten turns. */
const QUESTIONS = [
  'I am planning a short trip. My first stop is Rotterdam. Answer in one short sentence: is Rotterdam a port city?',
  'My second stop is Lyon. Answer in one short sentence: is Lyon known for food?',
  'My third stop is Porto. Answer in one short sentence: is Porto on a river?',
  'My fourth stop is Bergen. Answer in one short sentence: does Bergen get a lot of rain?',
  'My fifth stop is Seville. Answer in one short sentence: is Seville hot in summer?',
  'My sixth stop is Gdansk. Answer in one short sentence: is Gdansk on the Baltic?',
  'My seventh stop is Turin. Answer in one short sentence: is Turin near the Alps?',
  'My eighth stop is Ghent. Answer in one short sentence: does Ghent have canals?',
  'My ninth stop is Tampere. Answer in one short sentence: is Tampere in Finland?',
  'My tenth stop is Cardiff. Answer in one short sentence: is Cardiff in Wales?',
  'My eleventh stop is Bilbao. Answer in one short sentence: does Bilbao have a famous museum?',
  'My twelfth stop is Trieste. Answer in one short sentence: is Trieste near Slovenia?',
];

describe.skipIf(!probe.ok)('context manager against a live fm serve', () => {
  it('holds a conversation well past a 1024-token window with slidingWindow and no contextOverflow', async () => {
    const provider = createOpenAIProvider({
      baseUrl: BASE_URL,
      model: MODEL,
      // The real model's window is much larger; we lie small on purpose so
      // the context manager has to work.
      contextWindow: CONTEXT_WINDOW,
    });

    const systemPrompt: Message = {
      role: 'system',
      content: 'You are a terse travel assistant. Answer in one short sentence.',
    };
    const pinnedFact: Message = {
      role: 'user',
      content: 'Remember for the whole conversation: my travel code is ZQ-7.',
      pinned: true,
    };

    let history: Message[] = [systemPrompt, pinnedFact];
    const passes: FitContextResult[] = [];

    for (const question of QUESTIONS) {
      history = [...history, { role: 'user', content: question }];

      const fitted = await fitContext(history, {
        provider,
        reservedForOutput: RESERVED_FOR_OUTPUT,
        safetyMargin: SAFETY_MARGIN,
      });
      passes.push(fitted);

      expect(fitted.budget).toMatchObject({ kind: 'bounded', tokens: BUDGET });
      expect(fitted.measurement.tokens).toBeLessThanOrEqual(BUDGET);
      // The pinned messages are still there, whatever else went.
      expect(fitted.messages).toContain(systemPrompt);
      expect(fitted.messages).toContain(pinnedFact);
      // The question being asked is always in the request.
      expect(fitted.messages[fitted.messages.length - 1].content).toBe(question);

      const answer = await provider.generate({
        messages: fitted.messages,
        maxOutputTokens: 64,
      });
      expect(answer.text.trim().length).toBeGreaterThan(0);

      history = [...history, { role: 'assistant', content: answer.text }];
    }

    // The conversation really did outgrow the window: without trimming, the
    // last request would have been well over budget.
    const last = passes[passes.length - 1];
    expect(last.inputMeasurement.tokens).toBeGreaterThan(BUDGET);
    expect(passes.some((pass) => pass.dropped.length > 0)).toBe(true);
    // ...and nothing ever raised contextOverflow: reaching here is the assertion.
    expect(passes).toHaveLength(QUESTIONS.length);
  }, 240_000);

  it('summarizes with an injected provider and keeps answering', async () => {
    const provider = createOpenAIProvider({
      baseUrl: BASE_URL,
      model: MODEL,
      contextWindow: CONTEXT_WINDOW,
    });
    // The same endpoint stands in for the cloud summarizer here; in an app
    // this is where a bigger cloud model would go.
    const summarizer = createOpenAIProvider({
      baseUrl: BASE_URL,
      model: MODEL,
      id: 'summarizer',
    });

    let history: Message[] = [
      {
        role: 'system',
        content: 'You are a terse travel assistant. Answer in one short sentence.',
      },
    ];
    let sawSummary = false;

    for (const question of QUESTIONS.slice(0, 8)) {
      history = [...history, { role: 'user', content: question }];

      const fitted = await fitContext(history, {
        provider,
        reservedForOutput: RESERVED_FOR_OUTPUT,
        safetyMargin: SAFETY_MARGIN,
        strategy: {
          type: 'rollingSummary',
          summarizer,
          threshold: 0.6,
          keepRecentTurns: 2,
          maxSummaryTokens: 120,
        },
      });

      expect(fitted.measurement.tokens).toBeLessThanOrEqual(BUDGET);

      if (fitted.summary !== undefined) {
        sawSummary = true;
        // Exactly one summary message, and it is recognisable as one.
        const summaries = fitted.messages.filter((message) => isSummaryMessage(message));
        expect(summaries).toHaveLength(1);
        // Adopt it, as the docs recommend, so the next pass re-summarizes it
        // together with the newly-aged turns rather than re-deriving it.
        const replaced = new Set<Message>(fitted.summary.replaced);
        const at = history.findIndex((message) => replaced.has(message));
        history = [
          ...history.slice(0, at),
          fitted.summary.message,
          ...history.slice(at).filter((message) => !replaced.has(message)),
        ];
      }

      const answer = await provider.generate({ messages: fitted.messages, maxOutputTokens: 64 });
      expect(answer.text.trim().length).toBeGreaterThan(0);
      history = [...history, { role: 'assistant', content: answer.text }];
    }

    expect(sawSummary).toBe(true);
    // At most one summary survives in the adopted history.
    expect(history.filter((message) => isSummaryMessage(message)).length).toBeLessThanOrEqual(1);
  }, 240_000);
});
