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
export type { FinishEvent, ObjectSnapshotEvent, StreamEvent, TextDeltaEvent } from './stream';
