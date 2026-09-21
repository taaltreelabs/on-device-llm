/**
 * Budget calculation and token measurement — the two inputs every strategy
 * depends on, and the two places DECISIONS.md D9 has already burned us once.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  computeContextBudget,
  createMeasure,
  isBoundedBudget,
  measureMessages,
  DEFAULT_RESERVED_FOR_OUTPUT_TOKENS,
  DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS,
  DEFAULT_SAFETY_MARGIN_EXACT_TOKENS,
} from '../index';
import { LLMError, UNKNOWN, estimateTokens, isLLMError, type Message } from '../index';

const messages: Message[] = [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'hello there' },
];

describe('computeContextBudget', () => {
  it('is window - reservedForOutput - safetyMargin', () => {
    const budget = computeContextBudget({
      contextWindow: 4096,
      measurementKind: 'exact',
      reservedForOutput: 512,
      safetyMargin: 64,
    });
    expect(budget).toMatchObject({ kind: 'bounded', tokens: 4096 - 512 - 64, contextWindow: 4096 });
  });

  it('uses a larger default safety margin for estimated counts than exact ones', () => {
    const exact = computeContextBudget({ contextWindow: 4096, measurementKind: 'exact' });
    const estimated = computeContextBudget({ contextWindow: 4096, measurementKind: 'estimated' });
    if (!isBoundedBudget(exact) || !isBoundedBudget(estimated)) throw new Error('unreachable');

    expect(exact.safetyMargin).toBe(DEFAULT_SAFETY_MARGIN_EXACT_TOKENS);
    expect(estimated.safetyMargin).toBe(DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS);
    expect(estimated.safetyMargin).toBeGreaterThan(exact.safetyMargin);
    expect(estimated.tokens).toBeLessThan(exact.tokens);
    expect(exact.reservedForOutput).toBe(DEFAULT_RESERVED_FOR_OUTPUT_TOKENS);
  });

  it('takes a flat safetyMargin override for both kinds, or a per-kind one', () => {
    const flat = computeContextBudget({
      contextWindow: 1000,
      measurementKind: 'estimated',
      safetyMargin: 10,
    });
    expect(flat).toMatchObject({ safetyMargin: 10 });

    const perKind = computeContextBudget({
      contextWindow: 1000,
      measurementKind: 'estimated',
      safetyMargin: { exact: 1 },
    });
    // Only `exact` was overridden; the estimated default still applies.
    expect(perKind).toMatchObject({ safetyMargin: DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS });
  });

  it("returns an explicit unbounded budget for an 'unknown' window instead of arithmetic (D9)", () => {
    const budget = computeContextBudget({ contextWindow: UNKNOWN, measurementKind: 'estimated' });
    expect(budget).toEqual({
      kind: 'unbounded',
      reason: 'unknownContextWindow',
      measurementKind: 'estimated',
    });
    expect(isBoundedBudget(budget)).toBe(false);
    // The two tempting lies are both absent.
    expect(JSON.stringify(budget)).not.toContain('Infinity');
    expect(budget).not.toHaveProperty('tokens');
  });

  it('honours an assumed window, and flags that it is an assumption', () => {
    const budget = computeContextBudget({
      contextWindow: UNKNOWN,
      measurementKind: 'exact',
      assumedContextWindow: 2048,
      reservedForOutput: 0,
      safetyMargin: 0,
    });
    expect(budget).toMatchObject({ kind: 'bounded', tokens: 2048, contextWindowAssumed: true });
  });

  it('rejects a configuration that leaves no room, as invalidRequest not contextOverflow', () => {
    try {
      computeContextBudget({
        contextWindow: 512,
        measurementKind: 'exact',
        reservedForOutput: 512,
        safetyMargin: 64,
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(isLLMError(error, 'invalidRequest')).toBe(true);
      expect((error as LLMError).message).toContain('leaves no room');
    }
  });

  it('rejects negative reservations and a non-positive window', () => {
    expect(() =>
      computeContextBudget({ contextWindow: 4096, measurementKind: 'exact', reservedForOutput: -1 })
    ).toThrow(/reservedForOutput/);
    expect(() =>
      computeContextBudget({ contextWindow: 4096, measurementKind: 'exact', safetyMargin: -1 })
    ).toThrow(/safetyMargin/);
    // A provider that reports 0 should have mapped it to UNKNOWN itself.
    expect(() => computeContextBudget({ contextWindow: 0, measurementKind: 'exact' })).toThrow(
      /positive finite number/
    );
  });
});

describe('createMeasure', () => {
  it("prefers the provider's counter and reports it as exact", async () => {
    const countTokens = vi.fn(async () => 42);
    const measurement = await measureMessages(messages, { countTokens, tokenCounting: 'exact' });
    expect(measurement).toEqual({ tokens: 42, kind: 'exact', source: 'providerExact' });
    expect(countTokens).toHaveBeenCalledOnce();
  });

  it('does not call a counter the provider admits is a guess without saying so', async () => {
    const measurement = await measureMessages(messages, {
      countTokens: async () => 42,
      tokenCounting: 'estimated',
    });
    expect(measurement).toEqual({ tokens: 42, kind: 'estimated', source: 'providerEstimated' });
  });

  it('falls back to estimateTokens when there is no counter', async () => {
    const measurement = await measureMessages(messages);
    expect(measurement).toEqual({
      tokens: estimateTokens(messages),
      kind: 'estimated',
      source: 'estimator',
    });
  });

  it('falls back and keeps going when countTokens throws (DECISIONS.md D9, ModelManagerError 1013)', async () => {
    const failure = new LLMError({ code: 'unknown', transient: true }, { message: 'error 1013' });
    const onCounterError = vi.fn();
    const measure = createMeasure({
      countTokens: async () => {
        throw failure;
      },
      tokenCounting: 'exact',
      onCounterError,
    });

    const measurement = await measure(messages);
    expect(measurement.kind).toBe('estimated');
    expect(measurement.source).toBe('estimatorAfterCounterFailure');
    expect(measurement.tokens).toBe(estimateTokens(messages));
    expect(measurement.cause).toBe(failure);
    expect(onCounterError).toHaveBeenCalledWith(failure);
  });

  it('latches after a failure so one pass does not re-call a wedged counter', async () => {
    const countTokens = vi.fn(async () => {
      throw new Error('wedged');
    });
    const measure = createMeasure({ countTokens, tokenCounting: 'exact' });
    await measure(messages);
    await measure(messages);
    await measure(messages);
    expect(countTokens).toHaveBeenCalledOnce();
  });

  it('can be told not to latch', async () => {
    const countTokens = vi.fn(async () => {
      throw new Error('flaky');
    });
    const measure = createMeasure({
      countTokens,
      tokenCounting: 'exact',
      latchCounterFailure: false,
    });
    await measure(messages);
    await measure(messages);
    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it('treats a nonsensical count as a failure rather than as data', async () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const measurement = await measureMessages(messages, {
        countTokens: async () => bad,
        tokenCounting: 'exact',
      });
      expect(measurement.source).toBe('estimatorAfterCounterFailure');
    }
  });

  it('rounds a fractional count up rather than rejecting it', async () => {
    const measurement = await measureMessages(messages, {
      countTokens: async () => 10.2,
      tokenCounting: 'exact',
    });
    expect(measurement).toMatchObject({ tokens: 11, kind: 'exact' });
  });

  it('propagates an abort instead of silently estimating', async () => {
    const cancelled = new LLMError({ code: 'cancelled' });
    const measure = createMeasure({
      countTokens: async () => {
        throw cancelled;
      },
      tokenCounting: 'exact',
    });
    await expect(measure(messages)).rejects.toBe(cancelled);

    const aborted = createMeasure({
      countTokens: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      tokenCounting: 'exact',
    });
    await expect(aborted(messages)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('measures an empty list as 0 without touching the provider', async () => {
    const countTokens = vi.fn(async () => 99);
    const measurement = await measureMessages([], { countTokens, tokenCounting: 'exact' });
    expect(measurement).toEqual({ tokens: 0, kind: 'exact', source: 'providerExact' });
    expect(countTokens).not.toHaveBeenCalled();
  });
});
