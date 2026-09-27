# iOS 26 compatibility: what running on iOS 26 costs

The Apple provider runs on **iOS 26.0 / macOS 26.0** and later, the release that shipped FoundationModels. This supersedes the iOS 27 floor in DECISIONS.md D4.

The **podspec** floor is lower still: **iOS 16.4**, ExpoModulesCore's own, so an app that still supports iOS 17–25 links the module and gets `unavailable` / `unsupportedPlatform` below 26 (see "The 16.4 podspec floor" below). The sections before it cover what the bridge loses on iOS 26 compared with 27.

Method: `harness/Package.swift` was lowered to `.macOS("26.0")`, and `ios/Core/*.swift` was typechecked with `xcrun swiftc -typecheck -swift-version 6` against the iOS 27.1 simulator SDK at `-target arm64-apple-ios26.0-simulator`. Every compiler error is a symbol newer than the floor. The compiler reports errors in layers: type-resolution errors hide expression-level ones. The list below is the union over all iterations, taken until both builds were clean.

## Symbols newer than 26.0, and how each is handled

| Symbol                                                                                                                                     | Available from | Where                                          | Handling                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `LanguageModelError`                                                                                                                       | 27.0           | `ErrorMapping.swift`                           | mapped under `#available(iOS 27.0, macOS 27.0, *)`                                            |
| `LanguageModelSession.Error`                                                                                                               | 27.0           | `ErrorMapping.swift`                           | same                                                                                          |
| `SystemLanguageModel.Error`                                                                                                                | 27.0           | `ErrorMapping.swift`                           | same                                                                                          |
| `GeneratedContent.ParsingError`                                                                                                            | 27.0           | `ErrorMapping.swift`                           | same                                                                                          |
| `LanguageModelSession.Response.usage`                                                                                                      | 27.0           | `GenerationEngine.swift` (2 sites)             | `reportedUsage(of:)`: empty `BridgeUsage` below 27                                            |
| `LanguageModelSession.ResponseStream.Snapshot.usage`                                                                                       | 27.0           | `GenerationEngine.swift` (2 sites)             | same                                                                                          |
| `LanguageModelSession.Usage`                                                                                                               | 27.0           | `GenerationEngine.mapUsage`                    | `mapUsage` marked `@available(iOS 27.0, macOS 27.0, *)`                                       |
| `SystemLanguageModel.tokenCount(for:)`, the transcript-entries, `Prompt`, `GenerationSchema` and `[any Tool]` overloads                    | **26.4**       | `GenerationEngine.countTokens` (4 sites)       | `guard #available(iOS 26.4, macOS 26.4, *)`, else throws `invalidRequest`                     |
| `SystemLanguageModel.variant`                                                                                                              | 27.0           | `ModelInfo.capabilities`, harness `main.swift` | fallback `modelLabel: "Apple Foundation Model"`; harness prints the label through `ModelInfo` |
| `SystemLanguageModel.capabilities`, `LanguageModelCapabilities.contains(_:)`, `.vision`, `.guidedGeneration`, `.toolCalling`, `.reasoning` | 27.0           | `ModelInfo.capabilities`                       | fixed fallbacks on 26 (see below)                                                             |
| `LanguageModelError` (harness)                                                                                                             | 27.0           | `ConstraintMatrixChecks.swift`                 | typed check under `#available`, plus the 26 `GenerationError.unsupportedGuide` spelling       |

Everything else the bridge uses compiled at 26.0 unchanged, so it needed no work:

- `contextSize`: back-deployed. It returns a literal 4096 below 27.
- `GenerationOptions(samplingMode:temperature:maximumResponseTokens:)`: back-deployed before 27.
- The `respond` and `streamResponse` overloads that take `includeSchemaInPrompt:`.
- `prewarm(promptPrefix:)`.
- `Transcript.Instructions` and `Transcript.Response(assetIDs:segments:)`.
- `Tool` and `LanguageModelSession.ToolCallError`.
- `GenerationSchema`'s `Codable` decode and `GeneratedContent.jsonString`.
- `availability`, `supportedLanguages` and `supportsLocale`.

### Error mapping on iOS 26

`mapNativeError` tries the iOS 27 types under `#available`. It then tries the deprecated `LanguageModelSession.GenerationError` on every OS, and falls back to `NSError` last. The 26 mapping:

| `GenerationError` case           | Bridge code                            | Lost compared with 27       |
| -------------------------------- | -------------------------------------- | --------------------------- |
| `exceededContextWindowSize`      | `contextOverflow`                      | `contextSize`, `tokenCount` |
| `assetsUnavailable`              | `unavailable`, `reason: modelNotReady` | none                        |
| `guardrailViolation`             | `guardrail`                            | none                        |
| `refusal`                        | `guardrail`                            | none                        |
| `unsupportedGuide`               | `invalidRequest`                       | none                        |
| `unsupportedLanguageOrLocale`    | `unsupportedLocale`                    | `locale`                    |
| `decodingFailure`                | `unknown`, `transient: true`           | `rawContent`                |
| `rateLimited`                    | `rateLimited`                          | `resetDate`                 |
| `concurrentRequests`             | `invalidRequest`                       | none                        |
| future case (`@unknown default`) | `unknown`, `transient: true`           | none                        |

Every row carries `Context.debugDescription` as `nativeDetail`.

The enum is `deprecated: 27.0`. The deprecation warnings are silenced locally, with no repo-wide flag:

- The mapping lives in a method that is itself `deprecated: 27.0`.
- That method is called through a non-deprecated protocol requirement (`GenerationErrorMapping`).

A typecheck at both a 26.0 and a 27.0 target produces zero warnings.

## `capabilities()` keys

All keys are present on every OS.

| Key                        | iOS/macOS 27+                              | 26.4–26.x                    | 26.0–26.3                  |
| -------------------------- | ------------------------------------------ | ---------------------------- | -------------------------- |
| `contextWindow`            | `contextSize` (`0` if ≤ 0)                 | 4096 (back-deployed literal) | 4096                       |
| `locales`                  | `supportedLanguages` (minimal ids)         | same                         | same                       |
| `modelLabel`               | `variant.displayName`                      | `"Apple Foundation Model"`   | `"Apple Foundation Model"` |
| `supportsVision`           | `capabilities.contains(.vision)`           | `false`                      | `false`                    |
| `supportsGuidedGeneration` | `capabilities.contains(.guidedGeneration)` | `true`                       | `true`                     |
| `supportsToolCalling`      | `capabilities.contains(.toolCalling)`      | `true`                       | `true`                     |
| `supportsReasoning`        | `capabilities.contains(.reasoning)`        | `false`                      | `false`                    |
| `tokenCounting`            | `"exact"`                                  | `"exact"`                    | `"estimated"`              |
| `usageReporting`           | `true`                                     | `false`                      | `false`                    |

The 26.4–26.x and 26.0–26.3 values for `contextWindow` are read from the SDK interface, not measured.

`countTokens` below 26.4 returns `{ ok: false, error: { code: "invalidRequest", message: "Exact token counting requires iOS 26.4 or later" } }`.

## What a consumer loses on iOS 26

- **`contextOverflow` without numbers.** No `contextSize` or `tokenCount`, so the context manager cannot correct its estimator from an overflow.
- **Parse failures without `rawContent`.** `decodingFailure` carries only a debug description.
- **No `usage`.** Results omit `usage` entirely. As a result, `finishReason` is always `stop`, even when `maxOutputTokens` truncated the response, because `length` is inferred from `usage.outputTokens`.
- **No `locale` on `unsupportedLocale`, and no `resetDate` on `rateLimited`.**
- **Estimated token counting on 26.0–26.3.** `tokenCount(for:)` is 26.4+.
- **Fallback `modelLabel` and capability flags.** They reflect what 26.0 shipped with (`GenerationSchema` and `Tool` exist; image input and reasoning do not), not a per-device query.

## Verification: what was run and what was only compiled

**Run live, on macOS 27.2 (26B5091g) with model `AFM 3 Core Advanced`.** `npm run harness:apple` reported 42 passed, 0 failed. These checks cover all the iOS 27 paths, including exact token counting. The new `compat` group also _runs_ two things on this machine:

- the full iOS 26 `GenerationError` mapping table. `Context(debugDescription:)` and `Refusal(transcriptEntries:)` are public, so each case is constructed and pushed through `mapNativeError`, including one wrapped in `ToolCallError`.
- the `capabilities()` contract keys, and a check that `usageReporting` agrees with whether a real result carries usage.

**Compiled only (no iOS/macOS 26 runtime was available at the time; the iOS 26.5 Simulator run below has since exercised the capability fallbacks and `"exact"` token counting, but still no successful generation):**

- the `else` branches of every `#available` check: empty usage, the `invalidRequest` throw in `countTokens`, the capability fallbacks and `"estimated"`.
- whether iOS 26 actually _throws_ `GenerationError` in the situations sdk-surface.md §5 documents.
- all generation behaviour on 26.x. The D23 constraint matrix, the D21 cancellation behaviour and the tool-calling round trips were measured on 27 only.

The compile checks that passed with zero diagnostics:

- `swift build --package-path harness` at `.macOS("26.0")`.
- `swiftc -typecheck` of `ios/Core/*.swift` at `arm64-apple-ios26.0-simulator`, `…ios27.0-simulator` and, as a probe, `…ios18.0-simulator`.
- `pod ipc spec ios/OnDeviceLlm.podspec`, which parses with `platforms.ios = "16.4"` and `weak_frameworks = "FoundationModels"` (it read `"26.0"` before the floor was lowered further; see below).

`OnDeviceLlmModule.swift` cannot be typechecked standalone, because it needs ExpoModulesCore. It is compiled by the example app build below.

## Groundwork for a floor below 26

Every `ios/Core` declaration that names a FoundationModels type is annotated `@available(iOS 26.0, macOS 26.0, *)`: `GenerationEngine`, `ModelInfo`, `SchemaCodec`, `TranscriptBuilder`, `PreparedRequest`, `BridgedTool`, `mapNativeError` and the legacy mapper.

`ToolCallRegistry`, `RequestRegistry`, `SnapshotDiffer` and the bridge types name no FoundationModels types, so they are unannotated.

The two remaining changes this section used to list (module-level guards and weak linking) are now done; see the next section.

## The 16.4 podspec floor

`ios/OnDeviceLlm.podspec` now declares `:ios => '16.4'`, the floor of `ExpoModulesCore.podspec` and the Expo template's default deployment target. Expo autolinking silently drops any pod whose platform is above the app's target (D22). At a 26.0 floor, an app that still supports iOS 17–25 would build green without the module and get `unsupportedPlatform` everywhere, including on iOS 26+. At 16.4 the same app links the module, gets the on-device model on iOS 26+, and falls back to the cloud below 26.

Three things make this safe:

1. **Weak linking.** `s.weak_frameworks = 'FoundationModels'` makes CocoaPods add `-weak_framework "FoundationModels"` to the app's `OTHER_LDFLAGS` (`Pods-<app>.debug.xcconfig`). The toolchain would get there without it. `nm -m libOnDeviceLlm.a` shows all **203 of 203** undefined FoundationModels symbols as `weak external`, because Swift emits a reference to anything newer than the deployment target as weak. `ld` weak-links a dylib when every reference into it is weak, and the module's autolink entry (`LC_LINKER_OPTION`) is only a plain `-framework FoundationModels`. The podspec line states the intent. It also guards against the day one strong reference slips in.
2. **Module-level guards.** `OnDeviceLlmModule` cannot be `@available(iOS 26.0, *)`, because Expo instantiates it on every OS. So every `AsyncFunction` body starts with `guard #available(iOS 26.0, *)`. The guard cannot be shared through a wrapper closure, because availability refinement is lexical. The fallback values all live in one private `UnsupportedPlatform` enum, and they use the existing wire shapes:

   | Function                                                 | Below iOS 26                                                                                                                                                                    |
   | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `availability()`                                         | `{ available: false, reason: "unsupportedPlatform", detail: "Apple FoundationModels needs iOS 26 or later; this device runs an older iOS." }`                                   |
   | `capabilities()`                                         | every key present: `contextWindow: 0`, `locales: []`, `modelLabel: "Apple Foundation Model"`, all four `supports*` false, `tokenCounting: "estimated"`, `usageReporting: false` |
   | `supportsLocale`, `prewarm`, `resolveToolCall`, `cancel` | `false`                                                                                                                                                                         |
   | `countTokens`, `generate`                                | `{ ok: false, error: { code: "unavailable", reason: "unsupportedPlatform", message } }`                                                                                         |
   | `startStream`                                            | the same error, emitted as an `onStreamEvent` of `type: "error"` for that `requestId`, through the same `send(.error(...))` path a parse failure uses                           |

   `src/apple/errors.ts` already accepts `unsupportedPlatform`, so the TypeScript side needed no change. `RequestRegistry` and `ToolCallRegistry` name no FoundationModels type, so they stay plain stored properties. Below 26 they simply stay empty. `runGenerate` and `startStream` are `@available(iOS 26.0, *)`.

3. **Core availability.** `xcrun swiftc -typecheck -swift-version 6 -target arm64-apple-ios16.4-simulator ios/Core/*.swift` (iOS 27.1 simulator SDK) is clean with zero diagnostics, as are the same checks at `ios26.0` and `ios27.0`.

### Build evidence (example app at the Expo default target)

`example/app.json` no longer carries the `expo-build-properties` `ios.deploymentTarget` override. `prebuild --clean` and `pod install` produced:

- a Podfile platform of `16.4` (the template default) and the app target at `IPHONEOS_DEPLOYMENT_TARGET = 16.4`;
- `OnDeviceLlm (0.2.0)` in `Podfile.lock`, so the module is autolinked at the default target. At the old 26.0 or 27.0 floor, D22's trap would have dropped it;
- the `OnDeviceLlm` pod target at `IPHONEOS_DEPLOYMENT_TARGET = 16.4`. Its `SWIFT_VERSION` is `5.0` from CocoaPods, so strict concurrency is covered by the Swift 6 typecheck above rather than by this build.

`xcodebuild … -sdk iphonesimulator` (Xcode with the iOS 27.1 SDK, destination iPhone 17 Pro Max on the iOS 26.5 runtime) reported **BUILD SUCCEEDED**, with 0 errors and 0 warnings from `ios/`. Debug builds put the app code in `ondevicellmexample.debug.dylib`. The load command there, from `otool -l`:

```
Load command 28
          cmd LC_LOAD_WEAK_DYLIB
      cmdsize 96
         name /System/Library/Frameworks/FoundationModels.framework/FoundationModels (offset 24)
   time stamp 2 Wed Dec 31 16:00:02 1969
      current version 2.0.68
compatibility version 1.0.0
```

`LC_BUILD_VERSION` for the same binary reports `minos 16.4`, `sdk 27.1`. `otool -L` lists FoundationModels as `(…, weak)`.

## iOS 26.5 Simulator run (macOS 27.2 host)

This was the first time the iOS 26 code paths had run rather than only compiled. The setup:

- Host: macOS 27.2 (26B5091g).
- Simulator: iPhone 17 Pro Max, iOS 26.5 runtime.
- App: the example app built above, with the JS bundle from Metro.
- Probe: generation outcomes were read with a temporary probe that called the Apple provider directly. The probe was removed afterwards. The router's `onRoute` report is content-free by design (D28) and carries only outcome codes.

**`availability()` and `capabilities()`, raw from the native module.** This is the example's new "native module" readout, verbatim from the Metro log:

```json
{
  "availability": { "available": true },
  "capabilities": {
    "supportsReasoning": false,
    "modelLabel": "Apple Foundation Model",
    "usageReporting": false,
    "contextWindow": 4096,
    "tokenCounting": "exact",
    "supportsVision": false,
    "locales": [
      "da",
      "de",
      "en",
      "en-AU",
      "en-GB",
      "es",
      "es-419",
      "es-US",
      "fr",
      "fr-CA",
      "it",
      "ja",
      "ko",
      "nb",
      "nl",
      "pt",
      "pt-PT",
      "sv",
      "tr",
      "vi",
      "zh",
      "zh-HK",
      "zh-TW"
    ],
    "supportsToolCalling": true,
    "supportsGuidedGeneration": true
  }
}
```

That result confirms the iOS 26 branches of `ModelInfo.capabilities` at runtime:

- the fallback `modelLabel`, `usageReporting: false` and the fixed capability flags (the `#available(iOS 27)` `else` branch);
- `tokenCounting: "exact"` (26.5 is past 26.4);
- `contextWindow: 4096`, answered by the OS on 26.5.

The provider-level `capabilities()` the example panel shows agreed: `contextWindow: 4096`, `tokenCounting: "exact"`, `streaming`, `structuredOutput` and `tools` all `true`.

**Generation failed, every time, in the framework rather than in the bridge.** A streamed chat prompt, the structured-output (JSON) demo, a direct `generate`, a direct `stream` and a direct `countTokens` all failed. So no generation succeeded, and there was no result to check for `usage`. The simulator's unified log shows the cause inside the model service the simulator shares with the host:

- The guardrail model `com.apple.fm.language.instruct_300m.safety` fails with `InferenceError::hostFailed::…PrompteTemplateError.promptTemplateNotFound`, surfaced as `com.apple.SensitiveContentAnalysisML Code=15`.
- Token counting separately hits `com.apple.UnifiedAssetFramework Code=5000` ("There are no underlying assets … for asset set com.apple.modelcatalog").

The most likely reading is a runtime/host mismatch: the iOS 26.5 client asks the macOS 27.2 model service for 26-era assets and prompt templates it no longer has. That makes this a limit of the iOS 26.5 Simulator on a macOS 27 host, not evidence about iOS 26 devices.

The bridge handled it as designed. `generate` and `stream` both returned this payload, as decoded by the TypeScript side:

```json
{
  "code": "unknown",
  "details": { "code": "unknown", "transient": true },
  "message": "The operation couldn’t be completed. (FoundationModels.LanguageModelSession.GenerationError error -1.)",
  "cause": {
    "nativeDomain": "FoundationModels.LanguageModelSession.GenerationError",
    "nativeErrorCode": -1,
    "nativeDetail": "Error Domain=FoundationModels.LanguageModelSession.GenerationError Code=-1 \"(null)\" UserInfo={NSMultipleUnderlyingErrorsKey=(\"Error Domain=com.apple.SensitiveContentAnalysisML Code=15 … ModelManagerServices.ModelManagerError Code=1001 …\")}"
  }
}
```

`countTokens` returned the same shape with `nativeDetail` `ModelManagerServices.ModelManagerError Code=1026`. The router treated `unknown` + `transient` as fallback-eligible (D30) and handed each request to `cloud-fm`. That leg then failed with `network`, because no `fm serve` was running for this run.

One detail is new. The 26.5 runtime threw an `NSError` whose **domain is `FoundationModels.LanguageModelSession.GenerationError` with code `-1`**, and it did not cast to the `GenerationError` enum. So it went through `mapUntyped`, not the legacy mapper. This is the D9 lane ("availability is necessary but not sufficient"), seen on iOS 26 for the first time: `availability` said `available` and the first inference failed anyway.

## iOS 26.0 Simulator run (macOS 27.2 host)

Run on 2026-09-26, after the maintainer installed the iOS 26.0 (23A343) simulator runtime, to exercise the three behaviours gated at iOS 26.4 that the 26.5 run could not reach. Same host and example build as the 26.5 run; device iPhone 17 Pro on the 26.0 runtime.

**`availability()` and `capabilities()`, raw from the native module**, verbatim from the Metro log:

```json
{
  "availability": { "available": true },
  "capabilities": {
    "supportsGuidedGeneration": true,
    "contextWindow": 4096,
    "supportsToolCalling": true,
    "supportsReasoning": false,
    "locales": [
      "de",
      "en",
      "en-AU",
      "en-GB",
      "es",
      "es-419",
      "es-US",
      "fr",
      "fr-CA",
      "it",
      "ja",
      "ko",
      "pt",
      "zh"
    ],
    "tokenCounting": "estimated",
    "supportsVision": false,
    "usageReporting": false,
    "modelLabel": "Apple Foundation Model"
  }
}
```

**Token counting**, from a temporary probe in the example (removed afterwards) that called the Apple provider's `countTokens` and the raw native `countTokens` with the same one-message conversation:

```
[probe] apple provider countTokens -> 9
[probe] native countTokens -> {"ok":false,"error":{"message":"Exact token counting requires iOS 26.4 or later","code":"invalidRequest"}}
```

So, now observed rather than only compiled:

- `tokenCounting: "estimated"` below 26.4, and `contextWindow: 4096` from the back-deployed `contextSize` thunk (the model service itself reported `contextSize: 8192` in the unified log, which is what 26.4+ would surface; below 26.4 the framework hardcodes 4096).
- Native `countTokens` returns the contract's `invalidRequest` payload rather than crashing.
- The TypeScript provider's `countTokens` answers from the core estimator without touching native (D10's wider margin follows from `createMeasure`).
- The 26.0 locale list is shorter than 26.5's (14 languages versus 23): `da`, `nb`, `nl`, `pt-PT`, `sv`, `tr`, `vi`, `zh-HK`, `zh-TW` are absent. TaalTree's `nl` is one of them, so `supportsLocale` is the right pre-check on 26.0 too.

**Generation reached the framework and came back as a typed guardrail error, twice.** Two chat prompts ("Hello, tell me a short joke." and "What is the capital of France?") each produced `guardrail` / "Blocked by a safety guardrail", reported "via apple" — the Apple provider answered, and the router did not fall back, because `guardrail` is not fallback-eligible (D30). The unified log shows why: the safety classifier `com.apple.fm.language.instruct_300m.safety` fails with the same `promptTemplateNotFound` as on 26.5, `SensitiveContentAnalysisML` reports `Code=15`, and then the framework logs _"Safety guardrails were triggered"_ and throws. On 26.0 that surfaced as the typed `GenerationError.guardrailViolation`, mapped by the legacy mapper; on 26.5 the same underlying failure surfaced as an untyped `NSError` (`unknown`, transient) and fell back. Two consequences:

- The legacy mapper's `guardrailViolation` row has now been observed in practice, not only through synthesized errors.
- A device whose safety model is broken presents as a guardrail trip on every prompt, and a guardrail trip does not fall back. That is the framework's classification, not the bridge's; a caller who wants cloud fallback in that state has to treat repeated `guardrail` results on innocuous prompts as a signal. It is worth knowing, and it is not a change to make on simulator evidence alone.

After each error the hook returned to `idle` and the next send worked, so nothing was left hanging. (An earlier attempt in this run appeared stuck in `streaming` for several minutes; it followed a Fast Refresh edit of `App.tsx` mid-session and did not reproduce on a clean relaunch, so it is recorded as a dev-loop artifact, not a library behaviour.) One cosmetic thing the run showed in the example app: an error mid-turn leaves an empty streaming bubble, because the hook deliberately leaves `streamingText` as-is on failure and the example renders `''` as a bubble.

## What remains unverified

- **iOS below 26 at runtime.** No pre-26 simulator runtime is installed, and none was downloaded. The `unsupportedPlatform` path is covered only by three things: the iOS 16.4 typecheck, the `LC_LOAD_WEAK_DYLIB` load command and 203/203 weak references, and code review of the guards. Nobody has launched the app on iOS 17–25, so the app starting there and every call reporting `unsupportedPlatform` is inferred, not observed.
- **Successful generation on iOS 26.x.** This is still unmeasured, and so are `usage` absence on a real result and `finishReason` without usage. Neither the 26.0 nor the 26.5 Simulator can generate on a macOS 27 host (above): the safety model fails to load, which 26.0 reports as a guardrail trip and 26.5 as an untyped error. Of the typed `GenerationError` cases, only `guardrailViolation` has been observed thrown in practice. That needs an iOS 26 device, or a macOS 26 host running the 26.x simulator.
- **The D23 constraint matrix, D21 cancellation and tool round trips on 26.x.** These are still 27-only measurements.
- **A Release build.** Only Debug was built. In Release the app code links into the main executable rather than `*.debug.dylib`, so the weak load command should be re-checked there.
