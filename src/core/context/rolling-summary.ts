/**
 * `rollingSummary` — compress the older part of the conversation with a model
 * instead of throwing it away.
 *
 * The summarizer is a plain `LLMProvider` supplied by the caller, which is the
 * whole point of injecting it: an app can chat on-device and summarize in the
 * cloud, where the bigger window makes compressing a long history cheap and
 * the latency is hidden behind a turn the user is already waiting through
 * (docs/plan.md §5 Phase 2).
 */

import { isLLMError, LLMError } from '../errors';
import type { Message } from '../messages';
import type { LLMProvider } from '../provider';
import { analyzeConversation, type ConversationTurn } from './layout';
import type { TokenMeasurement } from './measure';
import { type ContextWarning, type FitContextResult, type SummaryOutcome } from './result';
import { noteCounterFailure, slidingWindow, type StrategyEnvironment } from './sliding-window';
import {
  createSummaryMessage,
  DEFAULT_MAX_SUMMARY_TOKENS,
  defaultSummaryPrompt,
  isSummaryMessage,
  summaryText,
  type SummaryPromptBuilder,
} from './summary';

/** Default fraction of the budget at which summarization kicks in. */
export const DEFAULT_SUMMARY_THRESHOLD = 0.7;

/** Default number of most-recent turns kept verbatim. */
export const DEFAULT_KEEP_RECENT_TURNS = 2;

/** What to do when the summarizer call fails. */
export type SummarizerErrorPolicy =
  /** Degrade to `slidingWindow` for this request and report a warning. The default. */
  | 'slidingWindow'
  /** Re-throw. For apps where an un-summarized request is worse than no answer. */
  | 'throw';

/** Options for {@link rollingSummary}, on top of the shared strategy environment. */
export interface RollingSummaryOptions extends StrategyEnvironment {
  /**
   * The provider that writes the summary. Any `LLMProvider` — deliberately
   * not the provider the conversation runs on, unless you want it to be.
   */
  readonly summarizer: LLMProvider;
  /**
   * Fraction of the budget (0–1] at which to summarize, measured against the
   * whole conversation. Defaults to {@link DEFAULT_SUMMARY_THRESHOLD}.
   *
   * Below the threshold the pass is a no-op and costs one measurement. The
   * default leaves 30% of headroom because summarizing must happen *before*
   * the request would overflow, not at the moment it does: at 1.0 every
   * summarization would be on the critical path of a request that is already
   * too big, and a summarizer that is slow or down would then always land on
   * a turn that cannot fall back gracefully.
   */
  readonly threshold?: number;
  /**
   * How many of the newest turns stay verbatim. Defaults to
   * {@link DEFAULT_KEEP_RECENT_TURNS}. Clamped to a minimum of 1: the newest
   * turn is the request itself and is never summarized.
   *
   * Two is the smallest number that keeps a question and its follow-up intact;
   * raise it if your users refer back to specific wording, lower it only if
   * turns are enormous.
   */
  readonly keepRecentTurns?: number;
  /** Override the summarization prompt. Defaults to `defaultSummaryPrompt`. */
  readonly prompt?: SummaryPromptBuilder;
  /** `maxOutputTokens` for the summarizer call. Defaults to {@link DEFAULT_MAX_SUMMARY_TOKENS}. */
  readonly maxSummaryTokens?: number;
  /** Cancels the summarizer call. An abort always propagates, whatever {@link onSummarizerError} says. */
  readonly signal?: AbortSignal | undefined;
  /** Defaults to `'slidingWindow'`. See {@link SummarizerErrorPolicy}. */
  readonly onSummarizerError?: SummarizerErrorPolicy;
}

/**
 * Replace older turns with one summary message, keeping recent turns verbatim.
 *
 * ### The pass, step by step
 *
 * 1. Measure the conversation. If it is at or below `threshold × budget`,
 *    return it unchanged — summarizing early wastes a model call, and the
 *    summary would be re-derived next turn anyway.
 * 2. Take every turn except the newest `keepRecentTurns`. If there are none,
 *    there is nothing to compress: degrade to `slidingWindow`, which will
 *    either make it fit or raise `contextOverflow` honestly.
 * 3. Summarize them with the supplied provider, folding in any previous
 *    summary found among them (see below).
 * 4. Splice the summary message in at the position of the oldest message it
 *    replaces, keeping pinned messages exactly where they were.
 * 5. Measure again. If the result still exceeds the budget — a long system
 *    prompt, a verbose summarizer, a huge newest turn — run `slidingWindow`
 *    over the result rather than returning something that cannot be sent.
 *
 * ### Summary of summary
 *
 * A previous summary found in the older portion is **not** passed through as
 * ordinary history. Its text is extracted and handed to the prompt builder as
 * `previousSummary`, and the new summary replaces it along with the newly-aged
 * turns. So the summary stays exactly one message no matter how long the
 * conversation runs, and each pass re-compresses everything older than the
 * verbatim tail. This works because a summary is a *non-pinned* system message
 * (see `summary.ts`), which is what keeps it eligible to be re-summarized
 * instead of accumulating.
 *
 * ### When the summarizer fails
 *
 * Default: **degrade to `slidingWindow` for this request** and report a
 * `summarizerFailed` warning. The reasoning is that the user asked a question,
 * not for a summary. A failed summarization is a quality regression — older
 * context gets dropped rather than compressed — while failing the request is a
 * total loss, and the failure modes here are exactly the transient ones
 * DECISIONS.md D9 documents (a wedged on-device stack, a network blip). The
 * caller sees the warning and can retry, re-summarize later, or tell the user.
 * Set `onSummarizerError: 'throw'` if losing old context silently is worse for
 * your app than not answering.
 *
 * An **abort always propagates**, whatever the policy: the caller asked to
 * stop, and quietly continuing with a degraded strategy would carry on work
 * they cancelled.
 *
 * ### Purity
 *
 * Async, but nothing is mutated: the input array and every message in it are
 * untouched, and the summary arrives as a new message in a new array. Adopt it
 * into your own history via `result.summary` (it cost a model call — deriving
 * it again next turn costs another).
 *
 * @throws LLMError `contextOverflow` when even the pinned messages plus the
 * newest turn exceed the budget.
 */
export async function rollingSummary(
  messages: readonly Message[],
  options: RollingSummaryOptions
): Promise<FitContextResult> {
  const { budget, measure, summarizer } = options;
  const threshold = options.threshold ?? DEFAULT_SUMMARY_THRESHOLD;
  const keepRecentTurns = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const warnings: ContextWarning[] = [...(options.warnings ?? [])];

  const inputMeasurement = options.inputMeasurement ?? (await measure(messages));
  noteCounterFailure(inputMeasurement, warnings);

  const trigger = threshold * budget.tokens;
  if (inputMeasurement.tokens <= trigger) {
    return {
      messages,
      budget,
      measurement: inputMeasurement,
      inputMeasurement,
      withinBudget: true,
      strategy: 'rollingSummary',
      dropped: [],
      systemState: options.systemState ?? { applied: false },
      warnings,
    };
  }

  const layout = analyzeConversation(messages, options);
  // At least one turn always stays verbatim, whatever `keepRecentTurns` says.
  // The newest turn is the request being made: summarizing it would hand the
  // model a description of the question instead of the question, and it is the
  // same turn `slidingWindow` refuses to drop.
  const verbatimTail = Math.max(1, keepRecentTurns);
  const older: readonly ConversationTurn[] = layout.turns.slice(
    0,
    Math.max(0, layout.turns.length - verbatimTail)
  );

  const fallback = (extra: ContextWarning): Promise<FitContextResult> =>
    slidingWindow(messages, { ...options, warnings: [...warnings, extra], inputMeasurement });

  if (older.length === 0) {
    return fallback({
      code: 'nothingToSummarize',
      message: `Over the summarization threshold, but every turn is inside the verbatim tail (keepRecentTurns=${keepRecentTurns}); fell back to slidingWindow.`,
    });
  }

  const replacedIndices = older.flatMap((turn) => [...turn.indices]).sort((a, b) => a - b);
  const replaced = replacedIndices.map((index) => messages[index]);
  const previous = replaced
    .map((message) => summaryText(message, options.summaryMarker))
    .filter((text): text is string => text !== undefined);
  const previousSummary = previous.length > 0 ? previous[previous.length - 1] : undefined;
  const verbatim = replaced.filter((message) => !isSummaryMessage(message, options.summaryMarker));

  const build = options.prompt ?? defaultSummaryPrompt;
  let text: string;
  try {
    const result = await summarizer.generate(
      {
        messages: build({
          messages: verbatim,
          ...(previousSummary !== undefined ? { previousSummary } : {}),
        }),
        maxOutputTokens: options.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS,
      },
      options.signal !== undefined ? { signal: options.signal } : undefined
    );
    text = result.text.trim();
  } catch (error) {
    if (isLLMError(error, 'cancelled')) throw error;
    if ((options.onSummarizerError ?? 'slidingWindow') === 'throw') throw error;
    return fallback({
      code: 'summarizerFailed',
      message: `Summarizer "${summarizer.id}" failed; fell back to slidingWindow for this request.`,
      cause: error,
    });
  }

  if (text === '') {
    if ((options.onSummarizerError ?? 'slidingWindow') === 'throw') {
      // `unknown` + transient, not `contextOverflow`: nothing about the
      // context was wrong, the summarizer just produced nothing usable — and
      // DECISIONS.md D9 reserves this lane for exactly that kind of
      // system-level hiccup, which a retry may well clear.
      throw new LLMError(
        { code: 'unknown', transient: true },
        {
          message: `Summarizer "${summarizer.id}" returned no text`,
          ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        }
      );
    }
    return fallback({
      code: 'summarizerEmpty',
      message: `Summarizer "${summarizer.id}" returned no text; fell back to slidingWindow for this request.`,
    });
  }

  const summaryMessage = createSummaryMessage(text, { marker: options.summaryMarker });
  const summary: SummaryOutcome = {
    message: summaryMessage,
    replaced,
    ...(previousSummary !== undefined ? { previousSummary } : {}),
  };

  const replacedSet = new Set(replacedIndices);
  const insertAt = replacedIndices[0];
  const summarized: Message[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (index === insertAt) summarized.push(summaryMessage);
    if (!replacedSet.has(index)) summarized.push(messages[index]);
  }

  const measurement: TokenMeasurement = await measure(summarized);
  noteCounterFailure(measurement, warnings);

  if (measurement.tokens <= budget.tokens) {
    return {
      messages: summarized,
      budget,
      measurement,
      inputMeasurement,
      withinBudget: true,
      strategy: 'rollingSummary',
      dropped: [],
      summary,
      systemState: options.systemState ?? { applied: false },
      warnings,
    };
  }

  // Still too big even compressed. Trim the compressed list rather than hand
  // back something that cannot be sent; `slidingWindow` raises
  // `contextOverflow` if even that is impossible.
  const trimmed = await slidingWindow(summarized, {
    ...options,
    warnings,
    inputMeasurement: measurement,
  });
  return { ...trimmed, inputMeasurement, strategy: 'rollingSummary', summary };
}
