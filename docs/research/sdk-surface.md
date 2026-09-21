# FoundationModels SDK surface — read from the installed iOS 27.1 SDK

**Date:** 2026-09-20
**Method:** direct read of the shipping `.swiftinterface`, plus runtime probes compiled against the installed macOS SDK and run on this Mac.

## 0. Provenance

| Item | Value |
|---|---|
| Xcode | 27.1 (27A9269) |
| iOS SDK | 27.1 |
| macOS SDK | 27.0 |
| Host OS | macOS 27.0 (26A428) |
| Swift compiler in SDK | Apple Swift 6.4 (swiftlang-6.4.0.31.4) |
| Framework module version | `-user-module-version 2.0.68.1.101` (iOS), `2.0.68.1.402` (macOS) |
| Interface size | 3,647 lines / 206 KB |

Interface files read:

- `/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks/FoundationModels.framework/Modules/FoundationModels.swiftmodule/arm64e-apple-ios.swiftinterface`
- `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/FoundationModels.framework/Modules/FoundationModels.swiftmodule/arm64e-apple-macos.swiftinterface` (present; also `arm64e/x86_64 …-macabi` and `x86_64-apple-macos`)
- iPhoneSimulator SDK copy present (`arm64-apple-ios-simulator`, `x86_64-apple-ios-simulator`).

**The iOS and macOS interfaces are byte-identical apart from the `swift-module-flags` line** (target triple, target-variant, user-module-version). Verified by `diff` — 4 differing lines, all in the header. So `fm`-CLI-on-macOS behaviour is a valid proxy for the iOS API surface; there is no macOS-only or iOS-only declaration.

Cross-import overlays also ship, and matter:

- `_FoundationModels_UIKit` — one declaration: `Attachment<ImageAttachmentContent>.init(_ uiImage: UIImage, orientation:)` (iOS 27+).
- `_FoundationModels_SwiftUI` — exists but exports nothing public in this build.
- `_Vision_FoundationModels` — ships ready-made `Tool` conformances: `BarcodeReaderTool`, `OCRTool` (iOS 27+).
- `_CoreSpotlight_FoundationModels` — present, not inspected in depth.

There are **no C/ObjC headers**; the framework is Swift-only (`FoundationModels.tbd` + swiftmodule). A native bridge must be Swift.

---

## 1. SystemLanguageModel

```swift
@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
@available(tvOS, unavailable) @available(watchOS, unavailable)
final public class SystemLanguageModel : Sendable
```

### Availability

```swift
final public var availability: SystemLanguageModel.Availability { get }
final public var isAvailable: Bool { get }

@frozen public enum Availability : Equatable, Sendable {
  case available
  case unavailable(SystemLanguageModel.Availability.UnavailableReason)
}

public enum UnavailableReason : Equatable, Sendable, Hashable {
  case deviceNotEligible
  case appleIntelligenceNotEnabled
  case modelNotReady
}
```

**Exactly three unavailability reasons. There is no `unsupportedLocale` and no `unsupportedOS` reason.** Locale problems surface at generation time as `LanguageModelError.unsupportedLanguageOrLocale`, not through `availability`.

`SystemLanguageModel` conforms to `Observation.Observable`, so availability changes are observable (relevant to `useAvailability`).

### Construction, use cases, guardrails

```swift
public static var `default`: SystemLanguageModel { get }
convenience public init(useCase: SystemLanguageModel.UseCase = .general,
                       guardrails: SystemLanguageModel.Guardrails = Guardrails.default)

public struct UseCase : Sendable, Equatable {
  public static let general: UseCase
  public static let contentTagging: UseCase
}

public struct Guardrails : Sendable {
  public static let `default`: Guardrails
  public static let permissiveContentTransformations: Guardrails
}
```

Only two use cases. `Guardrails.permissiveContentTransformations` is a documented lever for guardrail false positives on transformation-style tasks — **not mentioned in the plan, and worth exposing** as an opt-in flag on the Apple provider.

### Locales

```swift
final public var supportedLanguages: Set<Locale.Language> { get }   // synchronous
final public func supportsLocale(_ locale: Locale = Locale.current) -> Bool
```

Measured on this machine (24 languages):

```
da-Latn-DK, de-Latn-DE, en-Latn-AU, en-Latn-GB, en-Latn-IN, en-Latn-US,
es-Latn-419, es-Latn-ES, es-Latn-US, fr-Latn-CA, fr-Latn-FR, it-Latn-IT,
ja-Jpan-JP, ko-Kore-KR, nb-Latn-NO, nl-Latn-NL, pt-Latn-BR, pt-Latn-PT,
sv-Latn-SE, tr-Latn-TR, vi-Latn-VN, zh-Hans-CN, zh-Hant-HK, zh-Hant-TW
```

All four TaalTree target languages (nl, fr, de, es) are supported. `pl_PL` is not — useful negative test.

### Context size — the 8K vs 4K question

```swift
@available(iOS 26.0, …)
@backDeployed(before: iOS 26.4, macOS 26.4, visionOS 26.4)
final public var contextSize: Int {
  get {
    if #available(iOS 27.0, macOS 27.0, visionOS 27.0, tvOS 27.0, watchOS 27.0, *) {
      return _contextSize
    }
    return 4096          // literal fallback, visible in the interface
  }
}
@available(iOS 27.0, …) @usableFromInline final internal var _contextSize: Int { get }
```

Findings:

- `contextSize` is a **public, synchronous `Int`** on `SystemLanguageModel` (back-deployed to 26.4; on anything older it is literally hardcoded `4096`). This is the API to read; do not hardcode 4096 or 8192.
- Doc comment: *"The context size represents the total number of tokens that can be used in a single session, including both input prompts and generated responses."* So it is a combined input+output budget — the plan's `window - reservedForOutput - safetyMargin` formula is the right shape.
- The `4,096` figure only survives in the doc comment of the **deprecated** `GenerationError.exceededContextWindowSize`.
- ⚠️ **On this Mac, `model.contextSize` returns `0`** (both for `.general` and `.contentTagging`), because the model assets are in a broken state (see §12). Treat `contextSize <= 0` as "unknown" and fall back to a conservative 4096 rather than dividing by zero. This is a real defensive requirement, not a hypothetical.
- `PrivateCloudComputeLanguageModel.contextSize` measured **32768** (async throwing).

### Variants (new in iOS 27)

```swift
@available(iOS 27.0, …) final public var variant: SystemLanguageModel.Variant { get }

public struct Variant : Sendable, Hashable {
  public let displayName: String
  public static var core3: Variant           // doc: "AFM 3 Core."
  public static var coreAdvanced3: Variant   // doc: "AFM 3 Core Advanced."
}
```

Measured on this machine: `displayName == "AFM 3 Core"`, `variant == .core3`. Report `variant.displayName` in capabilities/telemetry; it explains context-size and quality differences between devices.

### Capabilities (new in iOS 27)

`SystemLanguageModel` conforms to the new `LanguageModel` protocol on iOS 27:

```swift
@available(iOS 27.0, …) public protocol LanguageModel : Sendable {
  associatedtype Executor : LanguageModelExecutor where Self == Self.Executor.Model
  var capabilities: LanguageModelCapabilities { get }
  var executorConfiguration: Self.Executor.Configuration { get }
}
public struct LanguageModelCapabilities : Sendable {
  public init(_ capabilities: [Capability])
  public func contains(_ capability: Capability) -> Bool
}
extension LanguageModelCapabilities.Capability {
  public static var vision: Capability
  public static var guidedGeneration: Capability
  public static var reasoning: Capability
  public static var toolCalling: Capability
}
```

Measured, on-device model: `vision = true`, `guidedGeneration = true`, `toolCalling = true`, `reasoning = false`.
Measured, PCC model: all four `true`.

This maps almost one-for-one onto the plan's `Capabilities` object — use it instead of hardcoding.

### Token counting — public, and exact

```swift
@available(iOS 26.4, macOS 26.4, visionOS 26.4, *)
nonisolated(nonsending) final public func tokenCount(for prompt: some PromptRepresentable) async throws -> Int
nonisolated(nonsending) final public func tokenCount(for instructions: Instructions) async throws -> Int
nonisolated(nonsending) final public func tokenCount(for tools: [any Tool]) async throws -> Int
nonisolated(nonsending) final public func tokenCount(for schema: GenerationSchema) async throws -> Int
nonisolated(nonsending) final public func tokenCount(for transcriptEntries: some Collection<Transcript.Entry>) async throws -> Int
```

Five overloads, all `async throws -> Int`, gated at **iOS/macOS/visionOS 26.4** (not 26.0, not 27.0). They live on `SystemLanguageModel`, **not** on `LanguageModelSession` and **not** on `PrivateCloudComputeLanguageModel`.

Consequences for the plan:

- `countTokens` can be **exact** on iOS ≥ 26.4, including counting a whole message list via the transcript-entries overload. `capabilities.tokenCounting` should be a tri-state: `exact` (≥26.4 on-device), `estimated` (26.0–26.3, or PCC), `none`.
- Separately, iOS 27 reports real usage after the fact (§3), so the context manager can calibrate its estimator against ground truth.
- ⚠️ On this Mac all five throw `ModelManagerError 1013` (see §12), and `fm count-tokens` fails identically. The API exists; the local model state is broken.

### SystemLanguageModel.Error (new in iOS 27)

```swift
@available(iOS 27.0, …) public enum Error : LocalizedError {
  case assetsUnavailable(SystemLanguageModel.Error.AssetsUnavailable)
}
public struct AssetsUnavailable : Sendable { public var debugDescription: String }
```

### Adapters — gone

```swift
@available(iOS 26.0, …) @available(iOS, deprecated: 26.4, obsoleted: 27.0)
public struct Adapter { … }          // init(fileURL:), init(name:), compile(), …
convenience public init(adapter: Adapter, guardrails: Guardrails = .default)   // obsoleted: 27.0
```

`SystemLanguageModel.Adapter` and `init(adapter:)` are **obsoleted in 27.0** — they will not compile against this SDK when targeting 27. The plan already puts adapter/LoRA out of scope (§8); this confirms there is nothing to skip around. Note `Adapter.AssetError` is only *deprecated* (26.4), not obsoleted.

---

## 2. LanguageModelSession — initializers

```swift
@_hasMissingDesignatedInitializers
@available(iOS 26.0, macOS 26.0, visionOS 26.0, watchOS 27.0, *)
final public class LanguageModelSession
```

### iOS 26 family (concrete `SystemLanguageModel`)

```swift
@_disfavoredOverload convenience init(model: SystemLanguageModel = .default,
                                     tools: [any Tool] = [],
                                     instructions: String? = nil)
convenience init(model: SystemLanguageModel = .default, tools: [any Tool] = [],
                 @InstructionsBuilder instructions: () throws -> Instructions) rethrows
convenience init(model: SystemLanguageModel = .default, tools: [any Tool] = [],
                 instructions: Instructions? = nil)
convenience init(model: SystemLanguageModel = .default, tools: [any Tool] = [],
                 transcript: Transcript)          // ← the one the plan needs
```

### iOS 27 family (any `LanguageModel`, so PCC too)

```swift
@available(iOS 27.0, …)
convenience init<Failure>(model: some LanguageModel, tools: [any Tool] = [],
                          @InstructionsBuilder instructions: () throws(Failure) -> Instructions) throws(Failure)
@available(iOS 27.0, …)
convenience init(model: some LanguageModel, tools: [any Tool] = [], transcript: Transcript)
@available(iOS 27.0, …)
convenience init(model: some LanguageModel, tools: [any Tool] = [], instructions: Instructions? = nil)
@available(iOS 27.0, …)
@_disfavoredOverload convenience init(model: some LanguageModel, tools: [any Tool] = [], instructions: String? = nil)

// profile / dynamic-instructions DSL, both take history directly:
@available(iOS 27.0, …)
convenience init(profile: sending some DynamicProfile, history: some Collection<Transcript.Entry> = [])
@available(iOS 27.0, …)
convenience init(model: some LanguageModel = SystemLanguageModel.default,
                 dynamicInstructions: sending some DynamicInstructions,
                 history: some Collection<Transcript.Entry> = [])
```

> **Verdict on the plan's critical question (§2 "Stateless providers"): YES.** `init(model:tools:transcript:)` exists and has since iOS 26.0, and iOS 27 adds two more initializers that take `history: some Collection<Transcript.Entry>` directly. Rebuild-per-request is fully supported. Verified at runtime: a session built from a 3-entry transcript reports `session.transcript.count == 3` and `isResponding == false`.

### Session state

```swift
final public var transcript: Transcript {
  get
  @available(iOS 27.0, …) _modify          // ← mutable on iOS 27
}
final public var isResponding: Bool { get }
@available(iOS 27.0, …) final public var usage: LanguageModelSession.Usage { get }
@available(iOS 27.0, …) final public var transcriptErrorHandlingPolicy: TranscriptErrorHandlingPolicy? { get set }
@available(iOS 27.0, …) final public var properties: SessionPropertyValues { get }

final public func prewarm(promptPrefix: Prompt? = nil)     // iOS 26.0+
```

`LanguageModelSession` is `Observable` and `@unchecked Sendable`.

**A significant iOS 27 change the plan did not anticipate:** the transcript is *mutable*, and `Transcript` gains `MutableCollection`, `RangeReplaceableCollection`, and a `history` view that you can `append`/`replaceSubrange`/assign. On iOS 27 you can keep one long-lived session and trim its history in place instead of rebuilding — which is exactly what the context manager wants, without the prompt-prefix cache being invalidated. Mutating the transcript while responding throws `LanguageModelSession.Error.transcriptMutationWhileResponding`. iOS 27 also adds a `.historyTransform([Entry]) -> [Entry]` profile modifier for doing the trimming declaratively.

Recommendation: keep the plan's rebuild-per-request default (works on 26 and 27), but note session-reuse-with-`history`-mutation as the iOS-27 optimisation path rather than the "cache the last session" heuristic in the plan, which is more fragile.

`prewarm(promptPrefix:)` exists and takes an optional prompt prefix. Doc warns: only use it when you have **≥1 second** before the respond call.

---

## 3. respond / streamResponse

### Non-streaming (iOS 26 shapes)

```swift
@discardableResult nonisolated(nonsending)
final func respond(to prompt: Prompt, options: GenerationOptions = GenerationOptions()) async throws -> Response<String>
@discardableResult @_disfavoredOverload nonisolated(nonsending)
final func respond(to prompt: String, options: GenerationOptions = GenerationOptions()) async throws -> Response<String>
@discardableResult nonisolated(nonsending)
final func respond(options: GenerationOptions = GenerationOptions(),
                   @PromptBuilder prompt: () throws -> Prompt) async throws -> Response<String>

// structured, runtime schema:
@discardableResult nonisolated(nonsending)
final func respond(to prompt: Prompt, schema: GenerationSchema,
                   includeSchemaInPrompt: Bool = true,
                   options: GenerationOptions = GenerationOptions()) async throws -> Response<GeneratedContent>

// structured, compile-time Generable:
@discardableResult nonisolated(nonsending)
final func respond<Content>(to prompt: Prompt, generating type: Content.Type = Content.self,
                            includeSchemaInPrompt: Bool = true,
                            options: GenerationOptions = GenerationOptions()) async throws -> Response<Content>
  where Content : Generable
```

### Non-streaming (iOS 27 additions)

Every overload above gains a 27-only sibling that replaces `includeSchemaInPrompt:` with `contextOptions:` and adds `metadata:`:

```swift
@available(iOS 27.0, …) @discardableResult nonisolated(nonsending)
final func respond(to prompt: Prompt,
                   options: GenerationOptions = GenerationOptions(),
                   contextOptions: ContextOptions = ContextOptions(),
                   metadata: [String : any ConvertibleToGeneratedContent] = [:]) async throws -> Response<String>

@available(iOS 27.0, …) @discardableResult @_disfavoredOverload nonisolated(nonsending)
final func respond(to prompt: Prompt, schema: GenerationSchema,
                   options: GenerationOptions = GenerationOptions(),
                   contextOptions: ContextOptions = ContextOptions(includeSchemaInPrompt: true),
                   metadata: [String : any ConvertibleToGeneratedContent] = [:]) async throws -> Response<GeneratedContent>
```

`includeSchemaInPrompt` has moved into `ContextOptions.includeSchemaInPrompt`. **For a bridge targeting both 26 and 27, prefer the iOS 26 `includeSchemaInPrompt:` overloads** — they are not deprecated and compile on both. Use the 27 overloads only when you need `contextOptions.reasoningLevel` or `metadata`.

### Response

```swift
public struct Response<Content> where Content : Generable {
  public let content: Content
  public let rawContent: GeneratedContent
  public let transcriptEntries: ArraySlice<Transcript.Entry>
  @available(iOS 27.0, …) public let usage: LanguageModelSession.Usage
}

@available(iOS 27.0, …) public struct Usage : Sendable {
  public var input: Usage.Input        // totalTokenCount, cachedTokenCount
  public var output: Usage.Output      // totalTokenCount, reasoningTokenCount
  public var metadata: [String : GeneratedContent]
  public var totalTokenCount: Int { get }
}
```

`transcriptEntries` is the slice of entries this turn appended — the clean way to feed the result back into a JS-side message list. `usage` gives real `usage` for `GenerateResult` on iOS 27, including `cachedTokenCount` (prefix-cache hits) and `reasoningTokenCount`. `session.usage` is documented as monotonically accumulating over the session lifetime.

### Streaming — snapshots, confirmed

```swift
final func streamResponse(to prompt: Prompt, options: GenerationOptions = GenerationOptions())
  -> sending LanguageModelSession.ResponseStream<String>
final func streamResponse(to prompt: Prompt, schema: GenerationSchema, includeSchemaInPrompt: Bool = true,
                          options: GenerationOptions = GenerationOptions())
  -> sending LanguageModelSession.ResponseStream<GeneratedContent>
final func streamResponse<Content>(to prompt: Prompt, generating type: Content.Type = Content.self,
                                   includeSchemaInPrompt: Bool = true,
                                   options: GenerationOptions = GenerationOptions())
  -> sending LanguageModelSession.ResponseStream<Content> where Content : Generable
// + String-prompt and @PromptBuilder variants; + iOS 27 contextOptions:/metadata: siblings
```

```swift
public struct ResponseStream<Content> where Content : Generable { }

extension ResponseStream {
  public struct Snapshot {
    public var content: Content.PartiallyGenerated
    public var rawContent: GeneratedContent
    @available(iOS 27.0, …) public var transcriptEntries: ArraySlice<Transcript.Entry>
    @available(iOS 27.0, …) public var usage: LanguageModelSession.Usage
  }
}

extension ResponseStream : AsyncSequence {
  public typealias Element = ResponseStream<Content>.Snapshot
  public func makeAsyncIterator() -> ResponseStream<Content>.AsyncIterator
  nonisolated(nonsending) public func collect() async throws -> sending Response<Content>
}
```

> **Verdict: cumulative snapshots, not deltas — unchanged from iOS 26.** The element type is literally named `Snapshot`; the SDK doc comments are *"A snapshot of partially generated content."* and *"An async sequence of snapshots of partially generated content."* For `Content == String`, `String.PartiallyGenerated == String`, so each iteration yields the whole accumulated string. The plan's §4 assumption holds: the Apple provider must diff consecutive snapshots to emit deltas. For structured output the snapshot is a partially-populated `GeneratedContent` (`isComplete: Bool` tells you when it's done) — diffing is not meaningful there, so emit snapshot events for object streaming and delta events for text.

`collect()` is a convenience that drains the stream into a full `Response<Content>` — useful for implementing `generate` on top of `stream` if you ever want one code path.

Cancellation: `ResponseStream` is a plain `AsyncSequence`; `respond` is `async throws`. Both are driven by Swift structured concurrency, so `Task.cancel()` is the cancellation mechanism — there is no explicit `cancel()`/`stop()` method anywhere on `LanguageModelSession`. The bridge must hold the `Task` and cancel it.

---

## 4. GenerationOptions and ContextOptions

```swift
@available(iOS 26.0, …)
public struct GenerationOptions : Sendable, Equatable {
  @available(*, deprecated, renamed: "samplingMode")
  public var sampling: GenerationOptions.SamplingMode?
  public var temperature: Double?
  public var maximumResponseTokens: Int?
  @available(iOS 27.0, …) public var toolCallingMode: GenerationOptions.ToolCallingMode?

  @backDeployed(before: iOS 27.0, …)
  public init(samplingMode: SamplingMode? = nil, temperature: Double? = nil, maximumResponseTokens: Int? = nil)
  @available(iOS 27.0, …)
  public init(samplingMode: SamplingMode? = nil, temperature: Double? = nil,
              maximumResponseTokens: Int? = nil, toolCallingMode: ToolCallingMode?)
}

@backDeployed(before: iOS 27.0, …)
public var samplingMode: SamplingMode? { get { sampling } set { sampling = newValue } }
```

**That is the complete field list: four fields.** No top-p, no top-k as a scalar, no frequency/presence penalties, no stop sequences, no seed at the options level (the seed lives inside `SamplingMode`). `sampling` is deprecated in favour of `samplingMode` (same storage).

```swift
public struct SamplingMode : Sendable, Equatable {
  @available(iOS 27.0, …) public let kind: SamplingMode.Kind
  public static var greedy: SamplingMode
  public static func random(top k: Int, seed: UInt64? = nil) -> SamplingMode
  public static func random(probabilityThreshold: Double, seed: UInt64? = nil) -> SamplingMode
}
@available(iOS 27.0, …) public enum Kind : Sendable, Equatable {
  case greedy
  case randomTopK(_: Int, seed: UInt64?)
  case randomProbabilityThreshold(_: Double, seed: UInt64?)
}

@available(iOS 27.0, …)
public struct ToolCallingMode : Sendable, Equatable {
  public var kind: Kind
  public static let allowed: ToolCallingMode
  public static let required: ToolCallingMode
  public static let disallowed: ToolCallingMode
}
```

Mapping guidance for an OpenAI-shaped request: `temperature` → `temperature`; `maxOutputTokens` → `maximumResponseTokens`; `top_p` → `.random(probabilityThreshold:)`; `top_k` → `.random(top:)`; `seed` → the `seed:` argument of either `random`. `tool_choice: "none"/"auto"/"required"` → `ToolCallingMode.disallowed/.allowed/.required` on iOS 27 only. Reject `stop`, `frequency_penalty`, `presence_penalty` as `invalidRequest` — the framework has no equivalent.

`SamplingMode.Kind` being 27-only means on iOS 26 you can construct a `SamplingMode` but cannot introspect it. `GenerationOptions` is `Equatable`, which is handy for the session-reuse check.

```swift
@available(iOS 27.0, …)
public struct ContextOptions : Sendable, Equatable {
  public var includeSchemaInPrompt: Bool?
  public var reasoningLevel: ContextOptions.ReasoningLevel?
  public init(includeSchemaInPrompt: Bool? = nil, reasoningLevel: ReasoningLevel? = nil)
}
public enum ReasoningLevel : Sendable, Equatable {
  case light
  case moderate
  case deep
  case custom(String)
}
```

`ContextOptions` is new in iOS 27 and is **not** what the plan guessed "context window options" would be — it is prompt-shaping (schema echo + reasoning budget), not a way to select a bigger window. There is no API anywhere to request a larger context window. The on-device model in this SDK reports `capabilities.reasoning == false`, so `reasoningLevel` is currently only meaningful for PCC / future variants.

---

## 5. Error taxonomy

iOS 27 **replaces** the iOS 26 error enum. The old one still exists but every case is deprecated.

### `LanguageModelError` (new, top-level, iOS 27)

```swift
@available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *)
public enum LanguageModelError : LocalizedError {
  case contextSizeExceeded(LanguageModelError.ContextSizeExceeded)
  case rateLimited(LanguageModelError.RateLimited)
  case guardrailViolation(LanguageModelError.GuardrailViolation)
  case refusal(LanguageModelError.Refusal)
  case unsupportedCapability(LanguageModelError.UnsupportedCapability)
  case unsupportedTranscriptContent(LanguageModelError.UnsupportedTranscriptContent)
  case unsupportedGenerationGuide(LanguageModelError.UnsupportedGenerationGuide)
  case unsupportedLanguageOrLocale(LanguageModelError.UnsupportedLanguageOrLocale)
  case timeout(LanguageModelError.Timeout)
}
```

Payloads (all `Sendable`, all carry `debugDescription` and `metadata: [String : any Sendable]`):

```swift
struct ContextSizeExceeded { var contextSize: Int; var tokenCount: Int; … }   // ← both numbers!
struct RateLimited { var resetDate: Date?; … }
struct GuardrailViolation { … }
struct Refusal { … }                                                          // + async explanation
struct UnsupportedCapability { var capability: LanguageModelCapabilities.Capability; … }
struct UnsupportedTranscriptContent { var unsupportedContent: [Transcript.Entry]; … }
struct UnsupportedGenerationGuide { var schemaName: String?; … }
struct UnsupportedLanguageOrLocale { var languageCode: Locale.LanguageCode; … }
struct Timeout { … }

extension LanguageModelError.Refusal {
  nonisolated(nonsending) public var explanation: LanguageModelSession.Response<String> { get async throws }
  public var explanationStream: LanguageModelSession.ResponseStream<String> { get }
}
```

`ContextSizeExceeded` carrying **both `contextSize` and `tokenCount`** is a gift for the context manager: on overflow you learn the exact budget and the exact overage, so the estimator can self-correct. The plan's taxonomy should carry these through on the `contextOverflow` error.

`Refusal.explanation` triggers a *second generation* to explain the refusal. Do not call it eagerly in the bridge — it costs a round trip. Expose it as an opt-in.

### `LanguageModelSession.Error` (new, iOS 27)

```swift
@available(iOS 27.0, …) public enum Error : LocalizedError, Equatable, Hashable {
  case concurrentRequests
  case transcriptMutationWhileResponding
}
```

This is the plan's §4 "one request per session at a time" — now a distinct typed error, and the second case is new and only reachable if you use the iOS 27 mutable transcript.

### `SystemLanguageModel.Error` (new, iOS 27)

```swift
case assetsUnavailable(AssetsUnavailable)
```

### `PrivateCloudComputeLanguageModel.Error` (new, iOS 27)

```swift
public enum Error : Swift.Error, LocalizedError {
  case networkFailure(NetworkFailure)
  case quotaLimitReached(QuotaLimitReached)      // limitIncreaseSuggestion, resetDate
  case serviceUnavailable(ServiceUnavailable)
}
```

### `LanguageModelSession.ToolCallError` (iOS 26)

```swift
public struct ToolCallError : Swift.Error, LocalizedError {
  public var tool: any Tool
  public var underlyingError: any Swift.Error
}
```

Tool handler exceptions arrive wrapped in this, with the offending tool attached. The bridge's JS-tool errors will come back through here.

### `GeneratedContent.ParsingError` (new, iOS 27)

```swift
@available(iOS 27.0, …) public struct ParsingError : LocalizedError, Sendable {
  public var rawContent: String
  public var underlyingError: (any Error)?
  public var debugDescription: String
}
```

Replaces `GenerationError.decodingFailure`, and **carries `rawContent`** — the malformed model output. Surface it; it is the single most useful thing for debugging structured-output failures.

### `GenerationSchema.SchemaError` (iOS 26)

```swift
public enum SchemaError : Swift.Error, LocalizedError {
  case duplicateType(schema: String?, type: String, context: Context)
  case duplicateProperty(schema: String, property: String, context: Context)
  case emptyTypeChoices(schema: String, context: Context)
  case undefinedReferences(schema: String?, references: [String], context: Context)
}
```

Thrown by `GenerationSchema(root:dependencies:)`. All four verified to fire at runtime (§7). These are `invalidRequest` in the plan's taxonomy.

### `LanguageModelSession.GenerationError` (iOS 26, deprecated throughout in 27)

```swift
@available(iOS, introduced: 26.0, deprecated: 27.0)
public enum GenerationError : Swift.Error, LocalizedError {
  case exceededContextWindowSize(Context)   // → LanguageModelError.contextSizeExceeded
  case assetsUnavailable(Context)           // → SystemLanguageModel.Error.assetsUnavailable
  case guardrailViolation(Context)          // → LanguageModelError.guardrailViolation
  case unsupportedGuide(Context)            // → LanguageModelError.unsupportedGenerationGuide
  case unsupportedLanguageOrLocale(Context) // → LanguageModelError.unsupportedLanguageOrLocale
  case decodingFailure(Context)             // → GeneratedContent.ParsingError
  case rateLimited(Context)                 // → LanguageModelError.rateLimited
  case concurrentRequests(Context)          // → LanguageModelSession.Error.concurrentRequests
  case refusal(GenerationError.Refusal, Context)  // → LanguageModelError.refusal
}
public struct Context : Sendable { public let debugDescription: String }
```

**Bridging consequence:** a package supporting iOS 26 *and* 27 must catch **both** taxonomies. Write one mapper that tries, in order: `LanguageModelError`, `LanguageModelSession.Error`, `SystemLanguageModel.Error`, `GeneratedContent.ParsingError`, `PrivateCloudComputeLanguageModel.Error`, `LanguageModelSession.ToolCallError`, `GenerationSchema.SchemaError`, `LanguageModelSession.GenerationError` (deprecated, `#available`-guarded), then `CancellationError`, then `NSError` fallback.

⚠️ **Observed at runtime: some failures do not surface as any typed enum.** Both the on-device and PCC generation failures on this machine arrived as plain `NSError` with `Domain=FoundationModels.LanguageModelError Code=-1` and nested `ModelManagerServices.ModelManagerError` codes (1013, 1046) or `com.apple.SensitiveContentAnalysisML error 15`. The mapper must therefore have a real `NSError` branch that preserves `domain`, `code`, and `NSMultipleUnderlyingErrorsKey`, and map to `unknown` with the original attached — exactly as the plan's taxonomy requires. Do not assume every throw is a typed case.

Against the plan's taxonomy (§2): `contextOverflow` ✅ (`contextSizeExceeded`), `guardrail` ✅ (`guardrailViolation`, plus `refusal` as a *separate* concept worth its own code), `rateLimited` ✅ (with `resetDate`), `unsupportedLocale` ✅ (a generation error, **not** an availability reason — the plan puts it under `unavailable`, which is wrong; it can only be known after a request, or predicted via `supportsLocale`). New codes worth adding: `timeout`, `unsupportedCapability`, `refusal` (distinct from `guardrail`), `parseError`.

---

## 6. Transcript

```swift
@available(iOS 26.0, …)
public struct Transcript : Sendable, Equatable, RandomAccessCollection, Codable {
  public init(entries: some Sequence<Entry> = [])
  public typealias Index = Int
  public subscript(index: Index) -> Entry { get set }
}
@available(iOS 27.0, …) extension Transcript : MutableCollection { }
@available(iOS 27.0, …) extension Transcript : RangeReplaceableCollection {
  public init()
  public mutating func replaceSubrange<C>(_ subrange: Range<Int>, with newElements: consuming C) where C.Element == Entry
}
```

> **Verdict: yes, we can construct a `Transcript` from arbitrary entries we build ourselves.** `init(entries:)` takes any `Sequence<Entry>`, all entry payload types have public initializers, and on iOS 27 a `Transcript` is a fully mutable `RangeReplaceableCollection`. `Transcript` is also `Codable` — it can be persisted to JSON and reloaded.

### Entries and segments

```swift
public enum Entry : Sendable, Identifiable, Equatable {   // ID == String
  case instructions(Transcript.Instructions)
  case prompt(Transcript.Prompt)
  case toolCalls(Transcript.ToolCalls)
  case toolOutput(Transcript.ToolOutput)
  case response(Transcript.Response)
  @available(iOS 27.0, …) case reasoning(Transcript.Reasoning)
}

public enum Segment : Sendable, Identifiable, Equatable {  // ID == String
  case text(Transcript.TextSegment)
  case structure(Transcript.StructuredSegment)
  @available(iOS 27.0, …) case attachment(Transcript.AttachmentSegment)
}
```

Payload types (all with public initializers — the important part for a bridge):

```swift
struct TextSegment { var id: String; var content: String
  init(id: String = UUID().uuidString, content: String) }

struct StructuredSegment { var id: String
  @available(iOS, deprecated: 27.0, renamed: "schemaName") var source: String
  var content: GeneratedContent
  init(id: String = UUID().uuidString, source: String, content: GeneratedContent)   // deprecated 27
  @available(iOS 27.0, …) init(id: String = UUID().uuidString, schemaName: String, content: GeneratedContent)
  @backDeployed(before: iOS 27.0) var schemaName: String { get { source } set { source = newValue } } }

@available(iOS 27.0, …) struct AttachmentSegment { var id: String
  var content: Transcript.Attachment; var label: String?
  init(id: String = UUID().uuidString, content: Transcript.Attachment, label: String? = nil) }

struct Instructions { var id: String; var segments: [Segment]; var toolDefinitions: [ToolDefinition]
  init(id: String = UUID().uuidString, segments: [Segment], toolDefinitions: [ToolDefinition]) }

struct Prompt { var id: String; var segments: [Segment]; var options: GenerationOptions
  @available(iOS 27.0, …) var contextOptions: ContextOptions
  @available(iOS 27.0, …) var metadata: [String : GeneratedContent]
  var responseFormat: ResponseFormat?
  init(id: String = UUID().uuidString, segments: [Segment],
       options: GenerationOptions = GenerationOptions(), responseFormat: ResponseFormat? = nil)
  @available(iOS 27.0, …) init(id:metadata:segments:options:responseFormat:contextOptions:) }

struct ResponseFormat { @available(iOS 27.0, …) let kind: Kind   // .schema(GenerationSchema)
  var name: String { get }
  init<Content: Generable>(type: Content.Type)
  init(schema: GenerationSchema) }

struct ToolDefinition { var name: String; var description: String
  @available(iOS 27.0, …) var parameters: GenerationSchema { get set }
  init(name: String, description: String, parameters: GenerationSchema)
  init(tool: some Tool) }

struct ToolCalls : RandomAccessCollection { var id: String
  init<S: Sequence>(id: String = UUID().uuidString, _ calls: S) where S.Element == ToolCall }

struct ToolCall { var id: String; var toolName: String; var arguments: GeneratedContent
  @available(iOS 27.0, …) var metadata: [String : GeneratedContent]
  init(id: String, toolName: String, arguments: GeneratedContent) }

struct ToolOutput { var id: String; var toolName: String; var segments: [Segment]
  init(id: String, toolName: String, segments: [Segment]) }

struct Response { var id: String; var assetIDs: [String]; var segments: [Segment]
  @backDeployed(before: iOS 27.0) var metadata: [String : GeneratedContent] { get }
  init(id: String = UUID().uuidString, assetIDs: [String], segments: [Segment])
  @available(iOS 27.0, …) init(id:metadata:segments:) }

@available(iOS 27.0, …) struct Reasoning { var id: String; var segments: [Segment]
  var signature: Data?; var metadata: [String : GeneratedContent]
  init(id: String = UUID().uuidString, metadata: [:] , segments: [Segment], signature: Data? = nil) }
```

Mapping a JS message list onto entries:

| JS role | Transcript entry |
|---|---|
| `system` | `.instructions(Transcript.Instructions(segments:toolDefinitions:))` — must be **first** and carries the tool definitions |
| `user` | `.prompt(Transcript.Prompt(segments:))` |
| `assistant` (text) | `.response(Transcript.Response(assetIDs: [], segments:))` |
| `assistant` (tool call) | `.toolCalls(Transcript.ToolCalls(_:))` |
| `tool` result | `.toolOutput(Transcript.ToolOutput(id:toolName:segments:))` — `id` must match the `ToolCall.id` |
| assistant reasoning | `.reasoning(…)` (iOS 27 only) |

### HistoryView (iOS 27)

```swift
@available(iOS 27.0, …) extension Transcript {
  public struct HistoryView : MutableCollection, RandomAccessCollection,
                              RangeReplaceableCollection, Sendable, ExpressibleByArrayLiteral {
    public typealias Element = Transcript.Entry
    public mutating func append(_ newElement: Entry)
    public mutating func append(contentsOf newElements: some Sequence<Entry>)
    public mutating func replaceSubrange<C>(_ subrange: Range<Index>, with newElements: C) where C.Element == Entry
  }
  public var history: HistoryView { get set }
}
// also: SessionPropertyValues.history, and the .historyTransform profile modifier
```

`Transcript.history` is a *filtered, mutable* view (its own opaque `Index` type, so it excludes some entries — presumably the instructions). This is the supported way to trim a live session's history on iOS 27.

### Codable fidelity — measured

Round-tripped each entry type individually through `JSONEncoder`/`JSONDecoder`:

| Entry | Result |
|---|---|
| `.instructions` with `toolDefinitions` | exact |
| `.prompt` | exact |
| `.prompt` with `responseFormat` | exact |
| `.prompt` with `metadata` + `contextOptions` | exact |
| `.toolOutput` | exact |
| `.response` (text) | exact |
| `.response` with `metadata` | exact |
| `.reasoning` with `signature` | exact |
| `.response` with a `.structure` segment | content preserved, `==` fails (GeneratedContent identity) |
| `.toolCalls` | content preserved, `==` fails (GeneratedContent identity) |

The two "lossy" rows print identical descriptions and identical JSON; the inequality is `GeneratedContent`'s embedded `GenerationID`, not lost data. **Treat `Transcript` as safely serialisable.** `GenerationOptions` survives encoding, including `samplingMode` with seed.

The on-disk format is versioned: `{"type":"FoundationModels.Transcript","version":"1.1","transcript":{"entries":[…]}}`, with entries encoded in a Chat-Completions-like shape (`role: instructions|user|response|tool|reasoning`, `contents`, `toolCalls` with arguments as a JSON *string*). `fm count-tokens --transcript <file>` consumes this format, which makes cross-checking a bridge's transcript construction against the CLI easy.

### TranscriptErrorHandlingPolicy (iOS 27)

```swift
@available(iOS 27.0, …) public struct TranscriptErrorHandlingPolicy : Sendable {
  public static let revertTranscript: TranscriptErrorHandlingPolicy
  public static let preserveTranscript: TranscriptErrorHandlingPolicy
}
```

Controls whether a failed turn is rolled out of the transcript. Irrelevant under rebuild-per-request; relevant if we adopt session reuse.

---

## 7. Structured output

### GenerationSchema

```swift
@available(iOS 26.0, …) public struct GenerationSchema : Sendable, Codable, CustomDebugStringConvertible {
  @available(iOS 27.0, …) public var name: String { get }

  public init(type: any Generable.Type, description: String? = nil, properties: [Property])
  @available(iOS 26.4, …) public init(type:description:representNilExplicitlyInGeneratedContent:properties:)
  public init(type: any Generable.Type, description: String? = nil, anyOf choices: [String])
  public init(type: any Generable.Type, description: String? = nil, anyOf types: [any Generable.Type])
  public init(root: DynamicGenerationSchema, dependencies: [DynamicGenerationSchema]) throws   // ← runtime path
}
```

### DynamicGenerationSchema — the complete construction API

```swift
@available(iOS 26.0, …) public struct DynamicGenerationSchema : Sendable {
  @available(iOS 26.4, …) public static var null: DynamicGenerationSchema { get }

  public init(name: String, description: String? = nil, properties: [Property])
  @available(iOS 26.4, …) public init(name: String, description: String? = nil,
                                      representNilExplicitlyInGeneratedContent: Bool, properties: [Property])
  public init(name: String, description: String? = nil, anyOf choices: [DynamicGenerationSchema])
  public init(name: String, description: String? = nil, anyOf choices: [String])
  public init(arrayOf itemSchema: DynamicGenerationSchema, minimumElements: Int? = nil, maximumElements: Int? = nil)
  public init<Value>(type: Value.Type, guides: [GenerationGuide<Value>] = []) where Value : Generable
  public init(referenceTo name: String)

  public struct Property : Sendable {
    public init(name: String, description: String? = nil,
                schema: DynamicGenerationSchema, isOptional: Bool = false)
  }
}
```

### GenerationGuide — the complete constraint vocabulary

```swift
// String
static func constant(_ value: String) -> GenerationGuide<String>
static func anyOf(_ values: [String]) -> GenerationGuide<String>
static func pattern<Output>(_ regex: Regex<Output>) -> GenerationGuide<String>
// Int / Float / Double / Decimal
static func minimum(_ value: T) -> GenerationGuide<T>
static func maximum(_ value: T) -> GenerationGuide<T>
static func range(_ range: ClosedRange<T>) -> GenerationGuide<T>
// Arrays
static func minimumCount<Element>(_ count: Int) -> GenerationGuide<[Element]>
static func maximumCount<Element>(_ count: Int) -> GenerationGuide<[Element]>
static func count<Element>(_ range: ClosedRange<Int>) -> GenerationGuide<[Element]>
static func count<Element>(_ count: Int) -> GenerationGuide<[Element]>
static func element<Element>(_ guide: GenerationGuide<Element>) -> GenerationGuide<[Element]>
```

No string min/max length. No `multipleOf`. No `format`/`uniqueItems`. No object-level min/max properties.

### Verified runtime capability matrix

Built and compiled each of these against the live framework (`GenerationSchema(root:dependencies:)` succeeded and produced the shown JSON Schema):

| Construct | Works | Emitted JSON Schema |
|---|---|---|
| object with string/int/bool/double props | ✅ | `{"type":"object","title":…,"properties":{…},"additionalProperties":false,"required":[…],"x-order":[…]}` |
| optional property (`isOptional: true`) | ✅ | omitted from `required`, still in `x-order` |
| int `range(0...120)` | ✅ | `{"type":"integer","minimum":0,"maximum":120}` |
| double `minimum`/`maximum` | ✅ | `{"type":"number","minimum":0,"maximum":1}` |
| string enum (`anyOf: [String]`) | ✅ | `{"type":"string","enum":["red","green","blue"]}` |
| string `pattern(regex)` | ✅ | `{"type":"string","pattern":"[A-Z]{3}\\-[0-9]{4}"}` |
| string `anyOf([...])` guide | ✅ | `{"type":"string","enum":["a","b"]}` |
| string `constant("fixed")` | ✅ | `{"const":"fixed"}` |
| array of objects, `minimumElements`/`maximumElements` | ✅ | `{"type":"array","items":{"$ref":"#/$defs/Item"},"minItems":1,"maxItems":3}` |
| array of primitives, unbounded | ✅ | `{"type":"array","items":{"type":"string"}}` |
| union of object types (`anyOf: [DynamicGenerationSchema]`) | ✅ | `{"anyOf":[{"$ref":"#/$defs/A"},{"$ref":"#/$defs/B"}]}` |
| named references + `dependencies:` | ✅ | hoisted to `$defs` |
| **inline nesting with `dependencies: []`** | ✅ | nested schema auto-hoisted to `$defs`; a dependency list is *not* required |
| `.null` schema as a property | ✅ | `{"type":"null"}` |
| `representNilExplicitlyInGeneratedContent: true` | ✅ | property present, `required: []` |
| 5-level deep nesting via references | ✅ | — |
| undefined reference | throws `SchemaError.undefinedReferences(schema: "R", references: ["Missing"], …)` |
| duplicate property name | throws `SchemaError.duplicateProperty(schema: "D", property: "p", …)` |
| empty `anyOf` | throws `SchemaError.emptyTypeChoices(schema: "E", …)` |

So the plan's §4 documented subset — "objects, arrays, strings, numbers, booleans, enums, optional fields, nesting" — is fully achievable, and can be extended with numeric bounds, array counts, regex patterns, const, unions, and null. Reject `multipleOf`, `minLength`/`maxLength`, `format`, `uniqueItems`, `allOf`/`oneOf`/`not`, and tuple-form `items` as `invalidRequest`.

### Surprise: `GenerationSchema` decodes directly from JSON Schema

`GenerationSchema : Codable` is not just for persistence. Measured:

```swift
let schema = try JSONDecoder().decode(GenerationSchema.self, from: Data(jsonSchemaString.utf8))
```

works for flat objects, nested objects, arrays with `minItems`/`maxItems`, string `enum`, `pattern`, `const`, numeric `minimum`/`maximum`, `$defs` + `$ref`, and top-level `anyOf`. **This is a much shorter route from a JS-supplied JSON Schema to a native schema than walking the tree into `DynamicGenerationSchema`.**

Caveats, all measured:

- Object nodes **require** `title`, `additionalProperties`, `required`, and the Apple extension `x-order` (an array giving property order). Omitting `x-order` → `keyNotFound "x-order"`. Omitting `additionalProperties` → `keyNotFound "additionalProperties"`.
- `multipleOf`, `minLength`, `maxLength`, `format` are **silently dropped** — decoding succeeds and the constraint disappears.
- `type: ["string","null"]` → `typeMismatch` (no union-type form).
- `allOf` → `dataCorrupted: "None of these keys were present: 'type', 'const', '$ref', 'anyOf'"`.

Recommended design: normalise the incoming JSON Schema in TypeScript (inject `title`, `additionalProperties: false`, `required`, `x-order`; reject unsupported keywords with a clear error; warn on silently-dropped ones), then hand the normalised document to Swift and `JSONDecoder().decode(GenerationSchema.self, …)`. Keep the `DynamicGenerationSchema` path as a fallback/validation cross-check. This moves most of the schema logic into testable TypeScript, which matches the plan's "prefer TypeScript over native" preference — and the whole normaliser is unit-testable in Node with no device.

### GeneratedContent — reading values out

```swift
@available(iOS 26.0, …) public struct GeneratedContent : Sendable, Equatable, Generable {
  public var id: GenerationID?

  public init(json: String) throws
  public var jsonString: String { get }
  public init(kind: GeneratedContent.Kind, id: GenerationID? = nil)
  public var kind: GeneratedContent.Kind { get }
  public init(properties: KeyValuePairs<String, any ConvertibleToGeneratedContent>, id: GenerationID? = nil)
  public init<S>(properties: S, id:, uniquingKeysWith:) rethrows where S.Element == (String, any ConvertibleToGeneratedContent)
  public init<S>(elements: S, id: GenerationID? = nil) where S.Element == any ConvertibleToGeneratedContent
  public init(_ value: some ConvertibleToGeneratedContent)

  public func value<Value>(_ type: Value.Type = Value.self) throws -> Value where Value : ConvertibleFromGeneratedContent
  public func value<Value>(_ type: Value.Type = Value.self, forProperty property: String) throws -> Value
  public func value<Value>(_ type: Value?.Type = Value?.self, forProperty property: String) throws -> Value?
  public var isComplete: Bool { get }
}

public enum Kind : Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([GeneratedContent])
  case structure(properties: [String : GeneratedContent], orderedKeys: [String])
}
```

Verified: `GeneratedContent(json:)` parses arbitrary JSON (including `null` and nested objects); `jsonString` round-trips it; `value(_:forProperty:)` extracts `String`, `Int`, `[String]`; the optional overload returns `nil` for an absent property rather than throwing; `isComplete` is `true` for a fully-parsed document. `Kind.structure` gives both a dictionary and `orderedKeys`, so the bridge can preserve property order when converting to a JS object.

**For the bridge, the whole structured-output path is just: JSON Schema in → `GeneratedContent.jsonString` out.** No `@Generable` macro is needed anywhere; use the `schema:`/`Response<GeneratedContent>` overloads. Note the doc comment on `init(json:)`: *"The JSON string you provide may be incomplete. This is useful for correctly handling partially generated responses."* — so streaming partial objects can be forwarded to JS as raw JSON text without waiting for validity.

Built-in `Generable` conformances: `Bool`, `String`, `Int`, `Float`, `Double`, `Decimal`, `Array` (where `Element: Generable`), `Optional`, `Never`, `GeneratedContent`, and (iOS 27) `ImageReference`.

---

## 8. Tool protocol

```swift
@available(iOS 26.0, …)
public protocol Tool<Arguments, Output> : Sendable {
  associatedtype Output : PromptRepresentable
  associatedtype Arguments : ConvertibleFromGeneratedContent
  var name: String { get }                        // default: derived from type name
  var description: String { get }                 // required
  var parameters: GenerationSchema { get }        // default only when Arguments: Generable
  var includesSchemaInInstructions: Bool { get }  // default provided
  @concurrent func call(arguments: Self.Arguments) async throws -> Self.Output
}
```

Explicitly unavailable: `Arguments == String | Int | Double | Float | Decimal | Bool` — each has an `@available(*, unavailable, message: "…Use '@Generable' struct instead.")` `parameters` witness.

**But `Arguments == GeneratedContent` works**, because `GeneratedContent : Generable` (hence `ConvertibleFromGeneratedContent`), and `Output == String` works because `String : PromptRepresentable`. So the bridge tool is:

```swift
struct BridgedTool: Tool {
  typealias Arguments = GeneratedContent
  typealias Output = String
  let name: String
  let description: String
  let parameters: GenerationSchema          // built at runtime from the JS-supplied JSON Schema
  var includesSchemaInInstructions: Bool { true }
  func call(arguments: GeneratedContent) async throws -> String {
    // arguments.jsonString → JS; await the JS result; return it as text
  }
}
```

`call` is `async throws`, marked `@concurrent`, so suspending on a JS round trip is natively supported — no polling or semaphore tricks. Handler exceptions surface as `LanguageModelSession.ToolCallError(tool:underlyingError:)`. Tools are passed at session construction (`tools: [any Tool]`) and are recorded in the transcript as `Transcript.ToolDefinition`, with a convenience `ToolDefinition(tool: some Tool)`.

Tool-call *lifecycle* is observable on iOS 27 through `.onToolCall { Transcript.ToolCall }` / `.onToolOutput { ToolCall, ToolOutput }` profile modifiers, and through `Snapshot.transcriptEntries`, which now includes tool entries mid-stream — so the bridge can emit tool-call events from a single streaming loop rather than needing a separate channel.

Two ready-made tools ship in the Vision overlay (iOS 27): `BarcodeReaderTool`, `OCRTool`.

`ToolCallingMode.required` doc warns the session *loops* until a tool throws or the mode changes — a hang risk worth a timeout in the bridge.

---

## 9. What's actually new in iOS 27

Grouped by relevance to the plan.

### Private Cloud Compute / server model — yes, it shipped

```swift
@_hasMissingDesignatedInitializers
@available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *)
@available(tvOS, unavailable)
final public class PrivateCloudComputeLanguageModel : Sendable {
  convenience public init()
}
extension PrivateCloudComputeLanguageModel {
  final public var availability: Availability { get }    // .available | .unavailable(.deviceNotEligible | .systemNotReady)
  final public var isAvailable: Bool { get }
  final public var quotaUsage: QuotaUsage { get }
  final public var capabilities: LanguageModelCapabilities { get }
  nonisolated(nonsending) final public var contextSize: Int { get async throws }
  nonisolated(nonsending) final public var supportedLanguages: Set<Locale.Language> { get async throws }
  nonisolated(nonsending) final public func supportsLocale(_ locale: Locale = .current) async throws -> Bool
}
public struct QuotaUsage : Sendable {
  public var status: Status          // .belowLimit(BelowLimit(isApproachingLimit:)) | .limitReached(LimitReached)
  public var limitIncreaseSuggestion: LimitIncreaseSuggestion?   // .show() presents system UI
  public var resetDate: Date?
  public var isLimitReached: Bool { get }
}
```

Measured on this Mac: `availability == .available`, `isAvailable == true`, `contextSize == 32768`, 24 supported languages, `quotaUsage.status == .belowLimit(isApproachingLimit: false)`. It is `Observable`, it conforms to `LanguageModel`, and `LanguageModelSession(model:tools:transcript:)` accepts it via the iOS 27 `some LanguageModel` overloads — **so the same session/respond/stream/tool code paths work against PCC with no new API.**

This is a meaningful strategic finding for the package: on iOS 27 there is a **first-party, free-at-the-point-of-use, 32K-context cloud model reachable through the identical API**. A third provider — `apple-pcc` — becomes an obvious router tier between on-device and the developer's own cloud endpoint, with `quotaUsage` as the routing signal and `PrivateCloudComputeLanguageModel.Error.quotaLimitReached(resetDate:)` as the fallback trigger. The plan's two-tier hybrid router (§1) should be widened to three tiers. Worth confirming with the maintainer before building, and worth checking whether it needs an entitlement (a PCC `respond` on this machine failed with a nested `ModelManagerError 1046`, though on-device generation is also broken here, so that is not conclusive).

### Image / multimodal input — yes

```swift
@available(iOS 27.0, …) public struct Attachment<Content> {
  public func label(_ label: String) -> Attachment<Content>
}
extension Attachment : PromptRepresentable, InstructionsRepresentable { … }
public struct ImageAttachmentContent : Sendable, Equatable { }
extension Attachment where Content == ImageAttachmentContent {
  public init(_ cgImage: CGImage, orientation: CGImagePropertyOrientation? = nil)
  public init(_ ciImage: CIImage, orientation: CGImagePropertyOrientation? = nil)
  public init(_ pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation? = nil)
  public init(imageURL: URL, orientation: CGImagePropertyOrientation? = nil)
}
// UIKit overlay: init(_ uiImage: UIImage, orientation: UIImage.Orientation? = nil)

extension Transcript {
  public enum Attachment : Sendable, Equatable { case image(Transcript.ImageAttachment) }
  public struct ImageAttachment : Sendable, Equatable {
    public var url: URL? { get }
    public var cgImage: CGImage { get }
    public var ciImage: CIImage { get }
    public func pixelBuffer(resolution: CGSize? = nil, pixelFormat: OSType? = nil) throws -> CVReadOnlyPixelBuffer
    public var orientation: CGImagePropertyOrientation { get }
    public init(_ cgImage: CGImage, orientation: CGImagePropertyOrientation? = nil)
    public init(_ ciImage: CIImage, orientation: CGImagePropertyOrientation? = nil)
    public init(_ pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation? = nil)
    public init(imageURL: URL, orientation: CGImagePropertyOrientation? = nil)
  }
}
@available(iOS 27.0, …) public struct ImageReference : Sendable, Equatable, Generable {
  public let attachmentLabel: String
  public func resolved(in transcript: some Sequence<Transcript.Entry>) -> Transcript.ImageAttachment?
}
```

The framework now `public import`s CoreGraphics, CoreImage, CoreVideo, and ImageIO. `capabilities.contains(.vision)` is `true` for the on-device model on this machine. `Transcript.AttachmentSegment` means image inputs live in the transcript and therefore survive rebuild-per-request — a bridge can accept image paths/URLs from JS and build `ImageAttachment(imageURL:)`. `ImageReference` is `Generable`, so a model can *refer* to an attached image in structured output.

Runtime note: `ImageAttachment(imageURL:)` is eager — constructing one with a nonexistent path threw `"Could not load image file:///tmp/nope.png"` at encode time. Validate paths before constructing.

Image input is out of scope for a first release (the plan's §8 excludes it implicitly), but the transcript and capability plumbing should not be designed in a way that blocks it.

### Custom model backends (`LanguageModel` / `LanguageModelExecutor`)

```swift
@available(iOS 27.0, …) public protocol LanguageModelExecutor : Sendable {
  associatedtype Configuration : Hashable, Sendable
  associatedtype Model : LanguageModel
  init(configuration: Self.Configuration) throws
  func prewarm(model: Self.Model, transcript: Transcript)
  nonisolated(nonsending) func respond(to request: LanguageModelExecutorGenerationRequest,
                                       model: Self.Model,
                                       streamingInto channel: LanguageModelExecutorGenerationChannel) async throws
}
public struct LanguageModelExecutorGenerationRequest : Sendable {
  public var id: UUID
  public var transcript: Transcript
  public var enabledToolDefinitions: [Transcript.ToolDefinition]
  public var schema: GenerationSchema?
  public var generationOptions: GenerationOptions
  public var contextOptions: ContextOptions
  public var metadata: [String : GeneratedContent]
}
public struct LanguageModelExecutorGenerationChannel : AsyncSequence, Sendable {
  nonisolated(nonsending) public func send(_ event: Event) async
}
// Event factories: .response(entryID:action:), .reasoning(entryID:action:), .toolCalls(entryID:action:)
// Response.Action: .appendText(_:segmentID:tokenCount:), .replaceTextSegment(…),
//                  .addAttachmentSegment(_:), .removeAttachmentSegment(id:),
//                  .updateMetadata(_:), .updateUsage(input:output:metadata:)
// ToolCalls.Action: .toolCall(id:name:action:), .removeToolCall(id:), .updateMetadata, .updateUsage
// ToolCall.Action: .appendArguments(_:tokenCount:), .updateMetadata
// Reasoning.Action: .appendText, .replaceTextSegment, .updateSignature(_:tokenCount:), .updateMetadata, .updateUsage
```

**This is the biggest structural addition in iOS 27, and it inverts part of the plan's architecture.** Apple has made `LanguageModelSession` pluggable: you can implement `LanguageModel` + `LanguageModelExecutor` over *any* backend — including an HTTP call to the developer's cloud endpoint — and then the framework's own session, transcript, tool loop, guided generation, and `ResponseStream` all work against it. Note that the executor protocol is explicitly **delta-oriented** (`appendText`, `appendArguments`, with per-fragment `tokenCount`), while the consumer-facing `ResponseStream` remains snapshot-oriented; the framework does the accumulation.

Implication worth putting to the maintainer: a *native* hybrid router is now possible (one `LanguageModelSession`, two executors), which would be a different product from the TypeScript router in the plan's §4. It would also be far more native code to maintain, and would strand iOS 26. **Recommendation: stay with the plan's TypeScript router** (it is the only option on iOS 26, it keeps Android viable, and it matches the maintainer's stated preference), but record this in `DECISIONS.md` as the road not taken, with the note that it becomes attractive if iOS 27 ever becomes the floor.

### Instructions/Profile DSL and session properties (iOS 27)

`DynamicInstructions` + `DynamicInstructionsBuilder` (with `ForEach`, conditionals, tool interpolation), `LanguageModelSession.Profile` / `DynamicProfile` / `DynamicProfileBuilder` / `DynamicProfileModifier`, and `@SessionProperty` / `SessionPropertyValues` / `@SessionPropertyEntry`. Profile modifiers include `.model`, `.temperature`, `.samplingMode`, `.maximumResponseTokens`, `.reasoningLevel`, `.toolCallingMode`, `.historyTransform`, `.transcriptErrorHandlingPolicy`, and lifecycle hooks `.onPrompt/.onResponse/.onReasoning/.onToolCall/.onToolOutput/.onActivate/.onDeactivate`.

This is a SwiftUI-style declarative layer aimed at Swift apps. **Almost none of it is usable across a JS bridge** (it is result-builder and macro driven). Two exceptions worth harvesting:

- `.historyTransform` — a declarative hook for context trimming.
- The `.onToolCall`/`.onToolOutput`/`.onResponse` hooks — a clean way to emit bridge events without wrapping every call site.

Note `Transcript.HistoryView` is also exposed as a session property (`SessionPropertyValues.history`).

### Other iOS 27 additions

- `Transcript.Entry.reasoning` + `Transcript.Reasoning` (with an opaque `signature: Data?`).
- `Transcript` becomes `MutableCollection` + `RangeReplaceableCollection`; `session.transcript` gains `_modify`.
- `LanguageModelSession.Usage` / `Response.usage` / `Snapshot.usage` / `session.usage`.
- `GenerationOptions.toolCallingMode`; `SamplingMode.kind`; `ToolCallingMode`.
- `GenerationSchema.name`; `Transcript.ToolDefinition.parameters` becomes settable; `Transcript.ResponseFormat.kind`.
- `StructuredSegment.source` renamed to `schemaName` (deprecated, back-deployed shim provided).
- `Transcript.Response.metadata` replaces `assetIDs` as the general mechanism (back-deployed shim maps `assetIDs` into metadata).
- `GeneratedContent.ParsingError`.
- `TranscriptErrorHandlingPolicy`.
- `LanguageModelSession` and `Transcript` gain watchOS 27 availability (the framework arrives on watchOS in 27; `SystemLanguageModel` itself is still `@available(watchOS, unavailable)`, so only PCC is usable there). tvOS remains unavailable everywhere.
- `@Generable(name:description:representNilExplicitlyInGeneratedContent:)` — a third macro overload.
- Vision overlay tools; UIKit overlay `UIImage` attachment.

### Removed / obsoleted in iOS 27

- `SystemLanguageModel.Adapter` and `SystemLanguageModel(adapter:guardrails:)` — `obsoleted: 27.0`.
- `LanguageModelSession.GenerationError` — every case deprecated (still present).
- `GenerationOptions.init(sampling:…)` and `.sampling` — deprecated in favour of `samplingMode`.

---

## 10. `fm` CLI parity (for the Phase 1 integration tests)

`/usr/bin/fm` is present. Subcommands: `available`, `chat`, `count-tokens`, `license`, `respond`, `schema`, `serve`. Models listed: only `system` (on-device) — **PCC is not exposed through the CLI**, so `fm serve` cannot stand in for PCC testing.

- `fm count-tokens` accepts a bare prompt, `-i/--instructions`, repeatable `--text`, repeatable `--image`, `--transcript <file>` ("Saved transcript to count as a framed conversation"), `-q/--quiet` for a bare integer, and stdin. The `--transcript` flag consumes the same `Transcript` Codable JSON the framework produces — a free cross-check for the bridge's transcript construction. Help text: *"Only works with the on-device system model."*
- `fm schema object --name … --string … --int … --boolean …` emits a generation schema — useful for golden-file testing the TypeScript JSON-Schema normaliser against Apple's own output shape.
- `fm respond` supports `--image`, `--stream`, `--use-case content-tagging`.
- `fm license` reports terms already accepted on this machine. Note the terms text includes *"YOU ARE ALSO AGREEING TO NOT PROGRAMMATICALLY ACCESS OR USE APPLE MODELS THROUGH APPLE SOFTWARE OR SERVICES EXCEPT AS EXPRESSLY PERMITTED."* — relevant to how the README describes the `fm serve`-based dev workflow; that workflow is a local development aid, not something to bake into the shipped package.

---

## 11. Discrepancies against `docs/plan.md`

| Plan statement | Reality |
|---|---|
| §2 "the framework has supported initializing a session from a transcript; verify the current initializer" | ✅ Confirmed. `init(model:tools:transcript:)` since iOS 26.0, plus two `history:`-taking initializers new in 27. |
| §4 "Streaming yields snapshots, not deltas… check what the current SDK does" | ✅ Still snapshots. `ResponseStream.Element == Snapshot`; diffing required. |
| §4 "Token counting may or may not exist natively" | **It exists and is public** — five `SystemLanguageModel.tokenCount(for:)` overloads at iOS 26.4+, including one for a collection of transcript entries. The heuristic estimator is still needed for 26.0–26.3 and for PCC. |
| §1 "8K tokens on the newer model variant, 4K on older ones" | Neither number is in the SDK as a constant. `contextSize: Int` is the API; the only literal is the `4096` pre-26.4 back-deploy fallback. Measured PCC = 32768; on-device returned `0` on this machine (broken assets). **Read `contextSize`, guard `<= 0`.** |
| §2 taxonomy puts `unsupportedLocale` under `unavailable` reasons | Wrong placement. `Availability.UnavailableReason` has exactly three cases, none locale-related. Locale failure is `LanguageModelError.unsupportedLanguageOrLocale` at generation time. Use `supportsLocale()` to *predict* it, and give it its own error code. |
| §4 "Context overflow is an error, not a truncation" | ✅ Confirmed, and better than expected: `ContextSizeExceeded` carries `contextSize` **and** `tokenCount`. |
| §4 "One request per session at a time" | ✅ Confirmed as a typed error on 27 (`LanguageModelSession.Error.concurrentRequests`); `isResponding` is the pre-check. iOS 27 adds `transcriptMutationWhileResponding`. |
| §4 "`DynamicGenerationSchema` built at runtime from JSON Schema" | Works, and there is a **shorter route**: `GenerationSchema` is `Codable` and decodes a JSON Schema document directly (needs `title`, `additionalProperties`, `required`, `x-order`). Prefer normalise-in-TypeScript + `JSONDecoder`. |
| §4 "Tool calling crosses the bridge mid-generation… request/response protocol over events" | Still true, but simpler than feared: `Tool.call` is `async throws` and `@concurrent`, so the Swift side can just `await` the JS round trip. `Arguments == GeneratedContent`, `Output == String` compiles (`Arguments == String` is explicitly unavailable). |
| §3/§9 "anything new in iOS 27 (Private Cloud Compute access, image input, context options)" | All three shipped. PCC is a full `LanguageModel` usable through the same session API with 32K context and a quota API → **argues for a third router tier.** `ContextOptions` is prompt-shaping, not window sizing. Images are in the transcript via `AttachmentSegment`. |
| §8 "adapter/LoRA loading out of scope" | Fortunate: the adapter API is `obsoleted: 27.0` and cannot be used against this SDK. |
| §5 Phase 3 step 4 "Session prewarming, if the SDK offers it" | It does: `prewarm(promptPrefix: Prompt? = nil)`, with a documented ≥1 s lead-time requirement. |
| §6 general | Two *undiscovered* levers the plan should account for: `SystemLanguageModel.Guardrails.permissiveContentTransformations`, and the iOS 27 pluggable `LanguageModelExecutor` (noted as a road not taken). |

---

## 12. ⚠️ Environment blocker

**On-device generation does not currently work on this Mac.** Everything that only reads metadata works; everything that runs the model fails.

| Call | Result |
|---|---|
| `SystemLanguageModel.default.availability` | `.available` |
| `fm available` | `System model available` |
| `model.contextSize` | `0` |
| `model.tokenCount(for:)` (all 5 overloads) | throws `LanguageModelError` wrapping `ModelManagerServices.ModelManagerError 1013` |
| `fm count-tokens 'Hello world'` | same `ModelManagerError 1013` |
| `session.respond(to:)` | `NSError com.apple.SensitiveContentAnalysisML error 15` |
| `session.streamResponse(to:)` | same |
| `fm respond '…'` | same |
| PCC `respond`/`stream` | `LanguageModelError -1` wrapping `ModelManagerError 1046` |

Likely cause: the guardrail/safety model asset is missing. `/System/Library/AssetsV2/` contains `com_apple_MobileAsset_UAF_FM_GenerativeModels`, `…_FM_CodeLM`, `…_FM_Overrides`, `…_FM_Visual`, but **no SensitiveContentAnalysis asset** — and `SensitiveContentAnalysisML error 15` is raised before any token is produced. `fm license` confirms terms are accepted, so that is not it.

Consequences for the plan:

- **Phase 1's acceptance criterion — a Node script holding a multi-turn conversation with `fm serve` — is blocked** until this is resolved. Reproducing with `fm respond` is a one-command check; re-run it before starting Phase 1.
- Plausible fixes to try, in order: open System Settings → Apple Intelligence & Siri and confirm it is fully enabled and finished downloading; reboot (asset activation often needs one); if `availability` still reports `.available` while generation fails, that mismatch is itself worth reporting to Apple.
- Everything in this document that is marked "measured" for metadata, schema construction, `GeneratedContent`, and `Transcript` Codable **is** verified against the live framework; only the generation and token-count numbers are unverified.
- Design lesson worth keeping: **`availability == .available` is not a promise that generation will succeed.** The provider should treat a first-request failure as a real, reportable error state, and `capabilities()` should tolerate `contextSize == 0` and a throwing `tokenCount`.
