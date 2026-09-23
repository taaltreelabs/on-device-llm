/**
 * Shared fixtures for the context-manager tests.
 *
 * The important one is {@link wordMeasure}: a deterministic, dependency-free
 * token measure. Property tests need failures to reproduce byte for byte, and
 * `estimateTokens`' character arithmetic makes shrunk counterexamples hard to
 * read ("why is 37 over budget?"). Counting words instead means a generated
 * conversation's cost can be read straight off the page.
 */

import type { BoundedContextBudget } from '../context';
import type { Measure, Message } from '../index';

/** One token per word plus one for role framing. Mirrors `estimateTokens`' shape, not its arithmetic. */
export function countWords(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    const trimmed = message.content.trim();
    total += trimmed === '' ? 0 : trimmed.split(/\s+/).length;
    total += 1;
  }
  return total;
}

/** {@link countWords} as a {@link Measure}. */
export const wordMeasure: Measure = async (messages) => ({
  tokens: countWords(messages),
  kind: 'estimated',
  source: 'estimator',
});

/** A bounded budget of exactly `tokens`, for driving strategies directly. */
export function budgetOf(tokens: number): BoundedContextBudget {
  return {
    kind: 'bounded',
    tokens,
    contextWindow: tokens + 512 + 256,
    contextWindowAssumed: false,
    reservedForOutput: 512,
    safetyMargin: 256,
    measurementKind: 'estimated',
  };
}

/** `words(3)` → `'w0 w1 w2'`. Content whose cost is obvious at a glance. */
export function words(count: number, tag = 'w'): string {
  return Array.from({ length: count }, (_, index) => `${tag}${index}`).join(' ');
}

/** Terse conversation builder: `conv('s:hi', 'u:one two', 'a:reply')`. */
export function conv(...specs: readonly string[]): Message[] {
  return specs.map((spec) => {
    const pinned = spec.startsWith('!');
    const body = pinned ? spec.slice(1) : spec;
    const separator = body.indexOf(':');
    const role = body.slice(0, separator);
    const content = body.slice(separator + 1);
    const message: Message = {
      role: role === 's' ? 'system' : role === 'u' ? 'user' : 'assistant',
      content,
      ...(pinned ? { pinned: true } : {}),
    };
    return message;
  });
}
