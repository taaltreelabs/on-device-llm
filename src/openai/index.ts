/**
 * `@taaltreelabs/on-device-llm/openai`
 *
 * Provider for any Chat Completions-compatible HTTP endpoint: the
 * developer-supplied cloud fallback, and `fm serve` during local
 * development (docs/plan.md §2, §5 Phase 1).
 *
 * ISOLATION RULE (docs/plan.md §2, DECISIONS.md D1-D9): this module and
 * everything it imports must run under plain Node with no React, React
 * Native, Expo, or native module anywhere in the import graph. Do not
 * import from `../apple` or `../react`, and do not import `react`,
 * `react-native`, or any `expo`/`expo-*` package here. Use only `fetch`
 * and web-standard APIs. This is enforced by the ESLint isolation rule
 * (eslint.config.cjs) and by `scripts/check-isolation.mjs`
 * (`npm run check:isolation`) against the built output.
 */

import { OpenAIProvider, type OpenAIProviderConfig } from './provider';
import type { LLMProvider } from '../core';

export { OpenAIProvider, type OpenAIProviderConfig } from './provider';

/**
 * Build an `LLMProvider` backed by a Chat Completions-compatible HTTP
 * endpoint.
 *
 * ```ts
 * const provider = createOpenAIProvider({
 *   baseUrl: 'http://127.0.0.1:1976/v1', // fm serve, in development
 *   model: 'system',
 * });
 * ```
 */
export function createOpenAIProvider(config: OpenAIProviderConfig): LLMProvider {
  return new OpenAIProvider(config);
}
