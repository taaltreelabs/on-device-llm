/**
 * Token measurement for the context manager.
 *
 * Two rules drive everything here (docs/plan.md §5 Phase 2):
 *
 * 1. **Prefer the provider's own counter, fall back to the estimator.** Only
 *    the provider knows its per-message framing, and Apple can count exactly
 *    (`tokenCount(for:)`, inside our OS floor). A cloud endpoint cannot count
 *    before the request, so `estimateTokens` is a permanent part of the path,
 *    not a stopgap.
 * 2. **Carry *how* the number was obtained.** The safety margin is larger for
 *    estimates, and callers (and the Phase 4 `useChat`) want to know whether
 *    the number they are shown is a measurement or a guess. A bare `number`
 *    loses that, so every measurement is a {@link TokenMeasurement}.
 *
 * The failure mode this module exists to absorb: DECISIONS.md D9 records
 * `countTokens` throwing `ModelManagerError 1013` on a live, "available"
 * device. A trimming pass must not die because the counter had a bad day — it
 * falls back to the estimate, says so in `source`, and the budget widens its
 * margin accordingly.
 */

import type { TokenCounting } from '../capabilities';
import { isAbortError, isLLMError, LLMError } from '../errors';
import { estimateTokens, type EstimateTokensOptions } from '../estimate-tokens';
import type { Message } from '../messages';

/**
 * Whether a token count came from a real tokenizer or from a heuristic.
 *
 * Deliberately narrower than {@link TokenCounting}: `'none'` is not a kind of
 * measurement, it is the absence of a counter, and it resolves to
 * `'estimated'` the moment anyone actually measures something.
 */
export type TokenMeasurementKind = 'exact' | 'estimated';

/**
 * Where a measurement came from. Finer-grained than
 * {@link TokenMeasurementKind}, because "we estimated because there is no
 * counter" and "we estimated because the counter threw" mean very different
 * things when you are debugging why a conversation got trimmed.
 */
export type TokenMeasurementSource =
  /** `LLMProvider.countTokens`, from a provider reporting `tokenCounting: 'exact'`. */
  | 'providerExact'
  /** `LLMProvider.countTokens`, from a provider that admits its counter is itself a heuristic. */
  | 'providerEstimated'
  /** `estimateTokens` — the provider has no counter (`tokenCounting: 'none'`). */
  | 'estimator'
  /** `estimateTokens` — the provider had a counter and it threw or returned nonsense (DECISIONS.md D9). */
  | 'estimatorAfterCounterFailure';

/** A token count, plus the provenance that tells you how much to trust it. */
export interface TokenMeasurement {
  /** Token count. Always a non-negative integer. */
  readonly tokens: number;
  /** Whether {@link tokens} is a real count or a heuristic. */
  readonly kind: TokenMeasurementKind;
  /** How the count was obtained. */
  readonly source: TokenMeasurementSource;
  /**
   * The error the provider's counter threw, when `source` is
   * `'estimatorAfterCounterFailure'`. Preserved verbatim so callers can log
   * it; the context manager itself only needs to know that it happened.
   */
  readonly cause?: unknown;
}

/**
 * Measure a candidate message list.
 *
 * Async because the provider's counter is (it may cross a native bridge).
 * Every strategy takes one of these rather than a provider, so tests can
 * drive the strategies with a deterministic counter and reproduce failures
 * exactly.
 */
export type Measure = (messages: readonly Message[]) => Promise<TokenMeasurement>;

/** Options for {@link createMeasure} / {@link measureMessages}. */
export interface CreateMeasureOptions {
  /**
   * The provider's counter, usually `provider.countTokens?.bind(provider)`.
   * Omit for estimate-only measurement.
   */
  readonly countTokens?: (messages: readonly Message[]) => Promise<number>;
  /**
   * The provider's `capabilities().tokenCounting`, which says how much to
   * trust {@link countTokens}. Defaults to `'exact'` when a counter was
   * supplied and `'none'` when it was not — but pass the real value: a
   * provider that reports `'estimated'` (our own `OpenAIProvider` does, since
   * it counts with `estimateTokens` locally) should not have its numbers
   * treated as exact, because that halves the safety margin.
   */
  readonly tokenCounting?: TokenCounting;
  /** Tuning passed through to `estimateTokens` on the fallback path. */
  readonly estimate?: EstimateTokensOptions;
  /**
   * Called once per counter failure, before falling back. For telemetry only
   * — never for control flow, and it must not throw.
   */
  readonly onCounterError?: (error: unknown) => void;
  /**
   * After the counter fails once, stop calling it for the remaining lifetime
   * of this {@link Measure}. Defaults to `true`.
   *
   * A single `fitContext` pass measures once per dropped turn; a wedged model
   * (D9) would otherwise fail the same way on every one of those calls, each
   * of them possibly a slow bridge round-trip. Latching also keeps a single
   * pass *self-consistent*: every number in one trimming decision then comes
   * from the same measuring device. Set `false` if your counter's failures
   * are genuinely independent.
   */
  readonly latchCounterFailure?: boolean;
}

function estimated(
  messages: readonly Message[],
  options: CreateMeasureOptions,
  source: 'estimator' | 'estimatorAfterCounterFailure',
  cause?: unknown
): TokenMeasurement {
  return {
    tokens: estimateTokens(messages, options.estimate),
    kind: 'estimated',
    source,
    ...(cause !== undefined ? { cause } : {}),
  };
}

/**
 * Build a {@link Measure} that prefers a provider's counter and degrades to
 * `estimateTokens`.
 *
 * ```ts
 * const measure = createMeasure({
 *   countTokens: provider.countTokens?.bind(provider),
 *   tokenCounting: (await provider.capabilities()).tokenCounting,
 * });
 * const { tokens, kind } = await measure(messages);
 * ```
 *
 * Behaviour worth knowing:
 *
 * - An **empty list measures 0** without calling the provider. Zero messages
 *   cost zero tokens under any tokenizer, and some endpoints reject an empty
 *   request outright.
 * - A counter that resolves to a negative, fractional, or non-finite number is
 *   treated as a **failure**, not as data. Fractions are rounded up on the way
 *   in, so a counter returning `10.2` is honoured as `11`.
 * - **Aborts propagate.** If the counter rejects with `cancelled` (or a
 *   web-standard `AbortError`), the caller asked to stop, and silently
 *   producing an estimate instead would continue work they cancelled.
 *
 * The returned function holds one piece of mutable state — the failure latch
 * (see {@link CreateMeasureOptions.latchCounterFailure}) — so build a fresh
 * one per trimming pass rather than caching it across requests. `fitContext`
 * does exactly that.
 */
export function createMeasure(options: CreateMeasureOptions = {}): Measure {
  const { countTokens } = options;
  const tokenCounting: TokenCounting =
    options.tokenCounting ?? (countTokens === undefined ? 'none' : 'exact');
  const latch = options.latchCounterFailure ?? true;
  const counterKind: TokenMeasurementKind = tokenCounting === 'exact' ? 'exact' : 'estimated';
  const counterSource: TokenMeasurementSource =
    tokenCounting === 'exact' ? 'providerExact' : 'providerEstimated';

  let counterFailed = false;

  return async (messages: readonly Message[]): Promise<TokenMeasurement> => {
    if (countTokens === undefined || tokenCounting === 'none') {
      return estimated(messages, options, 'estimator');
    }
    if (counterFailed) {
      return estimated(messages, options, 'estimatorAfterCounterFailure');
    }
    if (messages.length === 0) {
      return { tokens: 0, kind: counterKind, source: counterSource };
    }

    try {
      const tokens = await countTokens(messages);
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
        throw new LLMError(
          { code: 'invalidRequest' },
          {
            message: `countTokens must resolve to a non-negative finite number, got ${String(tokens)}`,
          }
        );
      }
      return { tokens: Math.ceil(tokens), kind: counterKind, source: counterSource };
    } catch (error) {
      if (isAbortError(error) || isLLMError(error, 'cancelled')) throw error;
      if (latch) counterFailed = true;
      options.onCounterError?.(error);
      return estimated(messages, options, 'estimatorAfterCounterFailure', error);
    }
  };
}

/**
 * One-shot convenience over {@link createMeasure}, for callers who want a
 * single number (with provenance) and no reusable measurer.
 */
export function measureMessages(
  messages: readonly Message[],
  options: CreateMeasureOptions = {}
): Promise<TokenMeasurement> {
  return createMeasure(options)(messages);
}
