/**
 * `fitContext` — one entry point that resolves a provider's limits, measures
 * the conversation, and runs a strategy against it.
 *
 * The strategies are exported individually (they compose, and a custom one is
 * just a function), but almost every caller wants this: hand it a provider and
 * a conversation, get back a message list that fits and the metadata
 * explaining what happened.
 */

import { isUnknown, UNKNOWN, type TokenCounting, type UnknownValue } from '../capabilities';
import { LLMError } from '../errors';
import type { EstimateTokensOptions } from '../estimate-tokens';
import type { Message } from '../messages';
import type { LLMProvider } from '../provider';
import {
  computeContextBudget,
  isBoundedBudget,
  type ContextBudget,
  type SafetyMarginOption,
} from './budget';
import type { PinSystemMessages } from './layout';
import { createMeasure, type Measure, type TokenMeasurement } from './measure';
import type { ContextWarning, FitContextResult } from './result';
import { rollingSummary, type RollingSummaryOptions } from './rolling-summary';
import { noteCounterFailure, slidingWindow, type StrategyEnvironment } from './sliding-window';
import { applySystemState, type SystemStateSlot } from './system-state';

/**
 * A trimming strategy: messages in, a fitted result out. Custom strategies
 * implement this and are passed straight to `fitContext`'s `strategy` option,
 * so an app can compose (e.g. summarize, then apply its own relevance filter)
 * without forking this package.
 */
export type ContextStrategy = (
  messages: readonly Message[],
  environment: StrategyEnvironment
) => Promise<FitContextResult>;

/** The rolling-summary knobs, minus everything `fitContext` supplies itself. */
export type RollingSummaryConfig = Omit<RollingSummaryOptions, keyof StrategyEnvironment>;

/** Strategy selection for {@link fitContext}. */
export type StrategySelection =
  /** Shorthand for `{ type: 'slidingWindow' }`. The default. */
  | 'slidingWindow'
  | { readonly type: 'slidingWindow' }
  | ({ readonly type: 'rollingSummary' } & RollingSummaryConfig)
  | ContextStrategy;

/**
 * What to do when the provider cannot report its context window
 * (`contextWindow: UNKNOWN` — DECISIONS.md D9).
 */
export type UnknownContextWindowPolicy =
  /**
   * **Default.** Return the conversation untrimmed, with an unbounded budget,
   * `withinBudget: UNKNOWN`, and an `unknownContextWindow` warning.
   *
   * Trimming to a limit nobody knows is guessing, and the two tempting
   * shortcuts are both wrong: treating unknown as `Infinity` silently sends a
   * doomed request while claiming it fits, and treating it as `0` refuses
   * every request. Passing through is the honest middle — the request may well
   * succeed (most cloud endpoints cannot report a window and have a large
   * one), and if it does not, the provider's own `contextOverflow` carries the
   * real `contextSize` and `tokenCount`, which is better information than any
   * guess we could have made.
   */
  | 'passThrough'
  /**
   * Throw `invalidRequest`. For apps that would rather fail loudly at
   * development time than ship a provider whose window was never configured.
   */
  | 'error';

/** Options for {@link fitContext}. */
export interface FitContextOptions {
  /**
   * The provider the request will be sent to. Supplies the context window and
   * the token counter; `capabilities()` is called once per pass unless both
   * `contextWindow` and `tokenCounting` are given explicitly.
   *
   * Optional only so the strategies can be driven directly in tests — in real
   * use, pass it.
   */
  readonly provider?: LLMProvider;
  /** Overrides `capabilities().contextWindow`. Pass `UNKNOWN` to force the unknown path. */
  readonly contextWindow?: number | UnknownValue;
  /** Overrides `capabilities().tokenCounting`. */
  readonly tokenCounting?: TokenCounting;
  /** Overrides `provider.countTokens`. */
  readonly countTokens?: (messages: readonly Message[]) => Promise<number>;
  /**
   * Replaces token measurement wholesale. Tests use this for a deterministic
   * counter; production callers almost never need it.
   */
  readonly measure?: Measure;
  /** Tokens held back for the answer. Defaults to `DEFAULT_RESERVED_FOR_OUTPUT_TOKENS` (512). Set it to your `maxOutputTokens`. */
  readonly reservedForOutput?: number;
  /** Margin for measurement error and provider-side framing; larger by default when estimating. */
  readonly safetyMargin?: SafetyMarginOption;
  /** Tuning for the `estimateTokens` fallback. */
  readonly estimate?: EstimateTokensOptions;
  /** Window to assume when the provider reports `UNKNOWN`. Supplying it bypasses {@link onUnknownContextWindow}. */
  readonly assumedContextWindow?: number;
  /** Defaults to `'passThrough'`. See {@link UnknownContextWindowPolicy}. */
  readonly onUnknownContextWindow?: UnknownContextWindowPolicy;
  /** Defaults to `'slidingWindow'`. See {@link StrategySelection}. */
  readonly strategy?: StrategySelection;
  /** The app-owned structured state slot. See `system-state.ts` — it is the pattern to reach for first. */
  readonly systemState?: SystemStateSlot;
  /** Which system messages count as pinned. Defaults to `'first'`. */
  readonly pinSystemMessages?: PinSystemMessages;
  /** Marker identifying rolling summaries. Keep it stable across a conversation's life. */
  readonly summaryMarker?: string;
  /** Cancels the summarizer call (and any counter that honours it). */
  readonly signal?: AbortSignal;
}

function resolveStrategy(selection: StrategySelection | undefined): {
  readonly run: ContextStrategy;
  readonly name: 'slidingWindow' | 'rollingSummary' | 'custom';
} {
  if (selection === undefined || selection === 'slidingWindow') {
    return { run: slidingWindow, name: 'slidingWindow' };
  }
  if (typeof selection === 'function') {
    return { run: selection, name: 'custom' };
  }
  if (selection.type === 'slidingWindow') {
    return { run: slidingWindow, name: 'slidingWindow' };
  }
  // Assigned (not destructured) so the discriminant `type` is simply carried
  // along and ignored; picking it apart would leave an unused binding.
  const config: RollingSummaryConfig = selection;
  return {
    run: (messages, environment) => rollingSummary(messages, { ...environment, ...config }),
    name: 'rollingSummary',
  };
}

/**
 * Fit a conversation into a provider's context window.
 *
 * ```ts
 * const result = await fitContext(messages, {
 *   provider,
 *   reservedForOutput: 512,
 *   systemState: () => renderOpenTasks(store.getState()),
 *   strategy: { type: 'rollingSummary', summarizer: cloudProvider },
 * });
 *
 * const answer = await provider.generate({ messages: result.messages });
 * if (result.summary) store.replaceHistory(result.summary.replaced, result.summary.message);
 * ```
 *
 * ### Pure and stateless
 *
 * You own the conversation array. `fitContext` never mutates it, holds nothing
 * between calls, and returns a new list. **Send `result.messages`; keep your
 * own array as the source of truth.** The one thing worth adopting back into
 * your history is `result.summary` — it cost a model call. Do not adopt the
 * system-state block; it is re-rendered every pass (and harmlessly replaced if
 * you do, since it is idempotent).
 *
 * ### Order of operations
 *
 * 1. Render the app-owned state slot into the system prompt, so it is inside
 *    the budget like any other content.
 * 2. Resolve the window and the token counter from `capabilities()` (once),
 *    unless overridden.
 * 3. Measure the conversation **first**, then compute the budget from the kind
 *    of measurement that actually happened. This ordering matters: if
 *    `countTokens` throws and the estimator stands in, the budget gets the
 *    wider estimated margin rather than the narrow exact one it would have got
 *    from the provider's advertised capability.
 * 4. Run the strategy, which reuses that first measurement.
 *
 * @throws LLMError `contextOverflow` when the pinned messages plus the newest
 * turn cannot fit; `invalidRequest` for an impossible configuration, or for an
 * unknown context window under `onUnknownContextWindow: 'error'`.
 */
export async function fitContext(
  messages: readonly Message[],
  options: FitContextOptions = {}
): Promise<FitContextResult> {
  const { provider } = options;
  const warnings: ContextWarning[] = [];

  const { messages: staged, outcome: systemState } = applySystemState(
    messages,
    options.systemState,
    options.summaryMarker
  );

  const needsCapabilities =
    provider !== undefined &&
    (options.contextWindow === undefined || options.tokenCounting === undefined);
  const capabilities = needsCapabilities ? await provider.capabilities() : undefined;

  const contextWindow: number | UnknownValue =
    options.contextWindow ?? capabilities?.contextWindow ?? UNKNOWN;
  const tokenCounting: TokenCounting =
    options.tokenCounting ?? capabilities?.tokenCounting ?? 'none';

  const countTokens =
    options.countTokens ??
    (tokenCounting === 'none' || provider?.countTokens === undefined
      ? undefined
      : provider.countTokens.bind(provider));

  const measure: Measure =
    options.measure ??
    createMeasure({
      ...(countTokens !== undefined ? { countTokens } : {}),
      tokenCounting,
      ...(options.estimate !== undefined ? { estimate: options.estimate } : {}),
    });

  const inputMeasurement: TokenMeasurement = await measure(staged);
  noteCounterFailure(inputMeasurement, warnings);

  if (isUnknown(contextWindow) && options.assumedContextWindow === undefined) {
    if ((options.onUnknownContextWindow ?? 'passThrough') === 'error') {
      throw new LLMError(
        { code: 'invalidRequest' },
        {
          message:
            "The provider reports contextWindow: 'unknown', so no budget can be computed. Configure the window (OpenAIProviderConfig.contextWindow), pass fitContext's contextWindow/assumedContextWindow, or set onUnknownContextWindow: 'passThrough' to send the conversation untrimmed.",
          ...(provider !== undefined ? { providerId: provider.id } : {}),
        }
      );
    }
    const budget: ContextBudget = {
      kind: 'unbounded',
      reason: 'unknownContextWindow',
      measurementKind: inputMeasurement.kind,
    };
    warnings.push({
      code: 'unknownContextWindow',
      message:
        "The provider reports contextWindow: 'unknown', so nothing was trimmed. The request is being sent as-is; if it overflows, the provider's own contextOverflow will carry the real numbers.",
    });
    return {
      messages: staged,
      budget,
      measurement: inputMeasurement,
      inputMeasurement,
      withinBudget: UNKNOWN,
      strategy: 'none',
      dropped: [],
      systemState,
      warnings,
    };
  }

  const budget = computeContextBudget({
    contextWindow,
    measurementKind: inputMeasurement.kind,
    ...(options.reservedForOutput !== undefined
      ? { reservedForOutput: options.reservedForOutput }
      : {}),
    ...(options.safetyMargin !== undefined ? { safetyMargin: options.safetyMargin } : {}),
    ...(options.assumedContextWindow !== undefined
      ? { assumedContextWindow: options.assumedContextWindow }
      : {}),
  });

  // Unreachable: the unknown-window branch above already returned. Kept as a
  // guard rather than a non-null assertion so a future edit that lets an
  // unbounded budget through fails loudly instead of type-casting past it.
  if (!isBoundedBudget(budget)) {
    throw new LLMError(
      { code: 'invalidRequest' },
      { message: 'Unreachable: an unbounded budget survived the unknown-window branch.' }
    );
  }

  const environment: StrategyEnvironment = {
    budget,
    measure,
    inputMeasurement,
    systemState,
    warnings,
    ...(options.pinSystemMessages !== undefined
      ? { pinSystemMessages: options.pinSystemMessages }
      : {}),
    ...(options.summaryMarker !== undefined ? { summaryMarker: options.summaryMarker } : {}),
    ...(provider !== undefined ? { providerId: provider.id } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };

  const { run, name } = resolveStrategy(options.strategy);
  const result = await run(staged, environment);
  return name === 'custom' ? { ...result, strategy: 'custom' } : result;
}
