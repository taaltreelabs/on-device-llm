/**
 * `@taaltreelabs/on-device-llm/react`
 *
 * React hooks: `useAvailability`, `useChat`, `useGenerate`
 * (docs/plan.md §2, §5 Phase 4).
 *
 * ISOLATION RULE (docs/plan.md §2): this directory may import `react` only.
 * `react-native` and `expo`/`expo-*` are forbidden here — enforced by the
 * ESLint override in `eslint.config.cjs` — the same spirit as the
 * `core`/`openai` isolation rule (DECISIONS.md D1-D9), even though nothing
 * here is expected to run outside React. `useAvailability`'s
 * `options.resubscribe` seam exists specifically so app-only concerns like
 * `AppState` can be wired in from the app, not from this package.
 *
 * `react` is an optional peer dependency (package.json); these hooks import
 * it normally, the same as any React library.
 *
 * No default exports: every symbol is named, matching `core`'s convention.
 */

export {
  useAvailability,
  type UseAvailabilityOptions,
  type UseAvailabilityResult,
} from './useAvailability';
export {
  useChat,
  type ChatFitSummary,
  type UseChatOptions,
  type UseChatResult,
  type UseChatStatus,
} from './useChat';
export { useGenerate, type UseGenerateResult } from './useGenerate';
