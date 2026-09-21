/**
 * Budget calculation: how many tokens of *input* a request may spend.
 *
 * `budget = contextWindow - reservedForOutput - safetyMargin`
 * (docs/plan.md §5 Phase 2). Both subtrahends exist for different reasons:
 *
 * - **`reservedForOutput`**, because Apple's `contextSize` is a *combined*
 *   input+output budget (see `Capabilities.contextWindow`). Fill the window
 *   with history and the model has nowhere to write its answer.
 * - **`safetyMargin`**, because our number and the provider's number are
 *   never quite the same: schema/tool framing, a system prefix the provider
 *   adds at request time, and — when we are estimating — the estimator's own
 *   error. The default margin is **larger when the count is an estimate**.
 *
 * DECISIONS.md D9 governs the unknown case: `contextWindow` may be the
 * `UNKNOWN` sentinel, and it must never be arithmetic'd. That is why
 * {@link ContextBudget} is a discriminated union rather than a number — there
 * is no value of `budget.tokens` that honestly represents "we do not know the
 * window", and both of the tempting lies (`Infinity`, `0`) silently break
 * every caller.
 */

import { isUnknown, type UnknownValue } from '../capabilities';
import { LLMError } from '../errors';
import type { TokenMeasurementKind } from './measure';

/**
 * Default tokens held back for the model's answer: **512**.
 *
 * Chosen as "a complete chat reply, not a paragraph": roughly 350–400 English
 * words, which covers the long end of conversational answers without leaving
 * a truncated one. As a fraction of the windows this package actually sees it
 * is 12.5% of Apple's 4K variant and 6% of the 8K one — enough that a reply
 * is never the thing that overflows, small enough that a 4K device still gets
 * ~3.3K of history.
 *
 * **Set this to your `maxOutputTokens` when you send one.** The two are the
 * same quantity viewed from opposite ends, and a request that caps output at
 * 1024 while reserving 512 can still overflow mid-answer.
 */
export const DEFAULT_RESERVED_FOR_OUTPUT_TOKENS = 512;

/**
 * Default safety margin when tokens were counted exactly: **64**.
 *
 * Not zero, because an exact `countTokens(messages)` still does not see
 * everything the provider will send: a JSON schema for structured output,
 * tool declarations (Phase 3), and whatever prompt prefix the runtime adds.
 * 64 tokens covers that framing without eating meaningful history.
 */
export const DEFAULT_SAFETY_MARGIN_EXACT_TOKENS = 64;

/**
 * Default safety margin when tokens were estimated: **256**.
 *
 * `estimateTokens` divides characters by 3.5, which over-counts English prose
 * by ~15% but *under*-counts dense text — code, CJK, heavy punctuation, long
 * URLs — where real tokenizers run closer to 2 characters per token. The
 * over-count is not a margin we can rely on, because the traffic that breaks
 * the assumption is exactly the traffic that is hardest to estimate. 256
 * tokens is ~6% of a 4K window: it absorbs a few hundred characters of
 * mis-estimated dense text, which is the realistic error on the couple of
 * thousand tokens of history such a window holds.
 */
export const DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS = 256;

/** A budget over a known context window. Trimming is possible and meaningful. */
export interface BoundedContextBudget {
  readonly kind: 'bounded';
  /** Tokens available for input. Always `>= 1`. */
  readonly tokens: number;
  /** The window the budget was derived from. */
  readonly contextWindow: number;
  /**
   * `true` when {@link contextWindow} did not come from the provider but from
   * the caller's `onUnknownContextWindow` fallback — i.e. it is an assumption,
   * and an overflow from the provider should be believed over it.
   */
  readonly contextWindowAssumed: boolean;
  /** Tokens held back for the answer. */
  readonly reservedForOutput: number;
  /** Tokens held back for measurement error and provider-side framing. */
  readonly safetyMargin: number;
  /** Which margin default applied; mirrors the measurement that produced it. */
  readonly measurementKind: TokenMeasurementKind;
}

/**
 * The provider could not report a context window, so there is no budget.
 *
 * This is an explicit, typed outcome rather than a number, per DECISIONS.md
 * D9. See `FitContextOptions.onUnknownContextWindow` for what callers can do
 * about it; the default is to pass the conversation through untrimmed with a
 * warning, because trimming to an unknown limit is guessing, and refusing to
 * answer would break every cloud endpoint (none of which can report a window
 * — our own `OpenAIProvider` defaults `contextWindow` to `UNKNOWN`).
 */
export interface UnboundedContextBudget {
  readonly kind: 'unbounded';
  /** Why there is no budget. One case today; kept as a field so adding another is not a breaking change. */
  readonly reason: 'unknownContextWindow';
  /** How tokens were measured, even though nothing was compared against a limit. */
  readonly measurementKind: TokenMeasurementKind;
}

/** Either a real input budget, or an explicit "no budget known". */
export type ContextBudget = BoundedContextBudget | UnboundedContextBudget;

/**
 * Safety margin, either flat or per measurement kind.
 *
 * A bare number overrides **both** kinds — use it when you have calibrated
 * against real `usage` numbers and know exactly what you need. The object form
 * overrides one kind and leaves the other at its default.
 */
export type SafetyMarginOption =
  | number
  | {
      /** Margin when `countTokens` answered. Defaults to {@link DEFAULT_SAFETY_MARGIN_EXACT_TOKENS}. */
      readonly exact?: number;
      /** Margin when the estimator stood in. Defaults to {@link DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS}. */
      readonly estimated?: number;
    };

/** Input to {@link computeContextBudget}. */
export interface ContextBudgetInput {
  /** The provider's `capabilities().contextWindow`, `UNKNOWN` and all. */
  readonly contextWindow: number | UnknownValue;
  /**
   * How the tokens being budgeted were measured. Drives which safety-margin
   * default applies, so pass the kind from the measurement you actually
   * took, not the kind you hoped for — a provider whose exact counter threw
   * is measuring by estimate and needs the wider margin.
   */
  readonly measurementKind: TokenMeasurementKind;
  /** Defaults to {@link DEFAULT_RESERVED_FOR_OUTPUT_TOKENS}. */
  readonly reservedForOutput?: number;
  /** See {@link SafetyMarginOption}. */
  readonly safetyMargin?: SafetyMarginOption;
  /**
   * Window to use when {@link contextWindow} is `UNKNOWN`. Supplying it turns
   * an unbounded budget into a bounded one flagged `contextWindowAssumed`.
   */
  readonly assumedContextWindow?: number;
}

function resolveSafetyMargin(
  option: SafetyMarginOption | undefined,
  kind: TokenMeasurementKind
): number {
  const fallback =
    kind === 'exact' ? DEFAULT_SAFETY_MARGIN_EXACT_TOKENS : DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS;
  if (option === undefined) return fallback;
  if (typeof option === 'number') return option;
  return (kind === 'exact' ? option.exact : option.estimated) ?? fallback;
}

function requireNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new LLMError(
      { code: 'invalidRequest' },
      { message: `${name} must be a non-negative finite number, got ${String(value)}` }
    );
  }
}

/** Narrowing helper: is there a real budget to trim against? */
export function isBoundedBudget(budget: ContextBudget): budget is BoundedContextBudget {
  return budget.kind === 'bounded';
}

/**
 * Compute the input budget for one request.
 *
 * ```ts
 * const budget = computeContextBudget({
 *   contextWindow: caps.contextWindow, // number | 'unknown' — never subtracted from blindly
 *   measurementKind: 'estimated',
 *   reservedForOutput: 512,
 * });
 * if (budget.kind === 'bounded') trimTo(budget.tokens);
 * ```
 *
 * @throws LLMError `invalidRequest` when `reservedForOutput` or the resolved
 * `safetyMargin` is negative or non-finite, or when the reservations swallow
 * the whole window (`budget <= 0`). The last one is a configuration mistake,
 * not a runtime condition: no conversation can ever fit, so reporting it as
 * `contextOverflow` on every request would send the Phase 4 router chasing a
 * fallback for a bug it cannot fix.
 */
export function computeContextBudget(input: ContextBudgetInput): ContextBudget {
  const { contextWindow, measurementKind } = input;
  const reservedForOutput = input.reservedForOutput ?? DEFAULT_RESERVED_FOR_OUTPUT_TOKENS;
  const safetyMargin = resolveSafetyMargin(input.safetyMargin, measurementKind);

  requireNonNegative(reservedForOutput, 'reservedForOutput');
  requireNonNegative(safetyMargin, 'safetyMargin');

  let window: number;
  let assumed: boolean;
  if (isUnknown(contextWindow)) {
    if (input.assumedContextWindow === undefined) {
      return { kind: 'unbounded', reason: 'unknownContextWindow', measurementKind };
    }
    window = input.assumedContextWindow;
    assumed = true;
  } else {
    window = contextWindow;
    assumed = false;
  }

  if (!Number.isFinite(window) || window <= 0) {
    throw new LLMError(
      { code: 'invalidRequest' },
      {
        message: `contextWindow must be a positive finite number, got ${String(window)} (a provider reporting 0 must map it to UNKNOWN — see normalizeContextWindow and DECISIONS.md D9)`,
      }
    );
  }

  const tokens = Math.floor(window) - reservedForOutput - safetyMargin;
  if (tokens <= 0) {
    throw new LLMError(
      { code: 'invalidRequest' },
      {
        message: `context budget is ${tokens} tokens: reservedForOutput (${reservedForOutput}) + safetyMargin (${safetyMargin}) leaves no room in a window of ${Math.floor(window)}`,
      }
    );
  }

  return {
    kind: 'bounded',
    tokens,
    contextWindow: Math.floor(window),
    contextWindowAssumed: assumed,
    reservedForOutput,
    safetyMargin,
    measurementKind,
  };
}
