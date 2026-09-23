# Prior-art reconnaissance: Apple FoundationModels bridges (Section 3 of plan.md)

Written 2026-09-20. Repos shallow-cloned (`--depth 1`) into a scratch directory and read
directly; GitHub metadata (issue counts, stars, push dates) pulled from the GitHub API.
This document is the writeup called for in plan.md Phase 0 ("Read the prior art in
section 3. Write up what each does well and where it struggles") and answers the
"wrap vs. build" question the plan raises.

---

## 1. `@react-native-ai/apple` (callstackincubator/ai monorepo)

**License:** MIT. **Last commit:** 2026-07-07 (monorepo). **Open issues:** 13 (monorepo-wide).
**Stars:** 1,403. **Maintenance:** best of the group — active monorepo with many other
provider packages, single primary author (Mike Grabowski/Callstack) but a real
organization behind it. No CHANGELOG file found in the package itself.

**Native module tech:** TurboModule (New Architecture), *not* Expo Modules API and not
Nitro. `packages/apple-llm/src/NativeAppleLLM.ts` uses
`TurboModuleRegistry.getEnforcing<Spec>('NativeAppleLLM')`; `ios/AppleLLM.mm` declares
`@interface AppleLLM : NativeAppleLLMSpecBase <NativeAppleLLMSpec, RCTCallInvokerModule>`,
codegen driven by `codegenConfig` in `package.json`. The Swift implementation is a plain
`NSObject` bridged manually through the `.mm` file.

**Availability:** No reason codes — `isAvailable()` is a bare boolean
(`SystemLanguageModel.default.availability == .available`, `AppleLLMImpl.swift:24-34`).
Apple's `.unavailable(.deviceNotEligible/.appleIntelligenceNotEnabled/.modelNotReady)`
cases are never inspected. This is a real gap relative to what our plan requires.

**generate() / sessions:** Stateless per call — every call rebuilds a fresh
`LanguageModelSession` from the full message array (`AppleLLMImpl.swift:90-94,157-161`).
Callers can supply full system/user/assistant history via `createTranscriptAndPrompt`
(`:339-384`), mapping system→`.instructions`, prior turns→`.prompt`/`.response` entries
into a `Transcript`; the last message must be `role: "user"` or it throws
`invalidMessage`. This is exactly the rebuild-per-request pattern our plan proposes,
independently validated.

**Streaming — snapshots converted to deltas in TypeScript, not Swift, and inconsistently.**
Swift forwards each native chunk verbatim (`onUpdate(streamId, chunk.content)` per
snapshot). The AI-SDK-facing path (`src/ai-sdk.ts:410-421`) does the diffing:
```ts
const nextRawContent = String(data.content ?? '')
const rawDelta = nextRawContent.startsWith(previousRawContent)
  ? nextRawContent.slice(previousRawContent.length)
  : nextRawContent
previousRawContent = nextRawContent
if (rawDelta === 'null') return   // works around bogus "null" chunks
```
The older non-AI-SDK helper (`src/stream.ts:38-46`) does **not** diff — it forwards raw
cumulative content as `text-delta`, a latent inconsistency between the two streaming
entry points in the same package.

**Structured output:** Builds `DynamicGenerationSchema` from JSON Schema at runtime via
`AppleLLMSchemaParser` (`AppleLLMImpl.swift:461-633`). Supports object/array/string/
number/integer/boolean, `enum` (via `GenerationGuide.anyOf`), `pattern`, numeric bounds
(exclusive bounds approximated with `.nextUp`/`.nextDown` since Apple only supports
inclusive), and top-level `anyOf`. Explicitly rejects unknown types and `multipleOf`
("not supported by Apple Foundational models"). Silently unsupported: `oneOf`/`allOf`/
`not`, `additionalProperties`, `$ref`, string length/format constraints, `uniqueItems`.
Numeric enums are coerced to string guides with a JS-side re-parse workaround, since
`GenerationGuide.anyOf` only accepts `[String]`.

**Tool calling:** Native→JS calls go through a raw JSI global-function lookup, not the
RN event emitter. Swift's `JSITool.call` invokes `invokeJavaScriptTool`; the ObjC glue in
`AppleLLM.mm` does `callInvoker->invokeAsync`, resolving
`rt.global().getPropertyAsObject("__APPLE_LLM_TOOLS__").getPropertyAsFunction(toolId)`,
handling both sync-return and Promise cases. JS populates
`globalThis.__APPLE_LLM_TOOLS__[tool.id] = tool.execute` before each call and cleans up
in a `finally`. Call correlation is a plain dictionary key, not a structured call-ID
protocol. **No timeout exists anywhere in the tool-call path** (confirmed by grep), and
cancellation (`cancelStream`) cancels the Swift `Task` but does not abort or reject an
in-flight JSI tool invocation — the pending JS promise is left dangling. This is the
single biggest correctness gap found across all four bridges for the exact protocol our
plan needs to design carefully.

**Token counting:** Native, not estimated — `SystemLanguageModel.default.tokenCount(for:)`,
gated `@available(iOS 26.4, *)`; below that OS it returns `UNSUPPORTED_OS` and the TS
layer degrades gracefully.

**Prewarming:** Not implemented for the chat/LLM path — `prepare()` exists only for the
transcription/embeddings models; `AppleLLMChatLanguageModel.prepare()` is a no-op.

**Locale support:** Minimal — only `getCurrentLocale()` (device locale identifier via
`NSLocale`), used as a default for embeddings/speech, not exposed for the LLM itself and
no `unsupportedLocale` availability reason.

**iOS 26 vs 27:** Only two gate levels — `#available(iOS 26, *)` for the whole
FoundationModels surface, `#available(iOS 26.4, *)` for `countTokens`. No iOS-27-specific
paths at all (no Private Cloud Compute, no image input, no context-window options).

**Gotchas/quality:** Sparse in-code documentation; a stale TODO
(`AppleLLMImpl.swift:335-337`) still lists "Implement tool calling support" even though
tool calling exists elsewhere in the file. Most `LanguageModelSession.GenerationError`
cases collapse into a generic `GENERATION_ERROR` — only `.exceededContextWindowSize` is
specifically pattern-matched. **LOC:** `AppleLLMImpl.swift` 662 + `AppleLLMError.swift` 87
= 749 lines for the core LLM Swift. The schema-conversion code is genuinely well-built;
the JSI tool-calling glue in the `.mm` file is the hairiest part of the whole package and
the one place cancellation/timeouts are unaddressed.

## 2. SwiftyJunnos/expo-foundation-models

**License:** MIT. **Last commit:** 2026-09-17 (v1.0.2 release, three days before this
writeup). **Open issues:** 0. **Stars:** 3 (small/new, single-author but very actively
worked and unusually well-documented — this is our closest analog project). Also bundles
an unrelated CoreML sub-feature in the same module.

**Native module tech:** Confirmed Expo Modules API. `ios/ExpoFoundationModelsModule.swift`
imports `ExpoModulesCore`, `class ExpoFoundationModelsModule: Module` with
`Events("onToken","onPartialSchema","onToolCall","onAdapterDownload")` and
`AsyncFunction`/`Function` declarations.

**Availability:** `isAvailable()`, `getAvailability()` (switches on real
`model.availability` cases), `getAvailabilityDiagnostics()` ("root cause and
suggestions"), and `getFeatures()` (OS-version string + capability flags, e.g.
`tokenCounting`, `modelVariant`) — the most diagnostic-rich availability surface of the
four bridges.

**generate() / sessions: stateful, no message-array API.** Sessions are held server-side
in a `sessions: [String: LanguageModelSession]` dictionary keyed by `sessionId`. Each
`respond`/`stream` call takes only `sessionId` + a single `FMPrompt` (text + optional
images) — **there is no system/user/assistant message-array parameter at all**, only one
`instructions` string at session creation. `createSessionWithTranscript` exists in the
API surface but is a documented stub: KNOWN_ISSUES Issue #3 and the code itself confirm
"transcript restoration not currently supported by the API" — passed-in history is
discarded, a new empty session is created instead. **This is the least flexible of the
four bridges for our stateless, message-based design** — we would have to either fork it
or work entirely around its session model rather than feed it a transcript per call.

**Streaming:** cumulative snapshots from Apple's API, manually diffed into deltas before
emitting `onToken`, repeated at multiple call sites:
```swift
for try await partialResponse in stream {
    let newContent = partialResponse.content
    if newContent.count > fullResponse.count {
        let newToken = String(newContent.dropFirst(fullResponse.count))
        fullResponse = newContent
        onToken(newToken)
    }
}
```

**Structured output:** runtime JSON Schema → `DynamicGenerationSchema`/`GenerationSchema`
on iOS 27, with an iOS-26 prompt-based fallback (see KNOWN_ISSUES #1 below) — the same
dual-path design our plan may need for backward compatibility. Non-string enums and
scalar length/range constraints "cannot be expressed safely by the iOS 27 native schema
conversion" and silently trigger the prompt fallback rather than being rejected outright.

**Tool calling: prompt-simulated two-turn round trip, not a true mid-generation
pause/resume.** Tool definitions are serialized into the prompt; the model replies with
`{"tool_call": {...}}` as plain text; Swift parses it and fires an `onToolCall` event; JS
executes the tool and calls `submitToolResult(sessionId, {callId, result})`, which simply
builds a **brand-new prompt** embedding the JSON result and calls `session.respond(...)`
again — confirmed no `CheckedContinuation`/pending-call map exists anywhere in the file.
**No timeout or cancellation handling for tool execution exists** — the only timeout
present is Apple's own generation-timeout error code, not a caller-configurable one. This
is explicitly documented as a compile-time-type workaround, not a design choice made
lightly (KNOWN_ISSUES #2).

**Token counting:** estimated only, `content.count / 4` heuristic with a hardcoded
`maxTokens = 4096` fallback; the `tokenCounting` feature flag defaults false and its
`true` state still just reflects whether that estimate path is active, not real counting.

**Prewarming:** implemented (`prewarm()` → `session.prewarm()`), but flagged uncertain in
its own comment: "Note: The prewarm API may have changed - using the simplest form."

**Locale support:** `getLocaleInfo()` returns identifier, preferred languages, calendar,
language/region codes, with version-gated fallback for pre-iOS-16 locale APIs; unsupported
languages normalize to a dedicated error code.

**iOS 26 vs 27 handling — the most thorough of the four bridges.** 48 `#available` call
sites; outer gate on iOS 26 for any FoundationModels use, inner gate on iOS 27 for:
`contextOptions:` parameters, `Attachment<ImageAttachmentContent>` image prompts,
`PrivateCloudComputeLanguageModel()` sessions, native schema conversion, `toolCallingMode`
generation option, and the `Transcript.StructuredSegment.source`→`.schemaName` rename.
Both code paths (iOS 26 fallback, iOS 27 native) share one TypeScript wire format, so
callers never see the version split.

**KNOWN_ISSUES.md — full findings (root of repo, last updated August 2026):**

- **Issue #1, DynamicGenerationSchema Not Supported at Runtime (resolved on iOS 27, iOS
  26 fallback retained).** On iOS 26, `DynamicGenerationSchema(name:properties:)` "does
  not support runtime schema construction" despite looking like it should from the type
  signature — the documented fallback is prompt-embedded schema text plus
  `JSONSerialization` parsing/validation. On iOS 27 it converts natively, but non-string
  enums and scalar length/range constraints still throw during native conversion and
  silently fall back to the iOS-26 prompt path even on iOS 27; `includeSchemaInPrompt:
  false` combined with a schema that needs the fallback produces an explicit error
  instead of silently dropping the schema text.
- **Issue #2, Tool Calling API Requires Compile-Time Types (workaround on all OS
  versions).** "On iOS 26, the native Foundation Models Tool API requires compile-time
  `@Generable` argument types... making it impossible to create dynamic tool definitions
  from JavaScript." The prompt-and-reparse workaround described above is used on *every*
  OS version, including iOS 27 — iOS 27's only addition is a `toolCallingMode` option
  that "never registers an executable native tool," it just shapes prompt/parsing
  strictness.
- **Issue #3, Transcript API Compatibility (partially resolved, workaround retained).**
  `Transcript.StructuredSegment.source` was renamed to `.schemaName` on iOS 27 — "a
  compile-time break handled inside availability-guarded native code." Transcript
  extraction uses reflection to read internal properties on both OS versions;
  `createSessionWithTranscript` remains stubbed regardless of OS version.
- **Issue #4, iOS 27 SDK Gaps vs. Documented API — the "announced but not shipped"
  finding our plan called out.** *"Apple's documentation lists `SystemLanguageModel.
  variant` for iOS 27, but the final SDK does not include the symbol (verified against
  the swiftinterface)."* `getModelVariant()` stays behind the iOS 27 guard and returns
  `null` on every OS version; the `modelVariant` feature flag always reports `false`.
  Also: `SystemLanguageModel(adapter:)` "was obsoleted in the iOS 27 SDK with no
  replacement" — an `adapterId` on iOS 27+ silently falls back to the default model, and
  is rejected outright inside Private Cloud Compute sessions.
- **Error code normalization:** `LanguageModelSession.GenerationError` was itself
  obsoleted in iOS 27 (replaced by `LanguageModelError`/`SystemLanguageModel.Error`/
  `LanguageModelSession.Error`) — the library maps everything to one stable string-code
  set (`contextSizeExceeded`, `rateLimited`, `refusal`, `guardrailViolation`, ...) with an
  explicit old→new rename table (e.g. `exceededContextWindowSize`→`contextSizeExceeded`,
  `unsupportedGuide`→`unsupportedGenerationGuide`), so this single fact alone is useful:
  **the generation-error enum itself is not stable across iOS 26/27** and any Swift
  module we write needs an abstraction layer over it from day one, not added later.
- **Explicit out-of-scope list:** custom `LanguageModel`/`LanguageModelExecutor`
  implementations (Swift-only, "meaningless across the React Native bridge"),
  `DynamicProfile`/`DynamicInstructions` sessions (no bridge representation),
  `transcriptErrorHandlingPolicy`, and the Vision `OCRTool`/`BarcodeReaderTool` wrappers.

**LOC / quality:** Swift 3,792 lines (single file, includes the CoreML sub-module);
TypeScript 3,335 lines across three files; 8 Jest test files including a dedicated
`IOS27Features.test.ts`; a `docs/` folder with 7 topic guides plus a `ROADMAP.md`. This is
dense but unusually disciplined code — doc comments consistently explain *why* a branch
exists and cite verification method ("verified against the swiftinterface"). It is also
the most candid of the four about its own limitations: prewarm, token counting, and
tool-calling are all self-labeled as workarounds rather than presented as complete
features.

## 3. react-native-foundation-models (corasan → renamed henrypldev)

**Note on the repo:** originally `corasan/react-native-foundation-models`; GitHub now
redirects that to `henrypldev/react-native-foundation-models` (confirmed via the GitHub
API, `full_name: henrypldev/react-native-foundation-models`). `git clone` against the old
URL transparently follows the redirect, so no dead link here — just a rename to note if
linking to it from our own docs. Real source lives under a `package/` subdirectory
(podspec, `ios/`, `src/`, `nitro.json`, `nitrogen/generated/`), not the repo root.

**License:** MIT. **Last commit:** 2026-08-11 ("fix: make tool schema contract truthful
(OSS-9) (#19)"). **Open issues:** 0. **Stars:** 7. **Maintenance:** small but recently
very active, with a written design doc for its most recent fix — the strongest
engineering-process signal of the four despite the low star count.

**Native module tech:** Confirmed Nitro Modules. `nitro.json` autolinks
`HybridLanguageModelSessionFactory`; the spec (`src/specs/LanguageModelSession.nitro.ts`)
defines `HybridObject<{ios:'swift'}>` interfaces; full `nitrogen/generated/` C++/Swift
codegen output is present. Nitro's typed codegen visibly reduces bridge boilerplate
relative to the TurboModule and old-bridge approaches used elsewhere in this survey.

**Availability:** granular reason codes on both sides. Swift maps
`SystemLanguageModel.availability` to `available`, `unavailable.deviceNotEligible`,
`unavailable.appleIntelligenceNotEnabled`, `unavailable.modelNotReady`, and
`unavailable.unknown(<reason>)`; TypeScript turns these into human-readable messages via
`getAvailabilityMessage`. On par with the ratley project's coverage but preserves an
`unknown(<reason>)` payload rather than collapsing to a bare `"unknown"` string.

**generate() / sessions: stateful, single-string prompt, no message-history parameter at
all.** There is no `generate<T>()`/structured top-level API — only `respond(prompt:
string)` and `streamResponse(prompt, onStream)`. The native `LanguageModelSession`
(Apple's own transcript-holding object) is created once by the factory and reused across
calls. Distinctively, it **auto-recovers from context overflow**: on
`GenerationError.exceededContextWindowSize` it summarizes the old transcript, builds a
fresh session, and exposes `wasContextReset: Bool` back to JS — a clever pattern, but one
built entirely around trusting the native session's own accumulated state rather than
letting the caller manage history, which conflicts with our plan's message-based,
caller-owns-history design.

**Streaming:** cumulative snapshots, with **zero diffing anywhere** in either layer —
confirmed at both the native and TS levels:
```swift
for try await snapshot in stream {
    finalContent = content(snapshot)
    onContent(finalContent)
}
```
The TS hook mirrors this with a full replace (`setResponse(streamedResponse)`), not an
append. `cancel()` is client-side only (it just ignores subsequent callbacks); there is no
native cancellation call, so a cancelled stream keeps consuming device compute after the
caller has walked away.

**Structured output:** no runtime response-schema generation exists for *generation* at
all. `types.ts` retains vestigial `GenerableSchema`/`GenerableConfig`/`Tool` types
explicitly documented in-repo as "unused by this path and untouched" — leftover from an
earlier approach. `DynamicGenerationSchema` is used **only** for tool arguments/results
(see below), never for a user-facing structured-output call — a materially different
scope than the other three bridges.

**Tool calling — the OSS-9 fix is the standout finding here.** The commit that produced
the current HEAD fixed a real, previously-shipped correctness bug: the prior wire format
was a flat `{key: "typename"}` map, where unsupported schema kinds were silently coerced
to `"string"`, all properties became required regardless of the source schema, enums and
descriptions were lost, nested objects were stringified, `null` became `""`, and
structured tool-*results* were silently dropped — a textbook case of "accept anything,
say nothing" schema handling. The fix (design doc committed alongside it) has TS emit
real JSON Schema (`z.toJSONSchema(schema, {io:'input'})`) and a new 323-line
`ToolSchemaBuilder.swift` recursively builds `DynamicGenerationSchema` from it, explicitly
rejecting `anyOf`/`oneOf`/`allOf`/`not`/`pattern`/`format`/`prefixItems`/`propertyNames`/
`multipleOf`/`exclusiveMin(imum)`/`exclusiveMax(imum)`/`$ref`/`$defs` with a
`SchemaCreationError` naming the offending property path, rather than coercing. Value
conversion is fully recursive in both directions, preserving null/nested/array structure.
The bridge protocol itself is a plain Nitro `Promise<Promise<AnyMap>>` async/await chain
(`call(arguments:) async throws -> some Generable`), not an event/call-ID map — simpler
than the JSI-global or event-emitter approaches elsewhere, but with **no explicit timeout**
on tool execution and no mid-flight cancellation, the same gap found in every other
bridge surveyed. This project is the best available reference for *what a correct,
non-lossy JSON-Schema-to-`DynamicGenerationSchema` translator looks like*, precisely
because its predecessor was demonstrably wrong and the fix is documented.

**Token counting:** native, not estimated — `model.tokenCount(for:)`, gated
`@available(iOS 26.4, *)`; throws `UNSUPPORTED_PLATFORM` below that OS, and the README
documents a hardcoded 4,096-token fallback for pre-26.4 devices since `contextSize` isn't
queryable there either.

**Prewarming:** not implemented — no reference anywhere in the codebase.

**Locale support:** not exposed as a capability query; only an internal
`unsupportedLanguageOrLocale` generation-error code exists.

**iOS 26 vs 27(.4) handling:** the version split here is iOS 26.0-26.3 vs. 26.4+, not
26 vs. 27 — `contextSize` and `tokenCount` require 26.4+, and TS derives a
`FoundationModelsModelFamily` (`'26.0-26.3' | '26.4+'`) from `Platform.Version`. Worth
noting for our own version-gating: the meaningful API boundary on-device may not align
with the marketing OS-version number.

**Documented gotchas:** session-busy state is handled with an `NSLock` + `isResponding`
flag surfaced as `AppleAIError` code `SESSION_BUSY`, and is covered by an actual unit
test (`StreamingResponseAccumulatorTests.swift`) — direct, tested confirmation of our
plan's "one request per session at a time" concern. Guardrail violations map to a
`GUARDRAIL_VIOLATION` code.

**LOC / quality:** Swift 995 lines total (`ToolSchemaBuilder.swift` 323,
`HybridLanguageModelSession.swift` 315, `HybridTool.swift` 127,
`HybridLanguageModelSessionFactory.swift` 101, `AppleAIErrors.swift` 110,
`StreamingResponseAccumulator.swift` 19); TypeScript ≈2,083 lines. Quality is notably high
for a 7-star project: the schema builder is decoupled from NitroModules and independently
unit-tested (`ToolSchemaBuilderTests.swift`, 366 lines) on top of TS-side tests, exhaustive
`GenerationError` case mapping, and a written design doc justifying the rewrite rather
than a silent patch. The clearest case among the four of engineering discipline
outpacing popularity.

## 4. @ratley/react-native-apple-foundation-models

**Repo:** `git+https://github.com/ratley/react-native-apple-foundation-models.git`
(resolved via `npm view @ratley/react-native-apple-foundation-models repository.url`).

**License:** MIT. **npm versions:** only two, `0.1.0`/`0.1.1`, both published
2025-09-28. **Last commit:** 2025-09-28 — a single commit is even visible in the shallow
clone, consistent with a weekend project pushed once and never touched again.
**Open issues:** 0. **Stars:** 3. **Maintenance: abandoned**, essentially a full year
stale as of this writeup (2026-09-20), pre-dating even iOS 26 GA. No CHANGELOG, no tests,
no CI configuration found.

**Native module tech:** Expo Modules API (new architecture) — `ios/
AppleFoundationModelsModule.swift` imports `ExpoModulesCore`, subclasses `Module`, uses
`AsyncFunction`, `Record`, `@Field` property wrappers. Not an old-bridge module.

**Availability — the plan's stated reason for including this project, and it does not
hold up as described.** `getTextModelAvailability()` maps exactly the three real
`SystemLanguageModel.Availability.UnavailableReason` cases (`deviceNotEligible`,
`appleIntelligenceNotEnabled`, `modelNotReady`) 1:1, plus a synthetic `"unsupported"`
added JS-side for pre-iOS-26/no-framework situations — but the Swift switch ends in a
bare `default: return "unknown"` rather than an exhaustive case list, so any future Apple
reason case (as expo-foundation-models's KNOWN_ISSUES documents happening across iOS
26→27) would silently collapse to `"unknown"` with no message and no `LocalizedError`
detail surfaced. It is a competent, correct thin mirror of Apple's current enum, not the
more elaborate diagnostic surface the plan's phrasing ("good availability reason-code
handling") implies — it's on par with, not ahead of, the other three projects on this
specific axis, and expo-foundation-models and henrypldev's project are both at least as
good.

**generate() / sessions:** Server-side cached sessions via a `TextSessionStore` actor
keyed by `sessionId` — a `LanguageModelSession(instructions:)` is created lazily and
reused if the `sessionId` and `instructions` match, else the session is rebuilt if
instructions changed. **No API to pass full message history at all** — only a single
`prompt` + one `instructions` string per call. Multi-turn behavior is only implicit,
via the native session's own accumulated transcript.

**Streaming: absent entirely.** No `stream`/`Stream` reference anywhere in `src/` or
`ios/` — only single-shot `respond(to:options:)`.

**Structured output: not using Apple's guided generation at all.** No
`DynamicGenerationSchema`/`GenerationSchema` usage (zero hits). It is pure prompt
engineering: builds a system-prompt instructing "return ONLY valid JSON... Schema:
\(schema)", then does best-effort JSON extraction plus `JSONSerialization` syntax
validation only — no semantic schema conformance is enforced by the framework. A
separate, unrelated, client-side-only recursive JSON-Schema-subset validator exists in
TypeScript (string/number/boolean/array/object with enum/min/max/required), applied only
after the fact.

**Tool calling: not implemented at all** — zero references to "tool" anywhere in the
codebase.

**Token counting: absent** — only a `maxOutputTokens` request cap is exposed, no
counting or estimation of responses.

**Prewarming: absent.**

**Locale support: absent** — zero locale references, no exposure of
`SystemLanguageModel` locale/language APIs. TaalTree's Dutch/French/German/Spanish
requirement would get no help from this project.

**Image input: claimed, not real.** The npm description says "text + image AI," but
this is aspirational — there is no image-related code in Swift or TypeScript; the one
`AppleFoundationModelsView.swift` file (38 lines) is a bare `WKWebView` wrapper unrelated
to FoundationModels multimodal input.

**iOS 26 vs 27:** Only `@available(iOS 26.0, *)` gating (11 occurrences); no iOS-27-
specific code, expected given the last-touched date pre-dates iOS 26 GA even.

**LOC / quality:** 589 lines in the main module + 38 in the unrelated WebView = 627 total
Swift. Assessment: **toy/proof-of-concept quality, not production-grade.** No streaming,
no tools, no token accounting, no locale, no real guided generation. The error handling
uses `Mirror`-based reflection to inspect `LanguageModelSession.GenerationError` with an
in-code comment admitting the reason: "Some SDK versions may type-erase... prefer
introspection and fallback to NSError heuristics" — i.e., the author could not get real
enum case matching working reliably and worked around it with reflection. The
error-code taxonomy is the best part of the project; everything else is thin or missing.

## 5. gregbarbosa/fm-proxy — quirks of `fm serve` (macOS 27 Chat Completions server)

MIT license, 68 stars, 1 open issue, actively maintained (pushed 2026-09-11). Not an RN
bridge — a Node.js reverse proxy in front of Apple's own `fm serve` CLI subcommand that
corrects its departures from the OpenAI Chat Completions spec. Extremely well-documented
(README + `AGENTS.md` + generated `docs/fm-reference.md`, ~1300 LOC of proxy code with an
explicit audit trail across betas). Bullet list of documented quirks, all live-verified
against macOS 27.0 RC (`26A428`, `fm` 2.0.68.1.402):

- **Licensing risk, not just a technical footnote.** macOS 27.0 Beta 5 added a legal
  notice (`FM1 version 1.0`) that must be accepted via `sudo fm license`. Its text: "YOU
  ARE ALSO AGREEING TO NOT PROGRAMMATICALLY ACCESS OR USE APPLE MODELS THROUGH APPLE
  SOFTWARE OR SERVICES EXCEPT AS EXPRESSLY PERMITTED." The fm-proxy author reads this as
  conflicting with what fm-proxy does and explicitly warns: don't ship it in a product or
  commercial deployment, use the FoundationModels framework in a signed app instead. This
  is squarely relevant to our plan: it's independent confirmation that `fm`/`fm serve` is
  a dev-loop tool only, never a shipping dependency — consistent with plan.md's use of
  `fm serve` for Node integration tests in Phase 1, never for the shipped `apple`
  provider.
- **No streaming envelope without an explicit flag.** A request that omits `stream`
  still gets back a `text/event-stream`, not a single JSON object — fm-proxy forces
  `stream:false` upstream when the client didn't ask to stream.
- **Tool calling: `tool_choice: "auto"` is broken upstream, forced choice works via a
  detour.** `fm serve` never populates `tool_calls`; the model puts the right call into
  `content` as raw JSON (e.g. `{"tool_call":[{"name":"get_weather","arguments":{...}}]}`)
  but the parser step that should lift it into `tool_calls` is simply missing.
  `finish_reason` stays `stop`. A **forced** `tool_choice` (`"required"` or naming a
  function) does work, but only because fm-proxy rewrites it into a `response_format`
  JSON-schema constrained-decoding call behind the scenes — `fm serve` itself rejects a
  forced `tool_choice` outright with `500 An unsupported generation guide was used.`
  Measured: 16/16 forced calls succeeded via the schema detour; 0/25 auto-mode calls
  picked a tool on their own.
- **Tool-call replies leak raw chat-template tokens into `content`.** Any request
  carrying `tools` has a good chance (7-9 of 10 in testing) of `content` containing raw
  markers like `<start_of_turn>` and `<ctrl46>` around the otherwise-correct tool-call
  JSON. Intermittent — some beta audits with small samples missed it. Opt-in
  `FM_STRIP_TEMPLATE_MARKERS=1` strips them; off by default so the proxy doesn't silently
  edit model output and so the markers remain a detectable signal of the upstream bug.
  Streaming-safe to strip because each marker is a single vocabulary token and never
  straddles a chunk boundary.
- **Recursive (self-referencing) `$defs` schemas hang `fm serve` permanently** — not
  just that request, every later request too, until the process is restarted (and the
  first request after a restart takes ~25s while the model reloads). fm-proxy detects
  self-reference and rejects with `400 cyclic_schema` before even opening the upstream
  connection, since there's no way to inline a truly recursive schema anyway.
- **`$defs`/`$ref` schemas need "Apple's dialect" or they 400.** fm-proxy resolves
  `$ref`s inline and strips `$defs` before forwarding. A titled string schema is
  rejected with 400 unless it carries a non-empty `enum`. A tool with no
  `function.description` fails the *whole request* with 400 — fm-proxy fills in an
  empty description to route around it.
- **Token usage only appears in streaming mode if explicitly requested.** Usage numbers
  are real (not estimated) but only sent when `stream_options.include_usage` is set;
  fm-proxy sets the flag upstream automatically and relays the real numbers back either
  way. Prompt token counts include full chat-template framing, not just raw text (e.g.
  `hello world` costs 57 `prompt_tokens` once framed).
- **Context window is 4096 tokens** on the audited build (4045 tokens passes, ~4255
  overflows) — this is the *older* on-device variant's window (see plan.md's 4K/8K
  split); confirms the plan's assumption that context budget management genuinely
  matters.
- **`n > 1` and forced `tool_choice` are permanent 400/500s, not transient** — fm-proxy
  explicitly does not retry these (versus rate limits and `LanguageModelError -1`
  hiccups, which it retries with exponential backoff), because retrying a deterministic
  failure for ~19.5s before surfacing it mislabeled as a rate limit is worse than
  failing fast.
- **Cross-site request headers get rejected as a CSRF-like guard** — a request carrying
  `Origin`, `Referer`, or `Sec-Fetch-*` gets a 403 from `fm serve` itself; fm-proxy
  strips that header family on the upstream hop so browser-based OpenAI clients work.
- **Private Cloud Compute (`pcc` model) was removed from the `fm` binary in Beta 7** and
  never came back in the 27.0 RC — not a license/account state change, a binary change.
  `fm respond -m pcc` now answers "Please provide one of 'system'"; `fm quota-usage` was
  deleted entirely. Any earlier notes describing PCC access through `fm` are stale.
- **`max_tokens` is ignored by `fm serve`** — fm-proxy truncates client-side to honor it.
- **`fm count-tokens`** exists as a real CLI subcommand using "the on-device system
  model's tokenizer," confirming token counting is at least available at the CLI layer
  (plan.md flags this as worth checking for the framework API itself, separately from
  the CLI).

## 6. 1duo/apple-fm-serve — quirks of an independent OpenAI-compatible server

Apache-2.0 license, 7 stars, 0 open issues, actively maintained (pushed 2026-09-15). A
from-scratch Swift 6 server (no third-party deps: stdlib + Foundation + FoundationModels
+ Network) built specifically to serve coding-agent harnesses (opencode, pi, codex)
rather than to be a general chat client target. Genuinely substantial: ~3,700 LOC of
Swift across 9 files (`ChatHandler.swift` 473, `HTTPServer.swift` 495, `OpenAITypes.swift`
545, `Provider.swift` 524, `ResponsesAPI.swift` 651, `ToolEmulation.swift` 459,
`GenerationSchema.swift` 239, `Prompt.swift` 188, `Config.swift`/`Errors.swift` ~120).
Documented quirks and design choices, independent corroboration of several fm-proxy
findings plus new ones:

- **Streaming is snapshots, confirmed independently.** The server's own comment:
  "snapshots are collected under the request timeout, then parsed once." Internally it
  collects a `[StreamSnapshot]` array from `active.streamGenerate(...)`, tracks
  `accumulated = snapshots.last?.text`, and computes **usage as snapshot deltas** for the
  OpenAI-style streaming response — i.e., they do the exact snapshot-to-delta conversion
  the plan anticipates needing, at the HTTP-serving layer rather than inside a JS bridge.
- **Structured output subset is explicitly documented and deliberately narrow.** Their
  `SchemaTranslator` doc comment: "Supported subset ... objects (nested, recursive-safe
  via `$defs`), arrays, primitives, string enums, `required`/`optional`, `description`,
  `#/$defs/` + `#/definitions/` `$ref`s, nullable `type` arrays. Anything else (e.g.
  `oneOf`, `not`, numeric ranges) throws and the caller falls back to a prompt hint."
  Non-string enums and null root/properties throw explicit `SchemaTranslationError`s.
  Truly recursive (self-referencing, not just nested-via-$defs) schemas are rejected as
  "unsupported" rather than hung, unlike raw `fm serve`. This is close to the exact
  documented-subset approach plan.md section 4 calls for and is a good reference
  implementation to compare our own JSON-Schema-to-`DynamicGenerationSchema` translator
  against.
- **`json_object` response format is rejected, matching Apple's own `fm serve`** — only
  `json_schema` guided generation is supported; `text` is the other option.
  **Streaming + `response_format` together is unsupported** and returns a typed error
  (`response_format_stream_unsupported`) rather than silently ignoring the schema.
- **Client-executed tool calling is emulated via a JSON envelope, not a native
  callback.** Because AFM's own native `Tool` protocol auto-executes *inside* the Swift
  process, but a coding harness needs to execute tools in its own process, the server
  asks the model (via prompt/instructions) to reply with a `{"content", "tool_calls"}`
  JSON envelope, parses it back into OpenAI `tool_calls`, and sets
  `finish_reason: tool_calls`. Malformed envelopes get a lenient recovery parser
  (accepts even unknown tool names, on the theory that harness-side error feedback will
  self-correct the loop on the next turn); if tools are `required` and the model just
  returned prose, it retries once with stricter instructions. Both paths log `WARN`
  lines. Small-model reality noted from live testing: "AFM 3 Core Advanced sometimes
  invents tool names or garbles argument JSON for codex's abstract tools." This is a
  materially different (and probably harder-won) protocol than a true bridge-level
  mid-generation tool call — worth reading before designing our own event/call-ID
  protocol, as a cautionary tale about how unreliable freeform tool-call emission can be
  even when the framework's *native* Tool protocol is being used elsewhere.
- **Real token usage from `session.usage`, with a heuristic fallback.** Confirms
  `session.usage` (prompt/completion tokens) is available on macOS 27 through the actual
  framework API (not just the `fm` CLI); falls back to `len/4` only when unavailable —
  same shape of estimator plan.md proposes (chars/3.5) for when native counting is
  absent.
- **Context window and model-tier detail:** "AFM 3 Core Advanced" (20B sparse MoE,
  1-4B active) auto-selected via `SystemLanguageModel.default` on M3+/12GB+ hardware,
  falling back to "AFM 3 Core" (3B dense) on other Apple Silicon, both via the same API
  — the app never explicitly picks a model tier. Context is 8192 tokens on macOS 27
  (matching plan.md's "8K on the newer model variant"). PCC access requires the
  `com.apple.developer.private-cloud-compute` **managed entitlement** — without it,
  requests fail with `ModelManagerError 1046`, a concrete error code worth mapping if we
  ever touch PCC.
- **Long agent loops genuinely overflow the 8K window** — noted from live opencode
  testing: full tool schemas alone can cost ~7K tokens before any transcript, so context
  overflow returns a proper 400 `context_length_exceeded` that the harness can react to.
  Concrete field validation of plan.md's concern that "the on-device window is small."
- **Stateless-by-design, same choice plan.md is making.** Explicit design note: "each
  request rebuilds AFM `instructions` ... and a single `prompt` carrying the full turn
  history ... No server-side session affinity." Independent validation that
  rebuild-per-request against `LanguageModelSession` is a workable, chosen pattern by
  another implementer targeting the same framework, not just a plan.md guess.
- **Sampling option mapping documented exactly**: `temperature` → `GenerationOptions.
  temperature`, `top_p` → `samplingMode.random(probabilityThreshold:)`, `max_tokens`/
  `max_completion_tokens` → `maximumResponseTokens`, `stop` via post-hoc truncation
  (framework has no native stop-sequence support), `tool_choice` → envelope forcing.
- **Image input is explicitly rejected** by this adapter ("Image content is not
  supported by this adapter") — a self-imposed limitation of this project, not
  necessarily a framework limitation (contrast with the `fm respond --image` CLI flag,
  which does support images).

---

## 7. Wrap vs. build: recommendation

### Summary comparison

| | callstack `@react-native-ai/apple` | expo-foundation-models | henrypldev/react-native-foundation-models | ratley |
|---|---|---|---|---|
| License | MIT | MIT | MIT | MIT |
| Last commit | 2026-07-07 | 2026-09-17 | 2026-08-11 | 2025-09-28 (abandoned) |
| Open issues | 13 | 0 | 0 | 0 |
| Native tech | TurboModule | Expo Modules API | Nitro | Expo Modules API |
| Message history in | No (transcript built, but caller can supply full history) | No (single prompt only, transcript-restore stubbed) | No (single prompt only) | No (single prompt only) |
| Streaming | Snapshots→deltas, but inconsistent between two code paths | Snapshots→deltas, consistent | Snapshots, **no diffing at all** | N/A (no streaming) |
| Structured output | Runtime `DynamicGenerationSchema`, good subset, some silent gaps | Runtime on iOS 27 + prompt fallback on iOS 26, documented gaps | Not used for generation, only for tool I/O | Prompt-engineering only, no real guided generation |
| Tool calling | JSI global-lookup, no timeout, no cancellation of in-flight call | Prompt-simulated two-turn, no true pause/resume, no timeout | Async/await Nitro promise, no timeout, no cancellation, but non-lossy schema (post OSS-9) | Not implemented |
| Token counting | Native (iOS 26.4+) | Estimated (`/4` heuristic) | Native (iOS 26.4+) | Absent |
| Prewarming | No (chat path) | Yes (uncertain implementation) | No | No |
| Locale | Minimal (device locale only) | Yes (rich) | No | No |
| Availability reasons | Boolean only, no reasons | Rich (diagnostics + suggestions) | Good (3 real reasons + unknown payload) | Adequate (3 real reasons, but non-exhaustive switch) |

### Answer: build our own, do not wrap any of these

None of the four is solid enough to be the base of a thin TypeScript adapter, for
reasons specific to what our plan actually needs, not in the abstract:

1. **The core architectural mismatch is universal, not a detail.** Every one of the four
   bridges either takes a single `prompt` string per call (expo-foundation-models,
   henrypldev, ratley) or builds its own internal `Transcript` object that the caller
   doesn't control turn-by-turn (callstack). None expose "hand me the full message array,
   I hand you back a response" as their actual public contract — the callstack package
   comes closest (it does map a real message array into a `Transcript`), but even there
   the message-array handling is bespoke to its own AI-SDK-shaped call, not something a
   thin adapter could reuse without largely reimplementing our request/response
   marshaling anyway. Since our plan's single most load-bearing design decision is "the
   provider interface is stateless and message-based," and three of four packages
   actively fight that model with server-held sessions (ratley's `TextSessionStore`,
   henrypldev's factory-cached session with auto-summarization, expo-foundation-models'
   stubbed transcript restore), wrapping any of them means either fighting their session
   model on every call or forking them — at which point we're maintaining Swift anyway,
   just someone else's Swift, with none of the design control our plan calls for (delta
   streaming, a documented JSON-Schema subset, a real tool-call event/call-ID/timeout
   protocol, availability reason codes as a first-class taxonomy).
2. **Streaming delta conversion is inconsistent or entirely absent.** Only
   expo-foundation-models does it correctly and consistently. callstack does it in one of
   two streaming code paths and not the other (a live bug we'd inherit). henrypldev does
   no diffing at all — every consumer of that library gets cumulative snapshots and has
   to write the exact conversion logic our plan puts inside the Apple provider. Wrapping
   any of these still leaves us writing the delta-conversion layer ourselves in
   TypeScript, at which point the "thin adapter" isn't thin.
3. **Tool calling has an unaddressed timeout/cancellation gap in every single project.**
   This is the plan's hardest problem ("Handle timeouts, handler exceptions, and
   cancellation arriving while a tool call is in flight"), and all four either don't
   implement tool calling (ratley), implement it as prompt simulation with no real
   pause/resume (expo-foundation-models), or implement a real bridge but with zero
   timeout and no cancellation of an in-flight call (callstack's JSI approach,
   henrypldev's Nitro async/await approach). There is no reference implementation among
   these four to wrap that already solves the problem our plan considers hardest; we
   would be writing this logic in Swift regardless of which package we sit on top of, and
   sitting on top of someone else's native module while patching in our own tool-call
   protocol is a worse position than owning the whole surface.
4. **Structured output quality varies from good-with-gaps to absent to actively wrong
   until three weeks ago.** callstack's schema converter is the most complete but has
   silent gaps (`oneOf`/`allOf`/`$ref`/format constraints); expo-foundation-models has a
   real dual iOS-26/27 path but the plan's preferred behavior ("reject anything else with
   a clear `invalidRequest` error rather than silently dropping constraints") is violated
   — unsupported constructs silently fall back to a less-safe prompt-based path instead of
   erroring; henrypldev doesn't use guided generation for top-level output at all; ratley
   has no real guided generation. henrypldev's **tool**-argument schema builder (post
   OSS-9) is the one piece of code in this survey worth reading closely and possibly
   adapting the *approach* from (not the code, given the Nitro-vs-Expo-Modules mismatch)
   — it's the only implementation in the survey that was shipped wrong once, got caught,
   and was rewritten with an explicit whitelist-and-reject-loudly design instead of
   coerce-and-hope. That's exactly the posture our plan wants for the JSON-Schema-to-
   `DynamicGenerationSchema` translator.
5. **Maintenance risk is real for three of the four.** Only callstack's monorepo has the
   organizational backing (Callstack, an actual company) to be confident about beyond a
   single maintainer's attention span; even so it has 13 open issues and a package that
   hasn't seen the full iOS 27 treatment (no PCC, no image input, no context options —
   the plan's iOS 27 checklist). expo-foundation-models is excellent but is a single
   author's very new project (3 stars) with the honesty to admit its own workarounds are
   workarounds — a good peer to watch, not a dependency to bet a shipped package on.
   henrypldev's project is small (7 stars) but shows the best engineering process; still
   single-repo, single-visible-commit risk from our shallow clone's vantage point. ratley
   is confirmed abandoned. A peer dependency on any of the non-callstack three risks
   going stale exactly when an OS release (the plan's own top concern — "treat every API
   name in this document as a lead to verify") requires a fix we can't make ourselves
   without forking.
6. **License compatibility is not the blocker.** All four are MIT, cleanly compatible
   with our MIT package as a peer dependency or for borrowing ideas (with attribution
   where we lift a documented technique, per the plan's instruction to check licenses
   before borrowing anything beyond ideas). This is the one dimension where wrapping
   would have been unproblematic — it just isn't the deciding factor given points 1-5.

**What we should still take from this survey, concretely, going into Phase 0/3:**

- Confirm the API surface directly against the installed SDK (per plan.md's Phase 0
  step) rather than trusting any one project's version-gating — expo-foundation-models'
  KNOWN_ISSUES #4 (`SystemLanguageModel.variant` documented but absent from the shipped
  iOS 27 SDK) is a concrete instance of the plan's own warning that Apple's docs and
  shipped SDK can diverge.
- Build the JSON-Schema→`DynamicGenerationSchema` translator with an explicit
  keyword whitelist that throws with a named property path on anything unsupported —
  modeled on henrypldev's post-OSS-9 `ToolSchemaBuilder`, not on callstack's
  silently-partial coverage or expo-foundation-models' silent-fallback behavior.
- Design the tool-call bridge with an explicit timeout and a cancellation path from day
  one — this is the one place all four prior projects fall short, so it's also the place
  where getting it right is most differentiating.
- Treat the generation-error enum itself as unstable across OS versions (per
  expo-foundation-models' documented `GenerationError`→new-error-types migration on iOS
  27) and build our error-taxonomy mapping layer to be resilient to that from the start,
  the way our plan's normalized-error taxonomy already intends.
- fm-proxy and apple-fm-serve both independently confirm snapshot-based streaming and
  the value of rebuild-per-request as a workable pattern — useful corroboration that
  plan.md section 4's technical bets are sound, even though neither is RN-relevant code
  we'd reuse directly.

**Bottom line:** the maintainer's default instruction to build a native module stands,
confirmed rather than merely assumed. Nothing in this survey changes that default — if
anything, the survey raises the bar for what "done" needs to look like (delta streaming
done consistently, a documented and enforced JSON-Schema subset, a tool-call protocol
with real timeout/cancellation, an availability taxonomy with no silent `default: return
"unknown"`), since every existing project falls short of at least one of these in ways
that would show up quickly in TaalTree's actual usage.
