/**
 * `@taaltreelabs/on-device-llm/apple`
 *
 * Provider backed by the Swift module wrapping Apple's FoundationModels
 * framework (docs/plan.md §2, §5 Phase 3). May import React Native and
 * the native module.
 *
 * IMPORTANT (docs/plan.md §4, "a single package means the root import
 * runs everywhere"): this module must never throw at import time on
 * Android, web, or an iOS version without the framework. The native
 * module wiring lives under `./native` (see OnDeviceLlmModule.ts /
 * OnDeviceLlmModule.web.ts) and is intentionally NOT imported here yet —
 * resolving it happens lazily, inside function bodies, starting in
 * Phase 3, so that importing the package root is always safe.
 *
 * Nothing here yet — this is a Phase 0 scaffold placeholder.
 */

/** Marks this module as present; replaced by real exports in Phase 3. */
export const APPLE_PLACEHOLDER = true;

/** Placeholder for the future Apple provider config shape. */
export type AppleProviderConfig = Record<string, never>;
