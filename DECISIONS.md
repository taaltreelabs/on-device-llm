# Decisions

Newest first. Each entry: what was decided, why, and what evidence it rests on. Supporting research lives in `docs/research/`.

## 2026-09-25 — Post-release

### D41: The package ships an Expo config plugin that applies the iOS 27 scene life cycle patch

D40 found that every fresh Expo 57 app crashes at launch on the iOS 27 SDK until three native edits are made. A README section alone leaves every new consumer to find it after a crash, and `prebuild --clean` silently undoes a hand-applied patch. So the package now ships a config plugin (`"plugins": ["@taaltreelabs/on-device-llm"]`) that makes the edits during `prebuild`.

It is written like the rest of the package:

- **The transforms are pure functions** in `src/plugin/scene-lifecycle.ts` with no Expo import. `src/plugin/index.ts` only wires them to `withAppDelegate` and `withInfoPlist`. The fixture is the `AppDelegate.swift` a pristine Expo 57 `prebuild` generates, and the main test asserts that the patched result is the same code as the hand migration verified on iOS 27 in D40, which is committed alongside it as a second fixture.
- **It recognises, or it refuses.** It rewrites only the template's exact start-up block (`#if os(iOS) || os(tvOS)` … `startReactNative` … `#endif`). A customised `AppDelegate`, an Objective-C one, or a half-migrated one (adopts `ExpoReactNativeFactoryProvider` but still starts React Native) is left untouched with a `prebuild` warning that points to the README's manual steps. Guessing at an unknown `AppDelegate` could start React Native twice, which is worse than the crash.
- **It is idempotent,** because `prebuild` without `--clean` runs mods over their own output. It also adds no `SceneDelegate` when another Swift file next to `AppDelegate.swift` already declares one, as a hand-migrated app does, since a second declaration would not compile. An `Info.plist` that already has a `UIApplicationSceneManifest` is left alone.
- **`SceneDelegate` goes at the bottom of `AppDelegate.swift`,** not in a new file, so the Xcode project needs no new file reference, which is the fragile part of any iOS config plugin.
- **Build-time only.** It is loaded through the root `app.plugin.js`, which is also listed in `exports` (Expo resolves the plugin through Node's resolver, which honours the `exports` map) and `files`, and it is not a subpath export: it runs under the Expo CLI and is never bundled into an app. It imports only `expo/config-plugins` (a peer) and Node built-ins, so the package keeps zero runtime dependencies. `check:pack` now requires `app.plugin.js` and `build/plugin/index.js`.

Verified end to end, not just by unit tests: the packed tarball was installed into a fresh app with only the plugin in `app.json`, `prebuild --clean` produced the patched `AppDelegate.swift` and scene manifest, and the app built and launched on an iOS 27.1 Simulator.

The example app now uses the plugin too (`"../app.plugin.js"` in `example/app.json`, a relative path because the example links the package from the repo rather than from `node_modules`), so a clean checkout prebuilds a launchable example and CI's example build exercises the plugin. A local `example/ios` that was migrated by hand is left as it is: the plugin sees the provider and the separate `SceneDelegate.swift` and changes nothing.

The plugin does not set the iOS 27.0 deployment target (D22). That stays with `expo-build-properties`, which owns it and which apps already use.

### D40: Phase 3's physical-device acceptance passed, against the published 0.1.2

`docs/plan.md` Phase 3 requires the maintainer to run the example app on a physical device, because simulator behaviour is not evidence for performance or availability handling. Run on an iPhone 17 Pro Max, iOS 27.0, with Apple Intelligence enabled. The app code was the example's, but the library was **`@taaltreelabs/on-device-llm@0.1.2` installed from npm** into a freshly prebuilt Expo 57 app, not the repo source the example normally links. That makes this a test of the published tarball too: the pod, the `build/` subpath exports and the type declarations all came from npm.

All passed, every reply "via apple": streamed chat; cancel mid-reply, with the next turn working normally; the JSON demo matching its schema; the tool demo calling a no-argument tool with `{}` (the D39 fix); multi-turn memory, and forgetting after the new Clear button; background and return during and after a reply; and a Polish prompt, answered in Polish on-device, matching what D19 recorded on the Mac. `supportsLocale` stays the only honest locale signal.

Two findings came out of building that fresh consumer app, neither in the library:

- **The Expo 57 `prebuild` template crashes at launch on the iOS 27 SDK.** It runs `UIScene life cycle is required for apps built with this SDK` because the template still starts React Native from `AppDelegate` without a scene. It never showed up in the example app because the maintainer's local `example/ios` had been migrated by hand (a `SceneDelegate: ExpoAppSceneDelegate`, a `UIApplicationSceneManifest` in `Info.plist`, and an `AppDelegate` that builds the factory but starts nothing). But `example/ios` is gitignored prebuild output, so that migration existed on one machine only; a clean checkout's example would have crashed the same way. Every new consumer following the README quick start will hit it. Like D22, it is a trap rather than a library defect; D41 addresses it with a config plugin.
- **The example imported `expo-constants` without declaring it.** It resolved from the repo root's `node_modules`. It is now listed in `example/package.json`.

### D39: A tool's parameters may be an empty object; a structured-output schema still may not

0.1.1 rejected every tool that takes no arguments. `normalizeJsonSchema` refuses an object with no properties, which is right for structured output (a schema with nothing to generate is a mistake) but wrong for tool parameters, where `{ type: 'object', properties: {} }` is the standard way to declare "no arguments" and is the shape `docs/tools.md` itself shows. Found by the example app's battery-tool demo failing with `invalidRequest` on the first post-release run.

The normalizer now takes `allowEmptyRootObject`, which only the Apple provider's tool-parameter encoding sets. It applies to the **root only**: a nested empty object is still rejected, because a property the model must fill with an object that has no fields is still a mistake. Measured against the live model before shipping, not assumed: the document the encoder emits (`properties: {}`, `required: []`, `x-order: []`, `additionalProperties: false`) decodes, and the model calls the tool with `{}` and answers from its result (`harness/Sources/Runner/ToolChecks.swift`, "a tool with no arguments round-trips").

### D38: The empty Android module stays in this package

After D37, `android/` holds only a placeholder: a Kotlin `OnDeviceLlmModule` that registers the name `OnDeviceLlm` and defines nothing else, plus its `build.gradle` and manifest (about 550 bytes in the 0.1.1 tarball). It stays, as do `"android"` in `package.json` `files` and the `android` platform in `expo-module.config.json`.

The reason is that an Expo app is almost always built for both platforms, and this package must not break the Android build of an app that uses it only for iOS and the cloud. With the placeholder, Android autolinking finds a real, valid module; the Apple provider's `Platform.OS === 'ios'` gate (D37) reports `unavailable`/`unsupportedPlatform`; and the router falls through to the next provider exactly as it would on an older iPhone. Removing the directory while leaving `android` in the platforms list would point autolinking at a module that does not exist, and removing the platform too is a packaging change whose effect on consumer Android builds we have not measured.

The placeholder must stay empty. It is not the start of an Android provider — that lives in `@taaltreelabs/on-device-llm-android`, under a different native-module name (`OnDeviceLlmAndroid`) so the two can never collide. Revisit only if the placeholder causes a real consumer build problem.

## 2026-09-23 — Package split

### D37: The Android provider moves to its own package, `@taaltreelabs/on-device-llm-android`

Maintainer call, made independently of the wave-2 hardware spike this package's own DECISIONS.md had queued up (the local `android-provider` branch's D33–D36 and the "Packaging tripwires" register). The reasoning is naming and honesty, not engineering risk: this package's name, `@taaltreelabs/on-device-llm`, promises on-device-and-private, and Google's ML Kit GenAI terms for the Android engine (Gemini Nano) carry an asterisk that promise cannot silently absorb — metrics telemetry sent to Google, plus a pass-through disclosure duty onto the consuming app's own users. Apple's FoundationModels path has neither: no network calls, nothing sent to Apple, no disclosure duty. A single package cannot make one honest privacy claim when its two providers behave that differently, so the provider whose terms carry the asterisk gets its own, separately-named home instead of a footnote.

**What moved** (to `github.com/taaltreelabs/on-device-llm-android`, built by a separate agent in parallel with this split): the Kotlin bridge module and its 60 JVM unit tests, the `src/android` TypeScript wrapper that existed only on the local `android-provider` branch, the `docs/research/android-genai.md` recon document, and decisions D33–D36 together with the PROVISIONAL register they anchor — all of it now lives, and continues to evolve, in the companion repo. None of that ever reached `origin/main`, so this split touches no code here beyond the Apple resolver hardening below.

**What stayed**: `src/apple/native/resolve.ts`'s `Platform.OS === 'ios'` gate (added on `android-provider` as commit `6b19aa9`, ported here) stays as defense-in-depth. It no longer guards against a same-named, wire-identical Kotlin module living in this repo — that module is gone from this package's universe entirely, and the companion package's own Android provider deliberately registers under a different native-module name (`OnDeviceLlmAndroid`) so it can never collide. But duck-typing still cannot prove a platform, only a shape, so the gate remains: cheap, load-bearing, and worth the comment warning future refactors not to remove it for looking unidiomatic.

**Disposition of the open packaging question**: the "Packaging tripwires" register on `android-provider` left one-vs-two-package open pending three wave-2 findings — T1 (firewall fragility under R8/minification), T2 (toolchain coupling from tracking a beta SDK), T3 (release-cadence mismatch between a stable Apple side and a fast-moving Android beta). This decision **resolves** that question by maintainer fiat rather than by the spike answering it: the split happens regardless of what T1–T3 would have shown, because the deciding factor turned out to be naming and disclosure obligations, not build fragility or release cadence. Concretely: **T3 is moot** — a separately-versioned package cannot suffer a cadence mismatch with this one, because there is no shared version to mismatch. **T1 and T2 remain live, but as ordinary technical questions for the new repo's own wave 2**, not as inputs to a decision that has already been made; the `compileOnly` firewall and its R8 keep-rules, and the Kotlin/AGP version coupling, still need the hardware spike — they just no longer gate whether the package is split, only how solid the split package's own build is.

The `android-provider` branch is superseded by this split and is not merged or deleted; it is retained locally for history, since it is the only record of wave 1's Kotlin work prior to its move to the companion repo.

## 2026-09-22 — Phase 4 (router)

### D28: The routing policy is declarative data with one narrow escape hatch, and it only picks the *first* provider

`policy` is either a `RoutePolicyRules` object — `preferred`, `require`, `tags`, `where` — or a function `(context) => providerId | undefined` (shorthand for `{ select: fn }`). The two coexist for a reason each: the object form is inspectable, serializable, diffable in a review, and testable from a literal without running anything, which is what a routing rule needs to be when it decides where a user's words go; the function form exists because no fixed vocabulary survives contact with a real app, and the alternative to an escape hatch is a config language that grows one field per user.

Three constraints on the shape are load-bearing:

1. **The policy chooses a starting point, not an execution plan.** Fallback order after the first choice is always the configured order. A policy that returned an ordering could silently reinvent — or disable — the fallback machinery, and `attempts` would stop being comparable between requests.
2. **`require` can only ever narrow the field.** A constraint may make the router run out of providers; it can never send a request somewhere it would not otherwise have sent one. That makes "could this policy leak a prompt to the cloud?" answerable by reading `providers` alone.
3. **`select` outranks `require` for its own choice, and an unknown id is ignored.** An explicit choice beats a declarative filter — and the function was handed availability, capabilities and token counts, so it could have checked. An id naming no configured provider falls through to the rules rather than failing the request.

The candidate facts a policy sees are exactly the facts the router used (`RouteCandidate`: availability, capabilities, `tokens`, `tokenSource`, `fitsContextWindow`, `index`), so a predicate never re-derives them and never pays for the native calls twice.

**The context-window check.** `estimateTokens` is computed once per request as the baseline; a provider's own `countTokens()` is called only when it has one *and* a known `contextWindow` — the only case where an exact number can change the decision. An `UNKNOWN` window is **not** a disqualifier (`fitsContextWindow: 'unknown'`), following D11: every cloud endpoint is in that state, refusing them all would be worse than trying, and a provider that cannot describe its window still reports a real `contextOverflow` with real numbers. `maxOutputTokens` is counted against the same window because Apple's `contextSize` is a combined input+output budget. No safety margin is applied here — that is `fitContext`'s job, and a router that applied its own would skip providers twice over.

**Cache and staleness.** Routing reads availability/capabilities through a per-provider TTL cache (`cacheTtlMs`, default 5 000 ms; `0` disables it; concurrent lookups share one in-flight promise). Three providers behind an uncached router is six native round trips before a single token. The staleness is safe in the direction that matters: per D9 `available: true` never meant "the next request will succeed", so a stale `true` costs nothing a fresh one would not — the failure is what the fallback chain is for. A stale `false` can pass over a provider that just became usable, which is bounded by the TTL, self-correcting, and strictly less costly than the alternative. The router's own `availability()`/`capabilities()` always refresh and reprime the cache, so they double as the "check now" call and as the invalidation hook `useAvailability` needs.

### D29: The task tag rides on `GenerateRequest`, not on `RequestOptions` or `Message`

`GenerateRequest.taskTag?: string`. The plan calls for "a caller-supplied task tag (for example `simple` vs. `reasoning`)" and there were three places to put it.

Not on `Message`: a tag describes the whole request, not one turn, and widening `Message` pushes a routing concern into the type every provider, every strategy and every stored conversation consumes (the same argument that kept the summary marker out of `Message` in D13).

Not on `RequestOptions`: that bag holds the things that *cannot* be serialized and change on every invocation — an `AbortSignal` and a tool dispatcher. A tag is plain data that should survive being stored, replayed, logged as metadata, and threaded through the context manager and the hooks alongside the messages it describes. Putting it in `RequestOptions` would also force `useChat` to thread a second parameter through every call site that already carries a request.

So it goes on the request, through the seam `generation.ts` documents for exactly this ("a provider written today keeps compiling; it just ignores what it does not know"). The contract added with it is explicit and normative: **every provider must ignore `taskTag`, and in particular must not reject a request for carrying one.** The `openai` and `apple` providers build their native payloads field by field from `messages`/`schema`/`tools`/sampling options and never spread the request, so both already ignore it cleanly; a routed request arrives at its provider with the tag still attached, which is the case that would otherwise break.

### D30: Default fallback triggers — including `rateLimited` on, `unsupportedLocale` on, and `unknown` split in two

| code | default | configurable |
| --- | --- | --- |
| `unavailable` | **on** | yes |
| `contextOverflow` | **on** | yes |
| `network` | **on** | yes |
| `rateLimited` | **on** | yes |
| `guardrail` | off | yes |
| `unsupportedLocale` | **on** | yes |
| `unknown` + `transient === true` | **on** | yes (`unknownTransient`) |
| `unknown`, otherwise | off | yes (`unknown`) |
| `cancelled` | never | **no** |
| `invalidRequest` | never | **no** |

The first three and `guardrail` are the plan's (§4/§5). The rest:

- **`cancelled` and `invalidRequest` are not fields on `FallbackTriggers` at all.** A boolean nobody may set to `true` is a boolean that eventually gets set to `true` by accident, so the prohibition lives in the type — `{ fallback: { cancelled: true } }` does not compile — and the runtime asserts it independently. `cancelled` means the caller asked to stop, and spending a second provider's money and battery is the one thing they definitely did not want. `invalidRequest` will be just as invalid at the next provider (D6's rejected schema constructs, D17's missing trailing user message).
- **`rateLimited` on.** Failing over is not retrying: `resetDate` may be minutes away, the limit belongs to *that* provider, and a second provider is precisely the thing that makes a rate limit survivable. Same-provider retry stays out of the router entirely (see D31).
- **`unsupportedLocale` on.** A capability gap, not a malfunction. Apple enumerates 24 locales (D7) and a cloud model usually covers the rest, so falling back is the behaviour a Polish-speaking user wants, and the alternative is erroring on something another configured provider can do. Switchable because it does mean the prompt leaves the device — the same trade `unavailable` already makes by default.
- **`unknown` split.** D9 created this lane and D25 populates it: `transient: true` is a provider saying "this may work elsewhere or later" (a wedged model manager, a tool-call timeout), which is the exact signal a router exists to act on, so it is on. `transient: false` is a deterministic failure in app code (a tool handler that threw) and must not be retried. `transient: undefined` is a provider that does not know, and treating "don't know" as retryable makes every mystery failure cost two generations and two bills — so `undefined` shares the `false` switch, off by default.
- An unrecognised future code (`timeout`, `refusal`, `parseError` are the ones `errors.ts` names) defaults to **not** falling back. A failure nobody has classified should propagate until someone decides what it means.

### D31: One shot per provider; the last real error is rethrown, and the chain lives on `onRoute`

A provider is tried **at most once per request**. Same-provider retry needs backoff, jitter and a budget, all of which belong to the caller who knows whether this is a background summarisation or a user watching a spinner — and a router that retried internally would make `attempts` useless as a telemetry signal.

When every provider fails, the router **rethrows the last real `LLMError`, verbatim, with the failing provider's own `providerId`**. A `RouterExhaustedError` was considered and rejected: `errors.ts` exists precisely so that there is one error class and no `instanceof` ladder, and a new class would break every `catch (e) { if (isLLMError(e)) … }` written against it. The attempt chain is not lost — it goes to `onRoute`, which is where telemetry belongs and where it cannot tempt anyone into control flow.

A synthetic error is constructed only when **no provider was asked at all**: `unavailable` (with the most hopeful aggregated reason and a `detail` listing every provider's verdict) when every skip was an availability skip, `contextOverflow` (carrying the real window and the measured tokens) when a window skip was involved, and `invalidRequest` otherwise, since a `require` block no provider can satisfy is a request that will fail again unchanged.

**Streaming.** The fallback window closes on the first event **handed to the consumer**. Events are forwarded as they arrive and are never pre-buffered to widen that window — buffering a stream to make the router's job easier turns every stream into a non-stream, which is the thing streaming exists to avoid. `toolCall` counts as a yielded event: by the time a consumer sees one, a handler the app wrote has already run, and a second provider would run it again (D24). A consumer that breaks out of its `for await` is recorded as `cancelled`, not as a success.

### D32: The router's `capabilities()` reports one provider's answer, never a merge

`availability()` is available iff **any** provider is (a router's job is to find a working provider; reporting the preferred one would have a perfectly functional router claim to be broken because a model is still downloading), with the aggregated reason and a per-provider `detail` when none is.

`capabilities()` returns the **preferred available provider's** capabilities verbatim. A merge is a lie in both directions: union the booleans and the router claims tool calling the chosen provider cannot do; intersect them and it denies structured output the chosen provider supports perfectly well, so callers stop asking for it; take the largest `contextWindow` and the context manager budgets 128K for a request about to go to a 4K on-device model. One provider's honest answer beats a synthetic one nobody can act on, and the next request most likely goes to that same provider.

`countTokens` and `prewarm` are optional *per instance*, so their presence is decided once at construction — present iff **some** configured provider has it — because a method cannot appear later just because a provider came back, and a caller that captured `router.countTokens` must not find it gone. Which provider serves the call is decided per call (preferred available provider that has it). When no available provider can count, `countTokens` **throws** rather than estimating: `createMeasure` catches exactly that and records `estimatorAfterCounterFailure`, widening the safety margin from 64 to 256 tokens (D10, D27). A silent estimate would keep the narrow margin under an exact-looking number, which is how a "measured" budget overflows. `prewarm` never throws and answers `false` when there is nothing to warm (D26).

## 2026-09-21 — Phase 3 steps 4–7 (prewarm, tokens, structured output, tools)

### D23: D6 upheld — normalize in TypeScript, `JSONDecoder` in Swift — but the supported set is smaller than the *decodable* set

D6 proposed normalizing the developer's JSON Schema in TypeScript and decoding it natively through `GenerationSchema`'s `Codable` conformance, with `DynamicGenerationSchema` construction as a fallback if the decode proved too limited. **The decode path is confirmed and is the only path we ship**; no tree-walk into `DynamicGenerationSchema` exists in the codebase.

The worry behind the fallback clause was that the decoder silently drops constraints (sdk-surface.md §7 measured `minLength`, `maxLength`, `format` and `multipleOf` disappearing). Measured against the framework: every constraint we actually promise survives. The harness decodes the fixture document and re-encodes the resulting `GenerationSchema`, and `minimum`, `maximum`, `enum`, `minItems` and `maxItems` are all still there. Silent dropping is not a property of the decoder, it is a property of *those four keywords* — and the normalizer rejects all four (and the rest of the unhonourable set) by name and path, so nothing reaches the decoder that it would quietly discard.

**The surprise, and the reason the split is where it is.** `pattern` decodes *and* survives the round trip — and then fails at generation time with `LanguageModelError.unsupportedGenerationGuide` on AFM 3 Core Advanced. "The schema was accepted" and "the model will generate against it" are different questions, and only the second one matters to a caller. So:

- the **portable** normalizer lives in `src/core/schema.ts`: it validates the subset, inlines non-recursive `$ref`, rejects `allOf`/`oneOf`/`not`/conditionals, type unions, recursive `$ref`, tuple `items`, non-string enums, `additionalProperties: true` and every accepted-then-ignored constraint, each with the keyword and its path in the message; it emits a small IR, and drops a documented list of annotations (`$schema`, `$id`, `$comment`, `default`, `deprecated`, `examples`, `readOnly`, `writeOnly`);
- the **Apple** encoder lives in `src/apple/schema.ts`: it writes the dialect the decoder demands (`title`, `additionalProperties`, `required` and Apple's `x-order` on every object node, `required: []` included) and rejects `pattern` — a fact about *this model*, not about JSON Schema, which is exactly why it does not belong in `core`.

A future provider reuses the normalizer and writes its own encoder. `harness/Sources/Runner/ConstraintMatrixChecks.swift` keeps the supported/unsupported split honest against the live model; it is the regression test for a future OS widening or narrowing the set.

### D24: Tools are definitions *with their handlers*, per request, and a request carrying tools runs on the streaming path

`GenerateRequest.tools` carries `{ name, description, parameters, execute }` — the handler travels with the definition. The alternatives were configuring handlers on the provider (wrong: tools belong to a conversation, not to a model, and the Phase 4 router picks the provider per request) or passing a parallel handler map (wrong: two structures to keep in sync, and the failure — a definition with no handler — surfaces mid-generation with a call already in flight). Keeping them together makes "every tool the model can see has something to run" checkable before the request starts, which `buildNativeRequest` does; `RequestOptions.onToolCall` is the documented fallback for an app that dispatches every tool through one function.

The protocol, end to end: native `BridgedTool.call` registers a continuation under a fresh `callId`, *then* emits a `toolCall` event (registering first is not an ordering nicety — emitting first opens a window in which a fast handler answers a `callId` the registry has never heard of, which the late-reply rule would then correctly and fatally ignore) → TypeScript starts the handler **without awaiting it**, so two calls can be in flight → `resolveToolCall(callId, resultJSON | errorMessage)` → the continuation resumes and generation continues to completion. A string result is passed through; anything else is `JSON.stringify`d.

`generate()` with tools delegates to `stream()` and folds the events into the result. A tool call has to reach JavaScript *mid-generation* and `native.generate` is one promise with no event channel; building a second tool protocol for the non-streaming path would have doubled the surface for no behaviour. `finishReason: 'toolCalls'` therefore never appears in practice — the framework resolves tool calls internally and finishes normally — and is reserved for a generation that genuinely ends with calls outstanding.

`toolCall` is emitted to the consumer as a `StreamEvent` for observability only; there is deliberately no `toolResult` event, because the handler is the caller's own code and already knows what it returned.

### D25: A tool call has a deadline (default 30s); timeout is transient, a handler failure is not, and cancellation resumes every continuation

Every prior-art bridge surveyed in D2 has neither a timeout nor cancellation of an in-flight tool call, which means a handler that forgets to answer pins the neural engine for the life of the process with nothing in the log. Ours:

- **Timeout** (`AppleProviderConfig.toolCallTimeoutMs`, default 30 000): the registry arms a timer per call; when it fires the continuation is resumed with an error and the request fails as `unknown` with `transient: true`. Transient because the request was well-formed and the thing that failed — an app handler waiting on the network, a JS thread behind a render — may well succeed on a retry, and `transient` is the hint the Phase 4 router branches on.
- **Handler failure** → `unknown` with `transient: false`: app code failed deterministically as far as we can tell, so a router must not treat it as a reason to retry elsewhere. The handler's original `Error` is preserved as the `LLMError`'s `cause` (the native side only knows *that* a tool failed; only the JavaScript half still holds the exception), with the native diagnostics alongside it.
- **Cancellation**: `cancel(requestId)` resumes every pending continuation for that request *and* cancels the generation task. Cancelling the task alone is not enough — the framework cannot interrupt our `await`, so the tool call would stay suspended. Handlers are also handed an `AbortSignal` that fires when the request ends, however it ends.
- **Late and duplicate replies are no-ops** returning `false`, never crashes. Resuming a continuation twice is fatal in Swift, and the race is entirely normal: JavaScript cannot know the native timer fired. A registry keyed by `callId` (not by `requestId`) is what makes two concurrent calls safe.

Verified against the live model: a tool round trip, a timeout firing, and a cancel mid-call leaving `pendingCount == 0`; plus registry-level checks for double-resolve, out-of-order concurrent resolution and post-cancel replies. The TypeScript half is covered over the fake native module (11 checks).

### D26: `prewarm` is exposed as a hint with a boolean answer, and is documented as making no promise

`LanguageModelSession.prewarm(promptPrefix:)` exists, returns immediately, reports nothing, and the framework is free to ignore it; Apple's guidance is to call it only when a second or more will pass before the request. We expose it as optional `prewarm(messages?)` on `LLMProvider`, resolving `true` when the hint was delivered and `false` when there was nothing to deliver it to (wrong platform, older native half) — and it never throws, because a caller has nothing to do about a failed hint.

It deliberately makes no performance claim, and the harness deliberately asserts none: `prewarm` then `generate` works, and prewarming a history that ends with an assistant turn is allowed (the case it is *for* — a chat screen open and a user still typing, which is why `TranscriptBuilder.prepare` grew a `requirePrompt: false` mode that token counting also uses). Any timing assertion against a shared machine would be a flaky test dressed up as evidence.

### D27: `capabilities()` answers from the model's flags *and* from what the native half implements

`structuredOutput` follows `LanguageModelCapabilities.guidedGeneration`, `tools` follows `toolCalling` **and** the presence of `resolveToolCall` on the resolved native module, and `tokenCounting` is `'exact'` when `countTokens` is present. The second half of each conjunction is not defensive programming for its own sake: npm makes a JavaScript half newer than the installed native half entirely possible, and a provider that advertises a protocol the native side cannot speak sends the Phase 4 router *toward* a provider that is about to fail. `countTokens` throws rather than estimating on failure, which is what lets `createMeasure` record `estimatorAfterCounterFailure` and widen the safety margin from 64 tokens to 256 (D10) — a silent estimate here would keep the narrow margin under an exact-looking number, which is how a "measured" budget overflows.

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

### D6 (resolved by D23): Structured output via JSON Schema normalization in TypeScript + `GenerationSchema` `Codable` decode in Swift

> **Resolved 2026-09-21 (D23).** The decode path was validated in Phase 3 and is the only path shipped; the `DynamicGenerationSchema` fallback below was never needed. D23 also narrows the *supported* set below the *decodable* one (`pattern` decodes but fails at generation time). The original entry is kept as written.

The SDK dump found `GenerationSchema` decodes a JSON Schema document directly (needs `title`, `additionalProperties`, `required`, Apple's `x-order`; silently drops `minLength`/`maxLength`/`format`/`multipleOf`; rejects `allOf` and `type: ["string","null"]`). Plan of record: normalize/validate the developer's JSON Schema in TypeScript (rejecting the unsupported subset loudly as `invalidRequest`), then decode natively — keeping the fiddly logic in TS per the maintainer's preference. Falls back to `DynamicGenerationSchema` construction (verified capable) if decode proves too limited. Evidence: `docs/research/sdk-surface.md` §schema.

### D7: `unsupportedLocale` is not an availability reason

`SystemLanguageModel.Availability.UnavailableReason` has exactly three cases (`deviceNotEligible`, `appleIntelligenceNotEnabled`, `modelNotReady`). Locale problems surface as the generation error `unsupportedLanguageOrLocale`, predictable up front via `supportsLocale()`. The error taxonomy keeps `unsupportedLocale`, but it maps from the generation path, and `availability()` results are enriched with a locale pre-check rather than a native reason code. The plan's §2 taxonomy is amended accordingly. 24 locales supported; TaalTree's four (nl, fr, de, es) all included.

### D8: `fm` CLI / `fm serve` is a local-dev test rig only

Integration tests use it when reachable and skip otherwise (as planned). Two additions from recon: (a) the macOS 27 `fm` license text arguably forbids programmatic use in shipped products — it never ships in or near the package; (b) known upstream quirks to avoid in tests: `tool_choice: "auto"` is broken, recursive `$defs` hang the server, responses stream SSE even without `stream: true`. Evidence: `docs/research/prior-art.md` §fm quirks, plus direct probing (2026-09-20).

### D9: Availability is necessary but not sufficient — the taxonomy needs a transient system-failure lane

Observed live on this Mac: `availability == .available` while all generation fails with `com.apple.SensitiveContentAnalysisML error 15` and token counting with `ModelManagerError 1013`, and `contextSize` returns `0`. Consequences: (a) guard `contextSize <= 0`; (b) untyped `NSError`s from the native layer map to a retryable `unknown` rather than crashing the request path; (c) the router may treat repeated unknown-transient failures as a fallback trigger (design in Phase 4). Evidence: `docs/research/sdk-surface.md` §surprises.
