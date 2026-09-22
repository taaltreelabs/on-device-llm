/**
 * `@taaltreelabs/on-device-llm/core`
 *
 * The package's public API: message and request types, the provider
 * interface, the error taxonomy, capability/availability reporting, a
 * heuristic token estimator, and a scriptable mock provider. The context
 * manager (Phase 2) and router (Phase 4) land here too.
 *
 * Everything else in the package — the OpenAI-compatible provider, the Apple
 * native provider, the React hooks — conforms to what is defined here, and
 * third parties can write their own providers against it without living in
 * this repo (docs/plan.md §2).
 *
 * ISOLATION RULE (docs/plan.md §2, DECISIONS.md D1-D9): this module and
 * everything it imports must run under plain Node with no React, React
 * Native, Expo, or native module anywhere in the import graph, and with zero
 * runtime dependencies. Do not import from `../apple` or `../react`, and do
 * not import `react`, `react-native`, or any `expo`/`expo-*` package here.
 * Enforced by the ESLint isolation rule (eslint.config.cjs) and by
 * `scripts/check-isolation.mjs` (`npm run check:isolation`) against the built
 * output.
 *
 * No default exports anywhere: every symbol is named, so re-export from the
 * package root stays mechanical and `import * as` stays readable.
 */

export type { Availability, UnavailableReason } from './availability';
export {
  analyzeConversation,
  applySystemState,
  computeContextBudget,
  createMeasure,
  createSummaryMessage,
  defaultSummaryPrompt,
  fitContext,
  isBoundedBudget,
  isSummaryMessage,
  measureMessages,
  projectMessages,
  rollingSummary,
  slidingWindow,
  stripSystemState,
  summaryText,
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_MAX_SUMMARY_TOKENS,
  DEFAULT_RESERVED_FOR_OUTPUT_TOKENS,
  DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS,
  DEFAULT_SAFETY_MARGIN_EXACT_TOKENS,
  DEFAULT_SUMMARY_MARKER,
  DEFAULT_SUMMARY_THRESHOLD,
  DEFAULT_SYSTEM_STATE_MARKER,
  type AnalyzeConversationOptions,
  type BoundedContextBudget,
  type ContextBudget,
  type ContextBudgetInput,
  type ContextStrategy,
  type ContextStrategyName,
  type ContextWarning,
  type ContextWarningCode,
  type ConversationLayout,
  type ConversationTurn,
  type CreateMeasureOptions,
  type FitContextOptions,
  type FitContextResult,
  type Measure,
  type PinSystemMessages,
  type RollingSummaryConfig,
  type RollingSummaryOptions,
  type SafetyMarginOption,
  type SlidingWindowOptions,
  type StrategyEnvironment,
  type StrategySelection,
  type SummarizerErrorPolicy,
  type SummaryOutcome,
  type SummaryPromptBuilder,
  type SummaryPromptInput,
  type SystemStateOptions,
  type SystemStateOutcome,
  type SystemStatePlacement,
  type SystemStateRenderer,
  type SystemStateSlot,
  type TokenMeasurement,
  type TokenMeasurementKind,
  type TokenMeasurementSource,
  type UnboundedContextBudget,
  type UnknownContextWindowPolicy,
} from './context';
export {
  UNKNOWN,
  isUnknown,
  normalizeContextWindow,
  type Capabilities,
  type TokenCounting,
  type UnknownValue,
} from './capabilities';
export {
  LLMError,
  isAbortError,
  isLLMError,
  toLLMError,
  type CancelledErrorDetails,
  type ContextOverflowErrorDetails,
  type GuardrailErrorDetails,
  type InvalidRequestErrorDetails,
  type LLMErrorCode,
  type LLMErrorDetails,
  type LLMErrorDetailsFor,
  type LLMErrorOf,
  type LLMErrorOptions,
  type NetworkErrorDetails,
  type RateLimitedErrorDetails,
  type UnavailableErrorDetails,
  type UnknownErrorDetails,
  type UnsupportedLocaleErrorDetails,
} from './errors';
export {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_PER_MESSAGE_OVERHEAD_TOKENS,
  estimateTokens,
  type EstimateTokensOptions,
} from './estimate-tokens';
export type {
  FinishReason,
  GenerateRequest,
  GenerateResult,
  JsonSchema,
  TokenUsage,
} from './generation';
export type { Message, MessageRole } from './messages';
export {
  DROPPED_ANNOTATIONS,
  normalizeJsonSchema,
  type ArrayNode,
  type BooleanNode,
  type DroppedKeyword,
  type NormalizeSchemaOptions,
  type NormalizedSchema,
  type NumberNode,
  type ObjectNode,
  type SchemaNode,
  type SchemaProperty,
  type StringNode,
} from './schema';
export type { ToolCall, ToolDefinition, ToolExecutor } from './tools';
export {
  MockProvider,
  type MockCall,
  type MockCountTokens,
  type MockErrorTurn,
  type MockProviderOptions,
  type MockResultTurn,
  type MockStreamChunk,
  type MockStreamTurn,
  type MockTurn,
} from './mock-provider';
export type { LLMProvider, RequestOptions } from './provider';
export {
  createRouter,
  DEFAULT_FALLBACK_TRIGGERS,
  DEFAULT_ROUTE_CACHE_TTL_MS,
  type FallbackTriggers,
  type OnRoute,
  type RouteAttempt,
  type RouteCandidate,
  type RouteEligibility,
  type RouteOutcome,
  type RoutePlan,
  type RoutePolicy,
  type RoutePolicyContext,
  type RoutePolicyFunction,
  type RoutePolicyRules,
  type RoutePredicate,
  type RouteReason,
  type RouteReport,
  type RouteRequirements,
  type RouterConfig,
  type RouteSkipReason,
  type RouteTagRule,
  type RouteTokenSource,
} from './router';
export type {
  FinishEvent,
  ObjectSnapshotEvent,
  StreamEvent,
  TextDeltaEvent,
  ToolCallEvent,
} from './stream';
