/**
 * The context manager (docs/plan.md §5 Phase 2).
 *
 * Pure functions that fit a conversation into a provider's context window.
 * Nothing here holds state, touches the network by itself, or mutates its
 * input: you own the conversation array, you hand it in, you get a new one
 * back plus the metadata explaining what changed.
 *
 * The trimming strategies and the `fitContext` entry point that dispatches to
 * them build on the pieces exported here: a budget, a way to measure, and the
 * rules for reading a conversation's pins and turns.
 *
 * The one piece of advice worth reading before anything else is in
 * `system-state.ts`: if your app has state the model needs, render it into the
 * system prompt every turn rather than hoping it survives in history.
 */

export {
  computeContextBudget,
  isBoundedBudget,
  DEFAULT_RESERVED_FOR_OUTPUT_TOKENS,
  DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS,
  DEFAULT_SAFETY_MARGIN_EXACT_TOKENS,
  type BoundedContextBudget,
  type ContextBudget,
  type ContextBudgetInput,
  type SafetyMarginOption,
  type UnboundedContextBudget,
} from './budget';
export {
  analyzeConversation,
  type AnalyzeConversationOptions,
  type ConversationLayout,
  type ConversationTurn,
  type PinSystemMessages,
} from './layout';
export {
  createMeasure,
  measureMessages,
  type CreateMeasureOptions,
  type Measure,
  type TokenMeasurement,
  type TokenMeasurementKind,
  type TokenMeasurementSource,
} from './measure';
export {
  createSummaryMessage,
  defaultSummaryPrompt,
  isSummaryMessage,
  summaryText,
  DEFAULT_MAX_SUMMARY_TOKENS,
  DEFAULT_SUMMARY_MARKER,
  type SummaryPromptBuilder,
  type SummaryPromptInput,
} from './summary';
export {
  applySystemState,
  stripSystemState,
  DEFAULT_SYSTEM_STATE_MARKER,
  type SystemStateOptions,
  type SystemStateOutcome,
  type SystemStatePlacement,
  type SystemStateRenderer,
  type SystemStateSlot,
} from './system-state';
