/**
 * `slidingWindow` — drop the oldest turns until the request fits.
 *
 * The workhorse strategy, and the floor every other strategy degrades to. No
 * model calls, no network, no state: given a budget and a way to measure, it
 * either produces a message list that fits or raises `contextOverflow`.
 */

import type { Message } from '../messages';
import type { BoundedContextBudget } from './budget';
import {
  analyzeConversation,
  type AnalyzeConversationOptions,
  type ConversationTurn,
} from './layout';
import type { Measure, TokenMeasurement } from './measure';
import { contextOverflowError, type ContextWarning, type FitContextResult } from './result';
import { isSummaryMessage } from './summary';
import type { SystemStateOutcome } from './system-state';

/**
 * Everything a strategy needs that is not strategy-specific: a real budget,
 * a way to measure, and the conventions for reading the conversation.
 *
 * `fitContext` assembles one of these from a provider; the strategies take it
 * directly so tests can drive them with a deterministic measurer.
 */
export interface StrategyEnvironment extends AnalyzeConversationOptions {
  /** The input budget. Bounded by construction — an unbounded budget means there is nothing to trim *to*. */
  readonly budget: BoundedContextBudget;
  /** How to measure a candidate list. */
  readonly measure: Measure;
  /** Attached to any `contextOverflow` this pass raises, so the Phase 4 router can attribute it. */
  readonly providerId?: string;
  /**
   * Measurement of the full input, if the caller already took it. Saves one
   * measurement — which matters when measuring means a native bridge call.
   */
  readonly inputMeasurement?: TokenMeasurement;
  /** Passed straight through to the result; `fitContext` fills it in. */
  readonly systemState?: SystemStateOutcome;
  /** Warnings accumulated before this strategy ran. */
  readonly warnings?: readonly ContextWarning[];
  /**
   * Cancels any work the strategy starts (the rolling summary's model call).
   * `slidingWindow` does no I/O of its own and ignores it.
   */
  readonly signal?: AbortSignal;
}

/** Options for {@link slidingWindow}. Nothing beyond the shared environment. */
export type SlidingWindowOptions = StrategyEnvironment;

/** Pick the messages at `keep`, preserving original order. */
export function projectMessages(
  messages: readonly Message[],
  keep: ReadonlySet<number>
): readonly Message[] {
  return messages.filter((_, index) => keep.has(index));
}

/**
 * Drop the oldest turns until the conversation fits the budget.
 *
 * ### What it will and will not do
 *
 * - **Pinned messages are never dropped** (see `analyzeConversation` for what
 *   counts as pinned). They are also never *counted against* the decision to
 *   trim — if they alone exceed the budget, no amount of trimming helps and
 *   the pass raises `contextOverflow`.
 * - **Turns are dropped whole, oldest first**, which is what guarantees no
 *   orphaned assistant message: an assistant can only survive together with
 *   the user message(s) it answered.
 * - **The newest turn is never dropped.** It is the request being made;
 *   dropping it would produce a well-formed prompt asking nothing.
 * - **A rolling summary is an ordinary turn here** and can be dropped like
 *   any other. It is the oldest thing in the list, so it goes first — losing
 *   compressed history rather than the recent verbatim history the user is
 *   actually talking about. That trade is reported as a `summaryDropped`
 *   warning rather than made silently.
 *
 * ### Cost
 *
 * One measurement for the full list, then one per dropped turn — at most
 * `turns + 1` in the worst case, and exactly one in the common case where
 * nothing needs trimming. Turns are dropped one at a time rather than
 * estimated in bulk because a provider's counter is not additive (per-message
 * framing is the provider's business), so the only honest way to know whether
 * a candidate fits is to measure that candidate.
 *
 * @throws LLMError `contextOverflow` when the pinned messages plus the newest
 * turn exceed the budget, carrying the measured `tokenCount` and the budget as
 * `contextSize`. Thrown rather than returned so it routes exactly like a
 * provider's own overflow: the Phase 4 router already treats `contextOverflow`
 * as a fallback trigger, and a result object saying "impossible" is too easy
 * to pass straight to `generate()`.
 */
export async function slidingWindow(
  messages: readonly Message[],
  options: SlidingWindowOptions
): Promise<FitContextResult> {
  const { budget, measure, providerId } = options;
  const layout = analyzeConversation(messages, options);
  const warnings: ContextWarning[] = [...(options.warnings ?? [])];

  const inputMeasurement = options.inputMeasurement ?? (await measure(messages));
  noteCounterFailure(inputMeasurement, warnings);

  const keep = new Set<number>(messages.map((_, index) => index));
  const droppedIndices: number[] = [];
  let measurement = inputMeasurement;

  // Every turn except the newest is a candidate, oldest first.
  const droppable: readonly ConversationTurn[] = layout.turns.slice(0, -1);
  let nextToDrop = 0;

  while (measurement.tokens > budget.tokens && nextToDrop < droppable.length) {
    for (const index of droppable[nextToDrop].indices) {
      keep.delete(index);
      droppedIndices.push(index);
      if (isSummaryMessage(messages[index], options.summaryMarker)) {
        warnings.push({
          code: 'summaryDropped',
          message:
            'A rolling summary was dropped to fit the budget; history older than the remaining turns is now lost.',
        });
      }
    }
    nextToDrop += 1;
    measurement = await measure(projectMessages(messages, keep));
    noteCounterFailure(measurement, warnings);
  }

  // `dropped` is documented as "in original order" (result.ts). Turns are
  // dropped oldest-turn-first, but an R7-merged turn's indices are not
  // contiguous — `[user, assistant, system, assistant]` merges into indices
  // [0, 1, 3] beside a system block [2] — so concatenation order is not
  // input order. Found by the fast-check property "reports every removed
  // message in `dropped`, exactly once" (seed 507863177), roughly one run in
  // a dozen; every earlier "phantom flake" in this suite was this bug.
  const dropped: Message[] = droppedIndices
    .sort((a, b) => a - b)
    .map((index) => messages[index]);

  if (measurement.tokens > budget.tokens) {
    throw contextOverflowError({
      tokenCount: measurement.tokens,
      budgetTokens: budget.tokens,
      ...(providerId !== undefined ? { providerId } : {}),
    });
  }

  return {
    messages: projectMessages(messages, keep),
    budget,
    measurement,
    inputMeasurement,
    withinBudget: true,
    strategy: 'slidingWindow',
    dropped,
    systemState: options.systemState ?? { applied: false },
    warnings,
  };
}

/**
 * Record a counter failure once per pass. Exported for the rolling-summary
 * strategy, which measures on its own before delegating.
 */
export function noteCounterFailure(
  measurement: TokenMeasurement,
  warnings: ContextWarning[]
): void {
  if (measurement.source !== 'estimatorAfterCounterFailure') return;
  if (warnings.some((warning) => warning.code === 'tokenCounterFailed')) return;
  warnings.push({
    code: 'tokenCounterFailed',
    message:
      "The provider's countTokens failed; token counts are estimates and the wider safety margin applies.",
    ...(measurement.cause !== undefined ? { cause: measurement.cause } : {}),
  });
}
