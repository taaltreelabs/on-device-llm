/**
 * Heuristic token estimation.
 *
 * The fallback for when `LLMProvider.countTokens` is absent or throws
 * (docs/plan.md §4: "ship a conservative heuristic estimator (characters
 * divided by roughly 3.5, configurable)"). Apple *does* expose exact
 * counting inside our OS floor (docs/research/sdk-surface.md §1), but it has
 * been observed throwing on a broken model state, and cloud providers cannot
 * count at all before the request — so the estimator is a permanent part of
 * the budget path, not a stopgap.
 */

import { LLMError } from './errors';
import type { Message } from './messages';

/**
 * Default characters per token.
 *
 * English prose runs closer to 4 characters per token, so 3.5 deliberately
 * **over**-counts by roughly 15%. That direction is the safe one: an
 * underestimate produces a `contextOverflow` from a request the caller
 * believed would fit, while an overestimate only trims one turn more than
 * strictly necessary. Code, CJK text, and heavy punctuation tokenize far
 * denser than prose, which is the other reason not to tune this toward the
 * average.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.5;

/**
 * Default per-message overhead, in tokens.
 *
 * Every message is wrapped in role framing before it reaches the model
 * (chat templates, Apple's `Transcript` entry structure). Four tokens per
 * message is the figure OpenAI documents for its chat formats and is the
 * right order of magnitude for Apple's transcript framing; it matters most
 * for long conversations of short turns, where the framing can outweigh the
 * content.
 */
export const DEFAULT_PER_MESSAGE_OVERHEAD_TOKENS = 4;

/** Tuning knobs for {@link estimateTokens}. */
export interface EstimateTokensOptions {
  /**
   * Characters per token. Lower means a more conservative (higher) estimate.
   * Defaults to {@link DEFAULT_CHARS_PER_TOKEN}. Callers that have measured
   * their own traffic against real usage numbers should set this — iOS 27
   * reports real `usage` after every generation, which is exactly the ground
   * truth needed to calibrate.
   */
  readonly charsPerToken?: number;
  /**
   * Tokens added per message for role framing. Defaults to
   * {@link DEFAULT_PER_MESSAGE_OVERHEAD_TOKENS}. Ignored when estimating a
   * bare string.
   */
  readonly perMessageOverheadTokens?: number;
}

/**
 * Estimate how many tokens a string or a message list will consume.
 *
 * Intentionally crude and intentionally pessimistic: it is a budget input,
 * not a measurement. The estimate is `ceil(chars / charsPerToken)` per unit
 * of text, plus the per-message overhead for each message (the role name is
 * counted as part of the message's characters).
 *
 * **Where the extra margin goes.** This function does not inflate its own
 * result beyond the divisor above. The Phase 2 context manager owns that
 * decision: its budget is `window - reservedForOutput - safetyMargin`, and
 * it applies a *larger* default `safetyMargin` whenever the numbers in play
 * are estimates rather than exact counts — i.e. when the provider reports
 * `tokenCounting: 'estimated'`/`'none'`, or when an exact `countTokens()`
 * call threw and this estimator stood in. Keeping the margin there rather
 * than here means one knob, at the layer that also knows the window and the
 * output reservation.
 *
 * @throws LLMError with code `invalidRequest` if `charsPerToken` is not a
 * finite positive number (silently falling back to a default would hide a
 * caller's unit mistake and quietly change every budget).
 */
export function estimateTokens(
  input: string | readonly Message[],
  options: EstimateTokensOptions = {}
): number {
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const overhead = options.perMessageOverheadTokens ?? DEFAULT_PER_MESSAGE_OVERHEAD_TOKENS;

  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new LLMError(
      { code: 'invalidRequest' },
      {
        message: `estimateTokens: charsPerToken must be a positive finite number, got ${charsPerToken}`,
      }
    );
  }
  if (!Number.isFinite(overhead) || overhead < 0) {
    throw new LLMError(
      { code: 'invalidRequest' },
      {
        message: `estimateTokens: perMessageOverheadTokens must be a non-negative finite number, got ${overhead}`,
      }
    );
  }

  if (typeof input === 'string') {
    return Math.ceil(input.length / charsPerToken);
  }

  let total = 0;
  for (const message of input) {
    total += Math.ceil((message.content.length + message.role.length) / charsPerToken) + overhead;
  }
  // A fractional `perMessageOverheadTokens` is allowed (it is an average);
  // the result never is.
  return Math.ceil(total);
}
