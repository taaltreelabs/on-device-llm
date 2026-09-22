/**
 * `@taaltreelabs/on-device-llm/apple`
 *
 * Provider backed by the Swift module wrapping Apple's FoundationModels
 * framework (docs/plan.md §2, §5 Phase 3). May import React Native, Expo and
 * the native module — but **only lazily**.
 *
 * IMPORTANT (docs/plan.md §4, "a single package means the root import runs
 * everywhere"): the package root re-exports this module, so importing it on
 * Android, on web, under Node, or on an iOS build without the framework must
 * never throw. Nothing here imports the native module at load time; it is
 * resolved inside method bodies, in a `try`/`catch`, by `./native/resolve`,
 * and a failure to resolve is reported as `unavailable` with reason
 * `unsupportedPlatform`.
 *
 * Phase 3 steps 1-7: availability + capabilities + locales, `generate` and
 * `stream` with working cancellation, prewarming, exact token counting,
 * structured output, and tool calling.
 */

import { AppleProvider, type AppleProviderConfig } from './provider';
import type { LLMProvider } from '../core';

export {
  AppleProvider,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  type AppleProviderConfig,
} from './provider';
export { encodeAppleSchema } from './schema';
export type {
  AppleNativeModule,
  NativeAvailability,
  NativeCapabilities,
  NativeCountTokensOutcome,
  NativeErrorPayload,
  NativeGenerateOutcome,
  NativeResult,
  NativeStreamEvent,
  NativeToolDefinition,
  NativeUsage,
} from './native/types';

/**
 * Build an `LLMProvider` backed by the on-device Apple Foundation Model.
 *
 * ```ts
 * const apple = createAppleProvider({ locale: 'nl-NL' });
 *
 * const availability = await apple.availability();
 * if (availability.available) {
 *   for await (const event of apple.stream({ messages })) {
 *     if (event.type === 'textDelta') process.stdout.write(event.delta);
 *   }
 * }
 * ```
 *
 * Safe to call on every platform: on anything without the native module the
 * returned provider reports `unavailable` / `unsupportedPlatform` and its
 * `generate`/`stream` throw the matching `LLMError` rather than crashing.
 */
export function createAppleProvider(config: AppleProviderConfig = {}): LLMProvider {
  return new AppleProvider(config);
}
