/**
 * `fitContext` — resolution of provider limits, the unknown-window policy, and
 * strategy dispatch.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  fitContext,
  isLLMError,
  isSummaryMessage,
  LLMError,
  MockProvider,
  UNKNOWN,
  DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS,
  DEFAULT_SAFETY_MARGIN_EXACT_TOKENS,
  type Message,
} from '../index';
import { conv, countWords, wordMeasure, words } from './context-helpers';

const counting = (messages: readonly Message[]) => countWords(messages);

describe('fitContext', () => {
  it('reads the window and the counter off the provider', async () => {
    const provider = new MockProvider({
      capabilities: { contextWindow: 1000, tokenCounting: 'exact' },
      countTokens: counting,
    });
    const messages = conv('s:sys', 'u:hello there');
    const result = await fitContext(messages, {
      provider,
      reservedForOutput: 100,
      safetyMargin: 0,
    });

    expect(result.budget).toMatchObject({ kind: 'bounded', tokens: 900, contextWindow: 1000 });
    expect(result.measurement).toMatchObject({ kind: 'exact', source: 'providerExact' });
    expect(result.messages).toEqual(messages);
  });

  it('calls capabilities() once per pass', async () => {
    const provider = new MockProvider({ capabilities: { contextWindow: 1000 } });
    const spy = vi.spyOn(provider, 'capabilities');
    await fitContext(conv('u:hi'), { provider });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('skips capabilities() entirely when both values are supplied', async () => {
    const provider = new MockProvider();
    const spy = vi.spyOn(provider, 'capabilities');
    await fitContext(conv('u:hi'), { provider, contextWindow: 4096, tokenCounting: 'none' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('works with no provider at all, estimating', async () => {
    const result = await fitContext(conv('u:hi'), { contextWindow: 4096 });
    expect(result.measurement.source).toBe('estimator');
    expect(result.budget).toMatchObject({ kind: 'bounded' });
  });

  describe('unknown contextWindow (DECISIONS.md D9)', () => {
    const provider = () => new MockProvider({ capabilities: { contextWindow: UNKNOWN } });

    it('passes the conversation through untrimmed, with a warning, by default', async () => {
      const messages = conv('u:' + words(5000));
      const result = await fitContext(messages, { provider: provider() });

      expect(result.messages).toEqual(messages);
      expect(result.budget).toEqual({
        kind: 'unbounded',
        reason: 'unknownContextWindow',
        measurementKind: 'estimated',
      });
      expect(result.withinBudget).toBe(UNKNOWN);
      expect(result.strategy).toBe('none');
      expect(result.warnings.map((warning) => warning.code)).toEqual(['unknownContextWindow']);
      // Never silently Infinity, never silently 0.
      expect(result.budget).not.toHaveProperty('tokens');
    });

    it('still reports the measured token count so the caller can decide', async () => {
      const result = await fitContext(conv('u:hello world'), { provider: provider() });
      expect(result.measurement.tokens).toBeGreaterThan(0);
      expect(result.measurement).toBe(result.inputMeasurement);
    });

    it("fails loudly under onUnknownContextWindow: 'error'", async () => {
      await expect(
        fitContext(conv('u:hi'), { provider: provider(), onUnknownContextWindow: 'error' })
      ).rejects.toMatchObject({ code: 'invalidRequest' });
    });

    it('trims against an assumed window when one is configured', async () => {
      const result = await fitContext(conv('u:' + words(40, 'q'), 'a:r', 'u:newest'), {
        provider: provider(),
        assumedContextWindow: 100,
        reservedForOutput: 0,
        safetyMargin: 0,
        measure: wordMeasure,
      });
      expect(result.budget).toMatchObject({ contextWindowAssumed: true, tokens: 100 });
      expect(result.strategy).toBe('slidingWindow');
    });
  });

  it('widens the margin when an exact counter fails mid-request', async () => {
    // The provider advertises exact counting, then throws — the budget must
    // pick up the *estimated* margin, not the narrow exact one.
    const failing = new MockProvider({
      capabilities: { contextWindow: 4096, tokenCounting: 'exact' },
      countTokens: new LLMError({ code: 'unknown', transient: true }, { message: 'error 1013' }),
    });
    const result = await fitContext(conv('u:hi'), { provider: failing });

    expect(result.measurement.source).toBe('estimatorAfterCounterFailure');
    expect(result.budget).toMatchObject({
      measurementKind: 'estimated',
      safetyMargin: DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS,
    });
    expect(result.warnings.map((warning) => warning.code)).toContain('tokenCounterFailed');

    const healthy = new MockProvider({
      capabilities: { contextWindow: 4096, tokenCounting: 'exact' },
      countTokens: counting,
    });
    const good = await fitContext(conv('u:hi'), { provider: healthy });
    expect(good.budget).toMatchObject({ safetyMargin: DEFAULT_SAFETY_MARGIN_EXACT_TOKENS });
  });

  it('renders the app state slot into the system prompt, inside the budget', async () => {
    const provider = new MockProvider({ capabilities: { contextWindow: 1000 } });
    const result = await fitContext(conv('s:You are a task assistant.', 'u:what is left?'), {
      provider,
      measure: wordMeasure,
      systemState: () => '- [ ] Renew passport',
    });

    expect(result.messages[0].content).toContain('[current state]\n- [ ] Renew passport');
    expect(result.systemState).toMatchObject({ applied: true, placement: 'systemPrompt' });
    expect(result.measurement.tokens).toBe(countWords(result.messages));
  });

  it('dispatches to rollingSummary, and to a custom strategy', async () => {
    const summarizer = new MockProvider({ id: 'cloud', turns: [{ type: 'result', text: 'gist' }] });
    const messages = conv(
      'u:' + words(10, 'q1'),
      'a:' + words(10, 'r1'),
      'u:' + words(10, 'q2'),
      'a:' + words(10, 'r2'),
      'u:newest'
    );
    const summarized = await fitContext(messages, {
      contextWindow: 60,
      reservedForOutput: 0,
      safetyMargin: 0,
      measure: wordMeasure,
      strategy: { type: 'rollingSummary', summarizer, threshold: 0.5, keepRecentTurns: 2 },
    });
    expect(summarized.strategy).toBe('rollingSummary');
    expect(summarized.messages.some((message) => isSummaryMessage(message))).toBe(true);

    const custom = await fitContext(messages, {
      contextWindow: 1000,
      measure: wordMeasure,
      strategy: async (list, environment) => ({
        messages: list.slice(-1),
        budget: environment.budget,
        measurement: await environment.measure(list.slice(-1)),
        inputMeasurement: await environment.measure(list),
        withinBudget: true,
        strategy: 'slidingWindow',
        dropped: [],
        systemState: { applied: false },
        warnings: [],
      }),
    });
    expect(custom.strategy).toBe('custom');
    expect(custom.messages).toHaveLength(1);
  });

  it('attaches the provider id to a contextOverflow it raises', async () => {
    const provider = new MockProvider({ id: 'apple', capabilities: { contextWindow: 1000 } });
    try {
      await fitContext(conv('!s:' + words(60, 'sys'), 'u:hi'), {
        provider,
        contextWindow: 50,
        reservedForOutput: 0,
        safetyMargin: 0,
        measure: wordMeasure,
      });
      throw new Error('expected a throw');
    } catch (error) {
      if (!isLLMError(error, 'contextOverflow')) throw error;
      expect(error.providerId).toBe('apple');
      expect(error.details.contextSize).toBe(50);
    }
  });

  it('handles the empty and only-system conversations', async () => {
    const provider = new MockProvider({ capabilities: { contextWindow: 1000 } });
    const empty = await fitContext([], { provider });
    expect(empty.messages).toEqual([]);
    expect(empty.measurement.tokens).toBe(0);

    const onlySystem = await fitContext(conv('s:be brief'), { provider });
    expect(onlySystem.messages).toHaveLength(1);
    expect(onlySystem.dropped).toEqual([]);
  });

  it('mutates neither the array nor its messages', async () => {
    const messages = conv('s:sys', 'u:' + words(20), 'a:' + words(20), 'u:newest');
    const snapshot = JSON.parse(JSON.stringify(messages));
    await fitContext(messages, {
      contextWindow: 15,
      reservedForOutput: 0,
      safetyMargin: 0,
      measure: wordMeasure,
      systemState: () => 'state',
    });
    expect(JSON.parse(JSON.stringify(messages))).toEqual(snapshot);
  });
});
