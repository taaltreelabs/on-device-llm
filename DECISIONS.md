# Decisions

Newest first. Each entry: what was decided, why, and what evidence it rests on. Supporting research lives in `docs/research/`.

## 2026-09-21 — Phase 3 steps 1–3 (Apple native provider)

### D16: Classic Expo definition DSL, not the macro-based Modules API 2.0

`expo-modules-core` 57.0.18 ships both. The macro surface (`@ExpoModule`, `@JS`, `@Event`, `@Record`, `@OptimizedFunction`) is real and its compiler plugin is a direct dependency of `expo-modules-core`, so it would work here. We use the classic DSL anyway, for three reasons:

1. **There is almost nothing for the macros to generate.** The bridge is five async functions and one event, and all the FoundationModels logic lives in `ios/Core/*.swift`, which imports no Expo at all. `OnDeviceLlmModule.swift` is ~170 lines of glue; macros would save perhaps fifteen.
2. **The classic DSL needs no compiler plugin on the command line.** Macro expansion requires `-Xfrontend -load-plugin-executable …/ExpoModulesMacros-tool#ExpoModulesMacros`, which CocoaPods injects for us today. Any consumer integration that does not — a hand-rolled Xcode target, a prebuilt-pod cache, a future SPM path — turns `@ExpoModule` into a hard compile error, while the DSL is ordinary Swift.
3. **`@JS` statically asserts that every type crossing the boundary is JS-convertible.** Our payloads are heterogeneous `[String: Any]` dictionaries (an error carrying `contextSize: Int`, `resetDate: Double`, `nativeDomain: String`), which the DSL's `Any`-typed returns handle naturally and the macro's conformance assertions fight.

Revisit if the native surface grows past roughly a dozen functions, where the DSL's builder blocks start to dominate the file.

### D17: The trailing user message is the `respond()` prompt, not a transcript entry

`LanguageModelSession(model:tools:transcript:)` seeds a session with *completed* turns; `respond(to:)` appends a new `.prompt` entry and generates its `.response`. So the transcript and the prompt are not interchangeable, and the request has to split:

- Last message also in the transcript → the model sees the question twice, and the turn's `transcriptEntries` stop matching the conversation.
- Last message only in the transcript, `respond(to: "")` → an undocumented shape that leaves a stray empty prompt entry.

`TranscriptBuilder.prepare` therefore puts everything *before* the trailing user message into the transcript and passes that message as the prompt. **A request that does not end with a user message is rejected as `invalidRequest`** — the framework has no "continue your own last message" affordance — and the check is duplicated in TypeScript (`buildNativeRequest`) so it costs no bridge hop.

**System messages** fold into the single leading `.instructions` entry, in their original order. `Transcript.Instructions` must be first and there is only one of it (sdk-surface.md §6), while a JS conversation can carry `system` messages anywhere — a Phase 2 rolling summary (D13) is a non-pinned `system` message sitting in front of the retained turns. Relative order among them is preserved; their position *between* turns is not, because the transcript cannot express it. Verified against the live model: the harness builds `[system, user, assistant, system(summary), user]` and gets a 3-entry transcript (instructions + prompt + response) plus the right prompt, and `LanguageModelSession(transcript:)` round-trips it.

### D18: A non-extending snapshot emits the suffix past the common prefix, flagged `reset`; `finish.text` is authoritative

`ResponseStream` yields cumulative snapshots (D5), so the bridge diffs them. In the normal case each snapshot extends the last and the deltas concatenate *exactly* to the final text — asserted against the real model in the harness, and 0 resets observed.

A snapshot that is **not** an extension means the model rewrote text already handed to the consumer, and a delta stream physically cannot retract it. Of the three possible policies — stall the stream (the UI freezes mid-sentence), re-emit the whole snapshot (duplicates far more text), or emit only what is new past the longest common prefix — we take the third, flag it `reset: true` on the wire, and treat the `finish` event's `text` (always the last snapshot, never the concatenation) as authoritative. A consumer that renders deltas live and then swaps in the final text always converges.

`reset` is surfaced rather than swallowed so the case stays observable if the framework's behaviour ever changes. It has never been seen for `Content == String`; this is a guard, not a workaround.

### D19: A configured locale the model does not support makes `availability()` unavailable, with reason `deviceNotEligible`

D7 established that `UnavailableReason` has exactly three cases and none is locale-related. That leaves the question of what `availability()` should say when `createAppleProvider({ locale })` names a language the model lacks. Options were: stay `available: true` and let generation fail, or map onto one of the three.

We map it, to `deviceNotEligible`, with the real reason in `detail`. The deciding evidence is a harness run against the live model: a fully Polish prompt (`pl` is **not** in `supportedLanguages`, confirmed by `supportsLocale`) was answered in fluent Polish rather than raising `unsupportedLanguageOrLocale`. **The generation-time error cannot be relied on**, so the `supportsLocale` pre-check is the only honest signal, and a provider that reports itself available for a language it cannot serve would have the Phase 4 router burn a generation per turn. Of the three reasons, `deviceNotEligible` is the only permanent, non-retryable one, which is what this is.

The check runs in `availability()` only, not per request: its answer cannot change while the process runs, and a bridge hop per `generate` to re-derive it would be pure cost. `AppleProvider.supportsLocale(tag)` is also exposed so an app can ask directly. A `capabilities().locales` entry is the *minimal* BCP-47 identifier (`nl`, `en-GB`, `es-419`) — note the discrepancy with sdk-surface.md §1, which lists the *maximal* form (`nl-Latn-NL`); the minimal form is what `Intl` and `navigator.language` produce, and exact matching should go through `supportsLocale` regardless.

### D20: Errors are returned across the bridge, not thrown

`generate` resolves to `{ ok: true, result } | { ok: false, error }`, and `startStream` reports every outcome — including failures and cancellation — as an `onStreamEvent` event. Expo's exception channel carries a code and a message; our taxonomy also carries `contextSize`/`tokenCount`, `resetDate`, `locale`, `transient`, and the native domain/code that D9 says we must never lose, none of which survives an `Exception`. Returning the payload also gives both paths one decoder in TypeScript, and it is what keeps a mid-stream failure from arriving as a rejected promise on a stream the consumer is already iterating.

### D21: Cancellation needs an explicit `Task.checkCancellation()` after the stream loop — the SDK does not throw

Measured, not assumed. `Task.cancel()` is the only cancellation mechanism the framework offers (there is no `stop()` on `LanguageModelSession`, sdk-surface.md §3), and a cancelled `respond` does throw `CancellationError` promptly. But a cancelled **`ResponseStream` does not throw**: the `for try await` loop simply ends, so the first implementation reported a perfectly ordinary `finish` for a generation the caller had stopped. The harness caught this on its first run against the live model. `GenerationEngine.stream` now checks cancellation after the loop as well as inside it, and both `generate` and `stream` surface an abort as `cancelled` rather than as a successful result — including the race where native finishes normally between `abort()` firing and `cancel()` landing, which `AppleProvider.generate` discards.

### D22: The example app must set an iOS 27 deployment target or the module is silently not linked

Not a design decision so much as a trap worth recording. `expo-modules-autolinking`'s CocoaPods integration filters modules by deployment target (`autolinking_manager.rb` → `pod.supports_platform?`). With the example's Podfile platform at the template default of 16.4 and our podspec at iOS 27.0 (D4), `pod install` **silently omits `OnDeviceLlm` entirely** — `Podfile.lock` has no entry, the app builds green, and `requireNativeModule('OnDeviceLlm')` fails at runtime. Raising `ios.deploymentTarget` to `27.0` links it; the app target's own `IPHONEOS_DEPLOYMENT_TARGET` must be raised too, or the app's Swift fails with *"compiling for iOS 16.4, but module 'OnDeviceLlm' has a minimum deployment target of iOS 27.0"*. With both raised, the example app builds clean for the iOS Simulator with zero warnings from our sources.

## 2026-09-21 — Phase 2 (context manager)

### D10: Budget defaults — 512 reserved for output, 64/256 safety margin, and measure *before* budgeting

`budget = window - reservedForOutput - safetyMargin`, with `reservedForOutput` defaulting to 512 (a complete chat reply: ~350–400 English words; 12.5% of a 4K window, 6% of 8K) and the safety margin defaulting to 64 when tokens were counted exactly and **256 when they were estimated**. The margin is non-zero even for exact counts because `countTokens(messages)` cannot see the schema, tool declarations, or prompt prefix the provider adds at request time. It is four times larger for estimates because `estimateTokens`' chars/3.5 over-counts prose but *under*-counts dense text (code, CJK, URLs), and the over-count is not a margin we can rely on.

Non-obvious consequence, and the reason for the ordering inside `fitContext`: the conversation is measured **first**, and the budget is computed from the kind of measurement that actually happened, not from the provider's advertised `tokenCounting`. A provider that claims `'exact'` and then throws (D9) is measuring by estimate, and must get the wider margin.

### D11: An unknown `contextWindow` yields a typed unbounded budget; the default is to pass the conversation through untrimmed

`ContextBudget` is a discriminated union (`bounded | unbounded`), not a number. Per D9 the window may be `UNKNOWN`, and both tempting substitutes are wrong: `Infinity` sends a doomed request while claiming it fits, `0` refuses every request. `fitContext`'s default `onUnknownContextWindow: 'passThrough'` returns the conversation untrimmed with `withinBudget: 'unknown'` and a warning, because (a) every cloud endpoint is in this state — our own `OpenAIProvider` defaults `contextWindow` to `UNKNOWN` — and failing them all would be worse than the status quo, and (b) if the request does overflow, the provider's own `contextOverflow` carries real `contextSize`/`tokenCount`, which beats any guess we could have made. `'error'` and an explicit `assumedContextWindow` are both available; trimming to a guessed limit is never the default.

### D12: Turn pairing rules, including two fixes the property tests forced

Turns are dropped whole and oldest-first, which is what makes "no orphaned assistant" fall out of the structure instead of being patched afterwards. The rules (full text in `src/core/context/layout.ts`): a turn opens at a `user` message; consecutive `user` messages merge into one turn (one reply answers both, so splitting strands half the prompt); consecutive `assistant` messages stay in the turn they answered; leading `assistant` messages form a prologue turn; a non-pinned `system` message (a rolling summary) forms a turn of its own; the newest turn is never dropped.

Two of these were wrong in the first implementation and were caught by the fast-check properties, not by the hand-written tests:

1. A non-pinned `system` message standing alone *unconditionally* split `[user, system, assistant]` into three turns, leaving the assistant as the newest turn — a textbook orphan. It now joins a turn that has not been answered yet.
2. `rollingSummary` with `keepRecentTurns: 0` summarized the newest turn, i.e. the question being asked. `keepRecentTurns` is now clamped to a minimum of 1.

Related: `pinSystemMessages` defaults to `'first'` (the system prompt only). Pinning *every* system message would make each rolling summary immortal, so a long conversation would accumulate summaries it could never retire.

### D13: A summary is a non-pinned `system` message marked by a content prefix

`Message` is `{ role, content, pinned? }` and widening it for the context manager would push a Phase 2 concern into the type every provider consumes. So a summary is marked in its content: role `system`, content starting with `[summary of earlier conversation]`. Role `system` because a summary is out-of-band context, not a turn anybody took — as an `assistant` message the model reads it as its own words. In the content because it then survives JSON storage, state updates, and providers that copy only the fields they know. **Not pinned**, which is what keeps it eligible to be folded into the next summary instead of accumulating; `analyzeConversation` explicitly pins the first *non-summary* system message so a leading summary cannot become "the system prompt" by accident.

When the summarizer fails, the default is to **degrade to `slidingWindow` for that request** and report a warning, not to fail: the user asked a question, not for a summary, and the failure modes here are the transient ones D9 documents. An abort always propagates regardless. `onSummarizerError: 'throw'` is available for apps where losing old context silently is the worse outcome.

### D14: The app-owned state slot is a zero-argument renderer, rendered idempotently into the system prompt

`systemState: () => string | undefined`, not `(state) => string`. The state belongs to the app; a closure reaches any store without threading a generic parameter through `fitContext`. The rendered block is delimited by a `[current state]` marker and any previous block is stripped before the new one is appended, so feeding a previous result back in replaces the block instead of stacking copies. This is the pattern the plan calls "recommended for purpose-built apps" and it is documented at length in `src/core/context/system-state.ts`: state rendered fresh every turn is always current and costs the same at turn 2 and turn 200, which is strictly better than hoping it survives in history.

### D15: `contextOverflow` is thrown, not returned; `fast-check` is a devDependency

A pass that cannot fit the pinned messages plus the newest turn throws `LLMError` `contextOverflow` (carrying the measured `tokenCount` and the budget as `contextSize`) rather than returning a result that says "impossible". The Phase 4 router already treats `contextOverflow` as a fallback trigger, so throwing means a context-manager overflow routes exactly like a provider's own; a result object saying "impossible" is too easy to hand straight to `generate()`.

`fast-check` was added as a **devDependency only** — `core` and `openai` keep zero runtime dependencies. The properties it drives (output never exceeds budget, pinned messages always survive, turns are never split, output is a subsequence of the input, unsatisfiable inputs always overflow) are the phase's acceptance criteria, and as D12 records, they found two real bugs that the hand-written edge-case tests did not.

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
