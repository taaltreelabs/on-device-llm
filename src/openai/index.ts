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
 *
 * Nothing here yet — this is a Phase 0 scaffold placeholder.
 */

/** Marks this module as present; replaced by real exports in Phase 1. */
export const OPENAI_PLACEHOLDER = true;

/** Placeholder for the future OpenAI-compatible provider config shape. */
export type OpenAIProviderConfig = {
  baseUrl: string;
};
