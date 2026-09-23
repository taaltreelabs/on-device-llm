/**
 * What a trimming pass reports back.
 *
 * The context manager is pure: the caller owns the conversation array, and a
 * pass returns a *new* list plus enough metadata to explain it. The metadata
 * is not decoration — the Phase 4 `useChat` needs it to render "earlier
 * messages summarized", telemetry needs to know whether a number was measured
 * or guessed, and an app that wants to adopt a summary into its own store
 * needs to know exactly which messages it replaces.
 */

import type { UnknownValue } from '../capabilities';
import { LLMError } from '../errors';
import type { Message } from '../messages';
import type { ContextBudget } from './budget';
import type { TokenMeasurement } from './measure';
import type { SystemStateOutcome } from './system-state';

/** Which strategy produced a result. */
export type ContextStrategyName = 'none' | 'slidingWindow' | 'rollingSummary' | 'custom';

/** Machine-readable warning codes. New codes are additive; `switch` with a `default`. */
export type ContextWarningCode =
  /** The provider could not report a context window, so nothing was trimmed (DECISIONS.md D9). */
  | 'unknownContextWindow'
  /** `countTokens` threw or returned nonsense; the estimator stood in. */
  | 'tokenCounterFailed'
  /** The summarizer provider failed; the pass degraded to `slidingWindow`. */
  | 'summarizerFailed'
  /** The summarizer returned nothing usable; the pass degraded to `slidingWindow`. */
  | 'summarizerEmpty'
  /** Summarization was asked for but there was nothing old enough to summarize. */
  | 'nothingToSummarize'
  /** A summary message was itself dropped to make the request fit. Information has been lost. */
  | 'summaryDropped';

/** Something the caller should know about, that did not warrant failing the request. */
export interface ContextWarning {
  readonly code: ContextWarningCode;
  /** Human-readable, safe to log — never contains message content. */
  readonly message: string;
  /** The underlying error, when there was one. */
  readonly cause?: unknown;
}

/** What the rolling summary did, when it did anything. */
export interface SummaryOutcome {
  /** The message that was injected. */
  readonly message: Message;
  /**
   * The messages it replaced, in their original order — including a previous
   * summary message, if this was a summary-of-summary pass.
   *
   * To adopt the summary into your own history (recommended: it cost a model
   * call, and re-deriving it next turn costs another), replace exactly these
   * messages with {@link message} in your store.
   */
  readonly replaced: readonly Message[];
  /** The previous summary's text, when this pass superseded one. */
  readonly previousSummary?: string;
}

/** The outcome of one trimming pass. */
export interface FitContextResult {
  /**
   * The messages to send. A subsequence of the input, except for the
   * summary message and the system-state block, which are injected.
   */
  readonly messages: readonly Message[];
  /** The budget the pass worked against, bounded or not. */
  readonly budget: ContextBudget;
  /** Measurement of {@link messages} — what will actually be sent. */
  readonly measurement: TokenMeasurement;
  /** Measurement of the input (after system-state injection, before any trimming). */
  readonly inputMeasurement: TokenMeasurement;
  /**
   * `true` when {@link messages} was measured against a real budget and fits;
   * `UNKNOWN` when there was no budget to measure against (see
   * `ContextWarningCode.unknownContextWindow`). Never `false`: a bounded pass
   * that cannot fit throws `contextOverflow` instead of returning.
   */
  readonly withinBudget: true | UnknownValue;
  /** Which strategy ran. */
  readonly strategy: ContextStrategyName;
  /**
   * Messages removed and *not* represented in the output, in original order.
   * Disjoint from `summary.replaced`, which are represented by the summary.
   */
  readonly dropped: readonly Message[];
  /** Present iff a summary was produced this pass. */
  readonly summary?: SummaryOutcome;
  /** Whether the app-owned state slot rendered anything. */
  readonly systemState: SystemStateOutcome;
  /** Non-fatal problems. Empty in the happy path. */
  readonly warnings: readonly ContextWarning[];
}

/** Build the `contextOverflow` error a strategy raises when even the minimum does not fit. */
export function contextOverflowError(options: {
  readonly tokenCount: number;
  readonly budgetTokens: number;
  readonly providerId?: string;
}): LLMError {
  return new LLMError(
    {
      code: 'contextOverflow',
      contextSize: options.budgetTokens,
      tokenCount: options.tokenCount,
    },
    {
      message: `The pinned messages and the newest turn need ${options.tokenCount} tokens, which exceeds the input budget of ${options.budgetTokens}`,
      ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
    }
  );
}
