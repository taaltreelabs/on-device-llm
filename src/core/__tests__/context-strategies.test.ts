/**
 * `slidingWindow` and `rollingSummary`, driven directly with a deterministic
 * word-count measure so every budget in this file can be checked by eye.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createSummaryMessage,
  isLLMError,
  isSummaryMessage,
  rollingSummary,
  slidingWindow,
  summaryText,
  LLMError,
  MockProvider,
  type Message,
} from '../index';
import { budgetOf, conv, countWords, wordMeasure, words } from './context-helpers';

const env = (tokens: number) => ({ budget: budgetOf(tokens), measure: wordMeasure });

describe('slidingWindow', () => {
  it('returns the conversation untouched when it already fits', async () => {
    const messages = conv('s:prompt', 'u:hello', 'a:hi');
    const result = await slidingWindow(messages, env(100));
    expect(result.messages).toEqual(messages);
    expect(result.dropped).toEqual([]);
    expect(result.withinBudget).toBe(true);
    expect(result.strategy).toBe('slidingWindow');
  });

  it('drops the oldest turns, whole, until it fits', async () => {
    const messages = conv(
      's:sys',
      `u:${words(10, 'q1')}`,
      `a:${words(10, 'r1')}`,
      `u:${words(10, 'q2')}`,
      `a:${words(10, 'r2')}`,
      `u:${words(10, 'q3')}`
    );
    // Room for the system prompt (2) + the newest turn (11) + one full pair (22).
    const result = await slidingWindow(messages, env(36));
    expect(result.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(result.dropped).toEqual([messages[1], messages[2]]);
    expect(countWords(result.messages)).toBeLessThanOrEqual(36);
  });

  it('never orphans an assistant message: pairs go together or not at all', async () => {
    const messages = conv(`u:${words(20, 'q1')}`, `a:${words(20, 'r1')}`, 'u:short');
    const result = await slidingWindow(messages, env(25));
    // There is no budget at which `r1` survives without `q1`.
    expect(result.messages).toEqual([messages[2]]);
  });

  it('never drops pinned messages, and keeps them in order', async () => {
    const messages = conv(
      's:sys',
      `u:${words(20, 'old')}`,
      `a:${words(20, 'oldr')}`,
      '!u:pinned fact',
      'u:new'
    );
    const result = await slidingWindow(messages, env(20));
    expect(result.messages.map((message) => message.content)).toEqual([
      'sys',
      'pinned fact',
      'new',
    ]);
  });

  it('never drops the newest turn', async () => {
    const messages = conv('u:a b c', 'a:d e f', `u:${words(5, 'newest')}`);
    const result = await slidingWindow(messages, env(7));
    expect(result.messages).toEqual([messages[2]]);
  });

  it('raises contextOverflow, with real numbers, when pinned + newest cannot fit', async () => {
    const messages = conv('!s:' + words(30, 'sys'), 'u:hello');
    try {
      await slidingWindow(messages, { ...env(10), providerId: 'apple' });
      throw new Error('expected a throw');
    } catch (error) {
      if (!isLLMError(error, 'contextOverflow')) throw error;
      expect(error.details.contextSize).toBe(10);
      expect(error.details.tokenCount).toBe(countWords(messages));
      expect(error.providerId).toBe('apple');
    }
  });

  it('reports dropped messages in original order even across an R7-merged turn', async () => {
    // fast-check counterexample (seed 507863177): the leading assistant run
    // and the assistant after the system blocks merge into one turn with
    // non-contiguous indices [0, 3], straddling system blocks [1(pinned), 2].
    // Building `dropped` in turn order emitted [msg0, msg3, msg2]; the
    // documented contract (result.ts) is original input order.
    const messages = conv('a:', 's:', 's:', 'a:', 's:m4w0 m4w1 m4w2');
    const result = await slidingWindow(messages, env(5));
    const kept = new Set(result.messages);
    expect(result.dropped).toEqual(messages.filter((message) => !kept.has(message)));
  });

  it('overflows rather than returning a doomed request even with nothing to drop', async () => {
    await expect(slidingWindow(conv('u:' + words(50)), env(10))).rejects.toMatchObject({
      code: 'contextOverflow',
    });
    await expect(slidingWindow([], { ...env(0.5), budget: budgetOf(0) })).resolves.toMatchObject({
      messages: [],
    });
  });

  it('measures once when nothing needs trimming, and once per dropped turn otherwise', async () => {
    const measure = vi.fn(wordMeasure);
    await slidingWindow(conv('u:a', 'a:b'), { budget: budgetOf(100), measure });
    expect(measure).toHaveBeenCalledOnce();

    measure.mockClear();
    const long = conv(
      'u:' + words(10),
      'a:' + words(10),
      'u:' + words(10),
      'a:' + words(10),
      'u:x'
    );
    await slidingWindow(long, { budget: budgetOf(25), measure });
    expect(measure).toHaveBeenCalledTimes(2); // input + one drop

    measure.mockClear();
    await slidingWindow(long, { budget: budgetOf(13), measure });
    expect(measure).toHaveBeenCalledTimes(3); // input + two drops
  });

  it('warns when it has to drop a rolling summary to make room', async () => {
    const messages: Message[] = [
      createSummaryMessage(words(20, 'sum')),
      ...conv('u:' + words(5, 'q'), 'a:' + words(5, 'r'), 'u:newest'),
    ];
    const result = await slidingWindow(messages, env(14));
    expect(result.warnings.map((warning) => warning.code)).toContain('summaryDropped');
    expect(result.messages.some((message) => isSummaryMessage(message))).toBe(false);
  });

  it('surfaces a failing countTokens as a warning instead of failing the pass', async () => {
    const measure = vi.fn(async (list: readonly Message[]) => ({
      tokens: countWords(list),
      kind: 'estimated' as const,
      source: 'estimatorAfterCounterFailure' as const,
      cause: new Error('ModelManagerError 1013'),
    }));
    const result = await slidingWindow(conv('u:a'), { budget: budgetOf(50), measure });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('tokenCounterFailed');
    expect(result.warnings[0].cause).toBeInstanceOf(Error);
  });
});

/** A summarizer that always answers with the same text. */
function summarizer(text: string, id = 'cloud'): MockProvider {
  return new MockProvider({ id, turns: [{ type: 'result', text }] });
}

describe('rollingSummary', () => {
  const longConversation = () =>
    conv(
      's:sys',
      'u:' + words(10, 'q1'),
      'a:' + words(10, 'r1'),
      'u:' + words(10, 'q2'),
      'a:' + words(10, 'r2'),
      'u:' + words(10, 'q3'),
      'a:' + words(10, 'r3'),
      'u:newest'
    );

  it('does nothing below the threshold, and does not call the summarizer', async () => {
    const provider = summarizer('should not be used');
    const messages = longConversation();
    const result = await rollingSummary(messages, {
      ...env(1000),
      summarizer: provider,
    });
    expect(result.messages).toEqual(messages);
    expect(result.summary).toBeUndefined();
    expect(provider.calls).toEqual([]);
  });

  it('replaces the older turns with one summary and keeps the recent ones verbatim', async () => {
    const messages = longConversation();
    const result = await rollingSummary(messages, {
      ...env(80),
      threshold: 0.5,
      keepRecentTurns: 2,
      summarizer: summarizer('The user asked q1 and q2.'),
    });

    expect(result.summary).toBeDefined();
    // Four turns, two kept verbatim: q1/r1 and q2/r2 are compressed.
    expect(result.summary?.replaced).toEqual(messages.slice(1, 5));
    expect(result.messages.map((message) => message.content)).toEqual([
      'sys',
      '[summary of earlier conversation]\nThe user asked q1 and q2.',
      messages[5].content,
      messages[6].content,
      'newest',
    ]);
    // The system prompt stays first; the summary lands where the old turns were.
    expect(result.messages[0]).toBe(messages[0]);
  });

  it('sends the older turns (not the recent ones) to the summarizer', async () => {
    const provider = summarizer('ok');
    const messages = longConversation();
    await rollingSummary(messages, {
      ...env(80),
      threshold: 0.5,
      keepRecentTurns: 2,
      summarizer: provider,
    });
    const sent = provider.requests[0].messages.map((message) => message.content).join('\n');
    expect(sent).toContain(messages[1].content);
    expect(sent).not.toContain('newest');
  });

  it('folds a previous summary into the new one instead of accumulating summaries', async () => {
    const provider = summarizer('merged summary');
    const messages: Message[] = [
      ...conv('s:sys'),
      createSummaryMessage('older facts'),
      ...conv(
        'u:' + words(10, 'q1'),
        'a:' + words(10, 'r1'),
        'u:' + words(10, 'q2'),
        'a:' + words(10, 'r2'),
        'u:newest'
      ),
    ];
    const result = await rollingSummary(messages, {
      ...env(60),
      threshold: 0.5,
      keepRecentTurns: 2,
      summarizer: provider,
    });

    expect(result.summary?.previousSummary).toBe('older facts');
    // The old summary is among the replaced messages, so exactly one remains.
    expect(result.summary?.replaced).toContain(messages[1]);
    expect(result.messages.filter((message) => isSummaryMessage(message))).toHaveLength(1);
    expect(summaryText(result.messages[1])).toBe('merged summary');
    // The previous summary reached the prompt rather than being silently lost.
    const sent = provider.requests[0].messages.map((message) => message.content).join('\n');
    expect(sent).toContain('older facts');
  });

  it('degrades to slidingWindow when the summarizer fails, and says so', async () => {
    const provider = new MockProvider({
      id: 'cloud',
      turns: [{ type: 'error', error: new LLMError({ code: 'network' }) }],
    });
    const messages = longConversation();
    const result = await rollingSummary(messages, {
      ...env(40),
      threshold: 0.5,
      summarizer: provider,
    });

    expect(result.summary).toBeUndefined();
    expect(result.warnings.map((warning) => warning.code)).toContain('summarizerFailed');
    expect(result.warnings[0].cause).toBeInstanceOf(LLMError);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(countWords(result.messages)).toBeLessThanOrEqual(40);
  });

  it('degrades when the summarizer answers with nothing usable', async () => {
    const result = await rollingSummary(longConversation(), {
      ...env(40),
      threshold: 0.5,
      summarizer: summarizer('   '),
    });
    expect(result.warnings.map((warning) => warning.code)).toContain('summarizerEmpty');
  });

  it('re-throws on onSummarizerError: "throw"', async () => {
    const failure = new LLMError({ code: 'network' });
    const provider = new MockProvider({ turns: [{ type: 'error', error: failure }] });
    await expect(
      rollingSummary(longConversation(), {
        ...env(40),
        threshold: 0.5,
        summarizer: provider,
        onSummarizerError: 'throw',
      })
    ).rejects.toBe(failure);
  });

  it('propagates an abort whatever the error policy says', async () => {
    const cancelled = new LLMError({ code: 'cancelled' });
    const provider = new MockProvider({ turns: [{ type: 'error', error: cancelled }] });
    await expect(
      rollingSummary(longConversation(), {
        ...env(40),
        threshold: 0.5,
        summarizer: provider,
        onSummarizerError: 'slidingWindow',
      })
    ).rejects.toBe(cancelled);
  });

  it('falls back when everything is inside the verbatim tail', async () => {
    const messages = conv('u:' + words(30, 'q'), 'a:' + words(30, 'r'), 'u:newest');
    const result = await rollingSummary(messages, {
      ...env(20),
      threshold: 0.5,
      keepRecentTurns: 5,
      summarizer: summarizer('unused'),
    });
    expect(result.warnings.map((warning) => warning.code)).toContain('nothingToSummarize');
    expect(result.messages).toEqual([messages[2]]);
  });

  it('trims further when even the summarized conversation is too big', async () => {
    const messages = conv(
      'u:' + words(10, 'q1'),
      'a:' + words(10, 'r1'),
      'u:' + words(10, 'q2'),
      'a:' + words(10, 'r2'),
      'u:newest'
    );
    const result = await rollingSummary(messages, {
      ...env(12),
      threshold: 0.5,
      keepRecentTurns: 2,
      summarizer: summarizer(words(30, 'verbose')),
    });
    expect(result.strategy).toBe('rollingSummary');
    expect(result.summary).toBeDefined();
    expect(countWords(result.messages)).toBeLessThanOrEqual(12);
  });

  it('raises contextOverflow when nothing can make it fit', async () => {
    const messages = conv('!s:' + words(50, 'sys'), 'u:' + words(10, 'q'), 'a:r', 'u:newest');
    await expect(
      rollingSummary(messages, { ...env(10), threshold: 0.5, summarizer: summarizer('x') })
    ).rejects.toMatchObject({ code: 'contextOverflow' });
  });

  it('mutates nothing', async () => {
    const messages = longConversation();
    const snapshot = JSON.parse(JSON.stringify(messages));
    await rollingSummary(messages, {
      ...env(80),
      threshold: 0.5,
      summarizer: summarizer('summary'),
    });
    expect(JSON.parse(JSON.stringify(messages))).toEqual(snapshot);
  });

  it('boundary: exactly at the threshold does not summarize, one token over does', async () => {
    const messages = conv('u:' + words(9, 'q'), 'a:' + words(9, 'r'), 'u:' + words(8, 'n'));
    const tokens = countWords(messages); // 30
    const atThreshold = await rollingSummary(messages, {
      budget: budgetOf(tokens * 2),
      measure: wordMeasure,
      threshold: 0.5, // trigger = tokens, measurement === trigger
      summarizer: summarizer('unused'),
    });
    expect(atThreshold.summary).toBeUndefined();

    const overThreshold = await rollingSummary(messages, {
      budget: budgetOf(tokens * 2 - 2),
      measure: wordMeasure,
      threshold: 0.5,
      keepRecentTurns: 1,
      summarizer: summarizer('summary'),
    });
    expect(overThreshold.summary).toBeDefined();
  });
});
