# Decisions

Newest first. Each entry: what was decided, why, and what evidence it rests on. Supporting research lives in `docs/research/`.

## 2026-09-20 — Phase 0

### D1: Bespoke provider interface; AI SDK conformance deferred to an optional adapter

The `core` provider interface stays bespoke (as sketched in `docs/plan.md` §2). The Vercel AI SDK's current spec (`LanguageModelV3`, AI SDK 7) was evaluated and rejected as the primary interface: it has no spec-native place for availability checks with reason codes, token counting, or capability discovery — the three things the router depends on. Empirically, `@react-native-ai/apple` (which implements the AI SDK spec) bolts `isAvailable()` on outside the interface and hardcodes `usage` to zeros. A thin `LanguageModelV3` adapter over our interface remains possible later. Evidence: `docs/research/ecosystem.md` §4.

### D2: Build our own Swift native module; do not wrap an existing bridge

All four surveyed bridges conflict with the stateless message-based design: three are stateful single-prompt APIs; only Callstack's rebuilds sessions from history. All four share the same unaddressed gap on tool calling (no timeout, no cancellation of in-flight calls) — the exact problem the plan flags as hardest. Streaming snapshot→delta conversion is inconsistent or absent in three of four. Licenses (all MIT) were not the blocker. We borrow ideas with attribution where warranted: henrypldev's whitelist-and-reject-loudly schema translation, expo-foundation-models' availability diagnostics. Evidence: `docs/research/prior-art.md`.

### D3: Expo Modules API (not Nitro, not raw TurboModules)

The first consumer is an Expo app, the single-package shape follows the Expo module convention, and the maintainer wants minimal native surface. No concrete performance need justifies Nitro's extra tooling. Whether to use the classic definition DSL or the newer Swift-macro Modules API 2.0 is deferred to Phase 3 when the Swift work starts.

### D4: Platform floor — iOS 27+ / macOS 27+, Expo SDK 57 / RN 0.86 only

Maintainer directive (2026-09-20): target only the current OS releases and their current RN/Expo pairing. Older iOS (including 26, which shipped the framework) gets `unavailable`/`unsupportedPlatform` from the Apple provider — no compatibility code paths. Consequences: no dual-path `GenerationError` handling (iOS 27 replaced the error enum wholesale; we map only `LanguageModelError` + a raw `NSError` fallback), Metro `exports` resolution is a non-issue (default since RN 0.79), and iOS 26.4's `tokenCount(for:)` API is safely inside the floor. Trade-off accepted: devices on older OS versions always route to cloud.

### D5: `StreamEvent` carries deltas; the Apple provider diffs snapshots

Confirmed from the iOS 27.1 `.swiftinterface`: `ResponseStream` still yields cumulative snapshots, not deltas. Deltas are the convention of Chat Completions, UI code, and our `openai` provider, so the Apple provider converts. Evidence: `docs/research/sdk-surface.md` §streaming; independently confirmed by fm-proxy and apple-fm-serve notes.

### D6 (tentative, validate in Phase 3): Structured output via JSON Schema normalization in TypeScript + `GenerationSchema` `Codable` decode in Swift

The SDK dump found `GenerationSchema` decodes a JSON Schema document directly (needs `title`, `additionalProperties`, `required`, Apple's `x-order`; silently drops `minLength`/`maxLength`/`format`/`multipleOf`; rejects `allOf` and `type: ["string","null"]`). Plan of record: normalize/validate the developer's JSON Schema in TypeScript (rejecting the unsupported subset loudly as `invalidRequest`), then decode natively — keeping the fiddly logic in TS per the maintainer's preference. Falls back to `DynamicGenerationSchema` construction (verified capable) if decode proves too limited. Evidence: `docs/research/sdk-surface.md` §schema.

### D7: `unsupportedLocale` is not an availability reason

`SystemLanguageModel.Availability.UnavailableReason` has exactly three cases (`deviceNotEligible`, `appleIntelligenceNotEnabled`, `modelNotReady`). Locale problems surface as the generation error `unsupportedLanguageOrLocale`, predictable up front via `supportsLocale()`. The error taxonomy keeps `unsupportedLocale`, but it maps from the generation path, and `availability()` results are enriched with a locale pre-check rather than a native reason code. The plan's §2 taxonomy is amended accordingly. 24 locales supported; TaalTree's four (nl, fr, de, es) all included.

### D8: `fm` CLI / `fm serve` is a local-dev test rig only

Integration tests use it when reachable and skip otherwise (as planned). Two additions from recon: (a) the macOS 27 `fm` license text arguably forbids programmatic use in shipped products — it never ships in or near the package; (b) known upstream quirks to avoid in tests: `tool_choice: "auto"` is broken, recursive `$defs` hang the server, responses stream SSE even without `stream: true`. Evidence: `docs/research/prior-art.md` §fm quirks, plus direct probing (2026-09-20).

### D9: Availability is necessary but not sufficient — the taxonomy needs a transient system-failure lane

Observed live on this Mac: `availability == .available` while all generation fails with `com.apple.SensitiveContentAnalysisML error 15` and token counting with `ModelManagerError 1013`, and `contextSize` returns `0`. Consequences: (a) guard `contextSize <= 0`; (b) untyped `NSError`s from the native layer map to a retryable `unknown` rather than crashing the request path; (c) the router may treat repeated unknown-transient failures as a fallback trigger (design in Phase 4). Evidence: `docs/research/sdk-surface.md` §surprises.
