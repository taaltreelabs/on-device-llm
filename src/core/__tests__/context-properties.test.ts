/**
 * Property-style tests for the context manager (docs/plan.md §5 Phase 2
 * acceptance: "property-style tests showing the output never exceeds budget,
 * pinned messages always survive, and pairs are never split").
 *
 * These are the tests that matter most in this phase. The unit tests check the
 * shapes we thought of; these check the ones we did not — conversations that
 * start with an assistant message, three user messages in a row, a pinned
 * message wedged between a question and its answer, a budget that happens to
 * land exactly on a turn boundary.
 *
 * Everything is driven by {@link wordMeasure}, a deterministic word counter, so
 * a shrunk counterexample reproduces byte for byte and can be read off the
 * page. `estimateTokens`' character arithmetic is exercised separately in the
 * unit tests; mixing it in here would only make failures harder to read.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  analyzeConversation,
  fitContext,
  isLLMError,
  isSummaryMessage,
  rollingSummary,
  slidingWindow,
  MockProvider,
  type ConversationLayout,
  type FitContextResult,
  type Message,
} from '../index';
import { budgetOf, countWords, wordMeasure } from './context-helpers';

// ---------------------------------------------------------------- arbitraries

/**
 * Unconstrained conversations: any role in any order, any pin flag. Most of
 * these are shapes no UI would produce, which is exactly why they are
 * generated — the strategies must not assume tidy alternation.
 */
const freeform = fc.array(
  fc.record({
    role: fc.constantFrom<Message['role']>('system', 'user', 'assistant'),
    length: fc.integer({ min: 0, max: 10 }),
    pinned: fc.boolean(),
  }),
  { minLength: 0, maxLength: 24 }
);

/**
 * Plausible chat transcripts: an optional system prompt, then turns that are
 * usually `user` + `assistant` but sometimes ragged (a double question, a
 * two-part answer, a trailing question awaiting a reply).
 */
const realistic = fc
  .tuple(
    fc.boolean(),
    fc.array(
      fc.record({
        users: fc.integer({ min: 1, max: 3 }),
        assistants: fc.integer({ min: 0, max: 2 }),
        length: fc.integer({ min: 1, max: 12 }),
        // Pinned roughly one turn in ten — common enough to be exercised,
        // rare enough that most conversations still have something to drop.
        pinned: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
      }),
      { minLength: 0, maxLength: 10 }
    )
  )
  .map(([hasSystem, turns]) => {
    const parts: { role: Message['role']; length: number; pinned: boolean }[] = [];
    if (hasSystem) parts.push({ role: 'system', length: 6, pinned: false });
    for (const turn of turns) {
      for (let i = 0; i < turn.users; i += 1) {
        parts.push({ role: 'user', length: turn.length, pinned: turn.pinned && i === 0 });
      }
      for (let i = 0; i < turn.assistants; i += 1) {
        parts.push({ role: 'assistant', length: turn.length, pinned: false });
      }
    }
    return parts;
  });

/**
 * Turn a spec into messages whose content is unique per position, so the
 * assertions below can identify a message by value as well as by reference.
 */
function build(parts: readonly { role: Message['role']; length: number; pinned: boolean }[]) {
  return parts.map((part, index) => {
    const content = Array.from({ length: part.length }, (_, w) => `m${index}w${w}`).join(' ');
    const message: Message = {
      role: part.role,
      content,
      ...(part.pinned ? { pinned: true } : {}),
    };
    return message;
  });
}

const conversation = fc.oneof(freeform, realistic).map(build);

/** Conversation plus a budget drawn independently of its size. */
const conversationAndBudget = fc.tuple(conversation, fc.integer({ min: 1, max: 160 }));

// ------------------------------------------------------------------ invariants

/** Messages of the output that also appear in the input, by reference. */
function survivors(input: readonly Message[], output: readonly Message[]): readonly Message[] {
  const known = new Set(input);
  return output.filter((message) => known.has(message));
}

function assertSubsequence(input: readonly Message[], output: readonly Message[]): void {
  let cursor = 0;
  for (const message of survivors(input, output)) {
    const found = input.indexOf(message, cursor);
    expect(
      found,
      'output must preserve input order and contain no duplicates'
    ).toBeGreaterThanOrEqual(cursor);
    cursor = found + 1;
  }
}

function assertPinnedSurvive(
  input: readonly Message[],
  output: readonly Message[],
  layout: ConversationLayout
): void {
  const pinned = layout.pinnedIndices.map((index) => input[index]);
  const kept = output.filter((message) => pinned.includes(message));
  expect(kept, 'every pinned message must survive, in order').toEqual(pinned);
}

function assertTurnsAtomic(
  input: readonly Message[],
  output: readonly Message[],
  layout: ConversationLayout
): void {
  const kept = new Set(output);
  for (const turn of layout.turns) {
    const present = turn.indices.filter((index) => kept.has(input[index]));
    if (present.length === 0 || present.length === turn.indices.length) continue;
    throw new Error(
      `turn ${JSON.stringify(turn.indices)} was split: kept ${JSON.stringify(present)} — ` +
        'a partially kept turn is how an assistant message gets orphaned'
    );
  }
}

function assertNoOrphanedAssistant(input: readonly Message[], output: readonly Message[]): void {
  // Checked against the input rather than the layout code, so a bug in
  // `analyzeConversation` cannot make this pass vacuously: an assistant
  // message with no user message before it in the *output* is only legal if it
  // had none before it in the *input* either — the seeded-greeting shape (R4).
  let seenUser = false;
  for (const message of output) {
    if (message.role === 'user') {
      seenUser = true;
      continue;
    }
    // An explicitly pinned assistant is exempt: the caller asked for it to
    // survive whatever else goes, which is a stronger instruction than
    // pairing, and they did not pin the user message beside it.
    if (message.role !== 'assistant' || seenUser || message.pinned === true) continue;
    const index = input.indexOf(message);
    const hadUserBefore =
      index !== -1 && input.slice(0, index).some((earlier) => earlier.role === 'user');
    expect(hadUserBefore, 'an assistant message must never outlive the user turn it answered').toBe(
      false
    );
  }
}

/** All of the above, for a pass that returned rather than overflowed. */
function assertFitted(
  input: readonly Message[],
  result: FitContextResult,
  budgetTokens: number,
  options?: Parameters<typeof analyzeConversation>[1]
): void {
  const layout = analyzeConversation(input, options);
  expect(countWords(result.messages)).toBeLessThanOrEqual(budgetTokens);
  assertPinnedSurvive(input, result.messages, layout);
  assertTurnsAtomic(input, result.messages, layout);
  assertNoOrphanedAssistant(input, result.messages);
  assertSubsequence(input, result.messages);
}

/** The cost of the smallest list a strategy is allowed to return. */
function minimumCost(messages: readonly Message[]): number {
  const layout = analyzeConversation(messages);
  const newest = layout.turns[layout.turns.length - 1]?.indices ?? [];
  const keep = new Set([...layout.pinnedIndices, ...newest]);
  return countWords(messages.filter((_, index) => keep.has(index)));
}

// ------------------------------------------------------------------ properties

describe('slidingWindow properties', () => {
  it('fits the budget, keeps pinned messages, and never splits a turn (500 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(conversationAndBudget, async ([messages, tokens]) => {
        let result: FitContextResult;
        try {
          result = await slidingWindow(messages, {
            budget: budgetOf(tokens),
            measure: wordMeasure,
          });
        } catch (error) {
          // The only legal failure, and only when it was genuinely impossible.
          expect(isLLMError(error, 'contextOverflow')).toBe(true);
          expect(minimumCost(messages)).toBeGreaterThan(tokens);
          return;
        }
        assertFitted(messages, result, tokens);
      }),
      { numRuns: 500 }
    );
  });

  it('overflows exactly when the pinned messages plus the newest turn do not fit (500 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(conversationAndBudget, async ([messages, tokens]) => {
        const satisfiable = minimumCost(messages) <= tokens;
        const run = slidingWindow(messages, { budget: budgetOf(tokens), measure: wordMeasure });
        if (satisfiable) {
          // Never a silent over-budget result on the satisfiable side.
          const result = await run;
          expect(countWords(result.messages)).toBeLessThanOrEqual(tokens);
        } else {
          await expect(run).rejects.toMatchObject({ code: 'contextOverflow' });
        }
      }),
      { numRuns: 500 }
    );
  });

  it('reports every removed message in `dropped`, exactly once (300 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(conversationAndBudget, async ([messages, tokens]) => {
        let result: FitContextResult;
        try {
          result = await slidingWindow(messages, {
            budget: budgetOf(tokens),
            measure: wordMeasure,
          });
        } catch {
          return;
        }
        const kept = new Set(result.messages);
        const expected = messages.filter((message) => !kept.has(message));
        expect(result.dropped).toEqual(expected);
      }),
      { numRuns: 300 }
    );
  });

  it('is deterministic and never mutates its input (200 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(conversationAndBudget, async ([messages, tokens]) => {
        const snapshot = JSON.stringify(messages);
        const run = async () =>
          slidingWindow(messages, { budget: budgetOf(tokens), measure: wordMeasure }).catch(
            (error: unknown) =>
              isLLMError(error, 'contextOverflow') ? 'overflow' : Promise.reject(error)
          );
        const first = await run();
        const second = await run();
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        expect(JSON.stringify(messages)).toBe(snapshot);
      }),
      { numRuns: 200 }
    );
  });

  it('honours every pinSystemMessages mode (300 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationAndBudget,
        fc.constantFrom('first' as const, 'all' as const, 'none' as const),
        async ([messages, tokens], pinSystemMessages) => {
          let result: FitContextResult;
          try {
            result = await slidingWindow(messages, {
              budget: budgetOf(tokens),
              measure: wordMeasure,
              pinSystemMessages,
            });
          } catch (error) {
            expect(isLLMError(error, 'contextOverflow')).toBe(true);
            return;
          }
          assertFitted(messages, result, tokens, { pinSystemMessages });
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('rollingSummary properties', () => {
  /** A summarizer scripted to answer every call with a short, fixed gist. */
  const gist = () =>
    new MockProvider({
      id: 'cloud',
      turns: Array.from({ length: 4 }, () => ({ type: 'result' as const, text: 'gist of it' })),
    });

  it('fits, keeps pinned messages, and injects at most one summary (300 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationAndBudget,
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 4 }),
        async ([messages, tokens], threshold, keepRecentTurns) => {
          let result: FitContextResult;
          try {
            result = await rollingSummary(messages, {
              budget: budgetOf(tokens),
              measure: wordMeasure,
              summarizer: gist(),
              threshold,
              keepRecentTurns,
            });
          } catch (error) {
            expect(isLLMError(error, 'contextOverflow')).toBe(true);
            return;
          }

          const layout = analyzeConversation(messages);
          // Injected messages are the only thing that may not come from the input.
          const injected = result.messages.filter((message) => !messages.includes(message));
          expect(injected.length).toBeLessThanOrEqual(1);
          for (const message of injected) expect(isSummaryMessage(message)).toBe(true);

          assertPinnedSurvive(messages, result.messages, layout);
          assertSubsequence(messages, result.messages);
          assertNoOrphanedAssistant(messages, result.messages);

          // Below the threshold nothing is touched; above it, the result fits.
          if (result.summary !== undefined || result.dropped.length > 0) {
            expect(countWords(result.messages)).toBeLessThanOrEqual(tokens);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it('never leaves more than one summary message behind, however often it runs (200 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(conversationAndBudget, async ([messages, tokens]) => {
        let current: readonly Message[] = messages;
        for (let pass = 0; pass < 3; pass += 1) {
          try {
            const result = await rollingSummary(current, {
              budget: budgetOf(tokens),
              measure: wordMeasure,
              summarizer: gist(),
              threshold: 0.5,
              keepRecentTurns: 1,
            });
            current = result.messages;
          } catch (error) {
            expect(isLLMError(error, 'contextOverflow')).toBe(true);
            return;
          }
          expect(current.filter((message) => isSummaryMessage(message)).length).toBeLessThanOrEqual(
            1
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  it('degrades to slidingWindow rather than failing when the summarizer is down (200 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(conversationAndBudget, async ([messages, tokens]) => {
        // An empty script makes every summarizer call fail (invalidRequest).
        const broken = new MockProvider({ id: 'cloud' });
        let result: FitContextResult;
        try {
          result = await rollingSummary(messages, {
            budget: budgetOf(tokens),
            measure: wordMeasure,
            summarizer: broken,
            threshold: 0.5,
          });
        } catch (error) {
          expect(isLLMError(error, 'contextOverflow')).toBe(true);
          expect(minimumCost(messages)).toBeGreaterThan(tokens);
          return;
        }
        expect(result.summary).toBeUndefined();
        assertFitted(messages, result, tokens);
      }),
      { numRuns: 200 }
    );
  });
});

describe('fitContext properties', () => {
  it('never returns an over-budget result against real estimateTokens arithmetic (300 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        conversation,
        fc.integer({ min: 600, max: 4096 }),
        async (messages, contextWindow) => {
          const provider = new MockProvider({ capabilities: { contextWindow } });
          let result: FitContextResult;
          try {
            result = await fitContext(messages, { provider, reservedForOutput: 128 });
          } catch (error) {
            expect(isLLMError(error, 'contextOverflow')).toBe(true);
            return;
          }
          if (result.budget.kind !== 'bounded') throw new Error('expected a bounded budget');
          expect(result.measurement.tokens).toBeLessThanOrEqual(result.budget.tokens);
          expect(result.withinBudget).toBe(true);
          assertSubsequence(messages, result.messages);
          assertNoOrphanedAssistant(messages, result.messages);
        }
      ),
      { numRuns: 300 }
    );
  });
});
