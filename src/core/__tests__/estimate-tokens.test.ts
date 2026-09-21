import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_PER_MESSAGE_OVERHEAD_TOKENS,
  estimateTokens,
  isLLMError,
  type Message,
} from '../index';

describe('estimateTokens', () => {
  it('estimates a string as ceil(chars / 3.5) by default', () => {
    expect(DEFAULT_CHARS_PER_TOKEN).toBe(3.5);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('1234567')).toBe(2); // 7 / 3.5
    expect(estimateTokens('12345678')).toBe(3); // rounds up, never down
  });

  it('is conservative: it over-counts ordinary prose rather than under-counting', () => {
    const prose = 'The quick brown fox jumps over the lazy dog.'; // 44 chars, ~10 real tokens
    const realistic = Math.ceil(prose.length / 4);
    expect(estimateTokens(prose)).toBeGreaterThan(realistic);
  });

  it('adds a per-message overhead and counts the role name', () => {
    const messages: readonly Message[] = [{ role: 'user', content: 'Hallo' }];
    // ceil((5 + 4) / 3.5) + 4
    expect(estimateTokens(messages)).toBe(Math.ceil(9 / 3.5) + DEFAULT_PER_MESSAGE_OVERHEAD_TOKENS);
    expect(DEFAULT_PER_MESSAGE_OVERHEAD_TOKENS).toBe(4);
  });

  it('grows monotonically with the conversation and always returns an integer', () => {
    const history: Message[] = [];
    let previous = estimateTokens(history);
    expect(previous).toBe(0);
    for (const content of ['een', 'twee', 'drie brede zinnen hier', 'vier']) {
      history.push({ role: 'user', content });
      const current = estimateTokens(history);
      expect(current).toBeGreaterThan(previous);
      expect(Number.isInteger(current)).toBe(true);
      previous = current;
    }
  });

  it('ignores the pinned flag (it is metadata for the context manager, not content)', () => {
    const pinned: readonly Message[] = [{ role: 'system', content: 'Be terse.', pinned: true }];
    const plain: readonly Message[] = [{ role: 'system', content: 'Be terse.' }];
    expect(estimateTokens(pinned)).toBe(estimateTokens(plain));
  });

  it('accepts a configurable divisor and overhead', () => {
    expect(estimateTokens('12345678', { charsPerToken: 4 })).toBe(2);
    const messages: readonly Message[] = [{ role: 'user', content: 'x' }];
    expect(estimateTokens(messages, { charsPerToken: 1, perMessageOverheadTokens: 0 })).toBe(5);
    // A lower divisor is a more conservative estimate.
    expect(estimateTokens('abcdefgh', { charsPerToken: 2 })).toBeGreaterThan(
      estimateTokens('abcdefgh', { charsPerToken: 8 })
    );
  });

  it('rejects nonsense tuning loudly rather than falling back to defaults', () => {
    for (const charsPerToken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => estimateTokens('abc', { charsPerToken })).toThrowError(/charsPerToken/);
      try {
        estimateTokens('abc', { charsPerToken });
      } catch (err) {
        expect(isLLMError(err, 'invalidRequest')).toBe(true);
      }
    }
    expect(() => estimateTokens('abc', { perMessageOverheadTokens: -1 })).toThrowError(
      /perMessageOverheadTokens/
    );
  });
});
