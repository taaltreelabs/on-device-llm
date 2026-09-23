# ML Kit GenAI Prompt API surface — read from the shipping AARs

**Date:** 2026-09-23
**Mandate:** docs/plan.md §9 — "begin with the same reconnaissance step as Phase 0: establish the current API surface, device eligibility, and context limits before designing anything."
**Method:** direct inspection of the artifacts published to Google's Maven (`dl.google.com/android/maven2`) — `unzip` + `javap` over `classes.jar` — cross-checked against the live developer documentation. Where the artifact and the docs disagree, **the artifact wins** and the disagreement is flagged.

**Scope note:** this is reconnaissance only. No provider code was written, and nothing outside this file and the scratchpad was touched.

---

## 0. Provenance

| Item | Value |
|---|---|
| `com.google.mlkit:genai-prompt` | **1.0.0-beta4** — `maven-metadata.xml` `lastUpdated 20260721184558` (2026-07-21) |
| Published versions | `1.0.0-alpha1`, `beta1`, `beta2`, `beta3`, `beta4` — **no GA** |
| `com.google.mlkit:genai-common` | 1.0.0-beta4 (`lastUpdated 20260713132714`) |
| `com.google.mlkit:genai-schema` | **1.0.0-alpha1** (only version; `lastUpdated 20260713132714`) |
| AAR sizes | genai-prompt 1,104,796 B · genai-common 63,641 B · genai-schema (jar) 46,552 B |
| Class-file provenance string | `Compiled from "com.google.mlkit:genai-prompt@@1.0.0-beta4"` |
| Disassembler | `javap` 17.0.20.1 (`/opt/homebrew/opt/openjdk@17/.../bin/javap`) |
| `minSdkVersion` | **26**, from `genai-prompt` `AndroidManifest.xml` (`targetSdkVersion 35`) |
| Manifest permission | `com.google.android.apps.aicore.service.BIND_SERVICE` |
| Manifest `<queries>` | `<package android:name="com.google.android.aicore" />` |
| Declared licence | `ML Kit Terms of Service` — https://developers.google.com/ml-kit/terms |

Artifacts fetched and unpacked under the session scratchpad; every signature below is reproducible with
`javap -cp classes.jar com.google.mlkit.genai.prompt.<Class>`.

Canonical doc root is **https://developers.google.com/ml-kit/genai/prompt/android** (the `…/prompt-api/android` path named in the mandate is not a live page — it falls through to the ML Kit homepage).

---

## 1. Prompt API status and shape

### Status

**Beta, not GA.** The API page states verbatim: *"The API is in beta and is not subject to any SLA or deprecation policy. Changes may be made to this API that break backward compatibility."* (https://developers.google.com/ml-kit/genai/prompt/android). The Maven record agrees — five prereleases, no `1.0.0`. Two sub-features sit at different maturities: **system instructions = beta**, **structured output = alpha** (`genai-schema:1.0.0-alpha1`).

`minSdk` is **26** in the manifest, but that is only the compile floor; real usability is gated at runtime by AICore device eligibility (§6).

### The entry point

```java
public final class com.google.mlkit.genai.prompt.Generation {
  public static final Generation INSTANCE;
  public final GenerativeModel getClient();
  public final GenerativeModel getClient(GenerationConfig);
}
```

`GenerationConfig` carries only `workerExecutor: ExecutorService` and `modelConfig: ModelConfig`; `ModelConfig` carries two ints:

```java
public interface ModelPreference   { int FAST; int FULL; }
public interface ModelReleaseStage { int STABLE; int PREVIEW; }
```

**Doc-vs-artifact conflict resolved:** Google's Gemma 4 blog sample uses `ModelConfig.releaseTrack` / `ModelReleaseTrack`. The shipping artifact has **`getReleaseStage()` / `ModelReleaseStage`**. The blog is wrong (or describes an unreleased build). Use `releaseStage`.

### The full `GenerativeModel` interface (verbatim, `zz*` internals elided)

```java
public interface com.google.mlkit.genai.prompt.GenerativeModel {
  Caches getCaches();
  Object getBaseModelName(Continuation<? super String>);
  Object checkStatus(Continuation<? super Integer>);
  Object isCachingFeatureAvailable(Continuation<? super Boolean>);
  Object isStructuredOutputFeatureAvailable(Continuation<? super Boolean>);
  Object isSystemPromptAvailable(Continuation<? super Boolean>);
  Object isThinkingModeAvailable(Continuation<? super Boolean>);
  Flow<DownloadStatus> download();
  Object warmup(Continuation<? super Unit>);
  Object countTokens(GenerateContentRequest, Continuation<? super CountTokensResponse>);
  <T> Object countTokens(GenerateTypedContentRequest<T>, Continuation<? super CountTokensResponse>);
  Object getTokenLimit(Continuation<? super Integer>);
  Object generateContent(GenerateContentRequest, Continuation<? super GenerateContentResponse>);
  Object generateContent(GenerateContentRequest, StreamingCallback, Continuation<? super GenerateContentResponse>);
  Flow<GenerateContentResponse> generateContentStream(GenerateContentRequest);
  <T> Object generateContent(GenerateTypedContentRequest<T>, Continuation<? super GenerateTypedContentResponse<T>>);
  Object clearImplicitCaches(Continuation<? super Unit>);
  void close();
}
```

A `GenerativeModelFutures` facade mirrors the same calls as `ListenableFuture`s for Java callers.

**This is a much larger surface than §9 assumed.** `countTokens`, `getTokenLimit`, `warmup`, and per-feature capability probes all exist and map almost one-for-one onto methods our contract already has.

### Message list or single prompt? (the D2-equivalent question)

**A list — but an unroled one.** This is the single most important structural finding.

```java
public final class GenerateContentRequest {
  public final List<Content> getContents();
  public final SystemInstruction getSystemInstruction();
  public final float getTemperature();
  public final int getSeed();
  public final int getTopK();
  public final int getCandidateCount();
  public final int getMaxOutputTokens();
  public final PromptPrefix getPromptPrefix();
  public final String getCachedContextName();
  public final boolean getEnableThinking();
}
```

and the builder takes a list:

```java
public GenerateContentRequest$Builder(java.util.List<Content>);
public GenerateContentRequest$Builder(Content);
public GenerateContentRequest$Builder(TextPart);
public GenerateContentRequest$Builder(SystemInstruction, TextPart);
public GenerateContentRequest$Builder(SystemInstruction, ImagePart, TextPart);
```

But `Content` itself is only a bag of parts:

```java
public final class Content {
  public final List<Part> getParts();   // private field `zza` is the ONLY field
}
public abstract class Part {}
public final class TextPart  extends Part { String getTextString(); }
public final class ImagePart extends Part { Bitmap getBitmap(); int getWidth(); int getHeight(); }
public final class SystemInstruction extends Part { String getTextString(); }
```

`javap -p` on `Content` shows exactly one private field (`java.util.List zza`). **There is no role.** A grep of the constant pool of all 1,473 classes in `genai-prompt` finds **zero occurrences of the strings `role`, `user`, `model`, or `assistant`** — the concept does not exist anywhere in the artifact.

Consequences for us:
- Multi-turn history is expressible only as positional `List<Content>`; there is no documented or discoverable contract for how the runtime attributes turns. The docs never even show the `List<Content>` builder — every published sample is single-turn (`GenerateContentRequest.Builder(TextPart(promptText))`).
- Our `Message[]` → `List<Content>` conversion therefore has to **invent** the role encoding (prefixing `"User: "` / `"Assistant: "` into the text, most likely), and that encoding is unverifiable without a device. This is strictly worse than Apple's `Transcript`, which has typed entries.

**System instructions:** supported, gated. `SystemInstruction` is a first-class request field, and `isSystemPromptAvailable()` reports whether the resident model honours it. Docs recommend keeping it **under ~150 words**.

**Sampling options:** `temperature: Float`, `seed: Int`, `topK: Int`, `candidateCount: Int`, `maxOutputTokens: Int`. **There is no `topP`** — confirmed by absence from both `GenerateContentRequest` and `GenerateContentRequest$Builder`. `candidateCount > 1` is documented as incompatible with streaming (throws `IllegalArgumentException`).

**Bonus surface we did not expect:** `ImagePart` (vision, from `Bitmap`/`Uri`/`byte[]`), `enableThinking` + `GenerateContentResponse.getThoughtProcess()`, and an explicit prefix-cache API (`Caches.create/get/list/delete`, `PromptPrefix`, `cachedContextName`).

---

## 2. Streaming

**Yes, and it streams true deltas — the opposite of Apple.**

Two shapes:

```java
// callback
public interface com.google.mlkit.genai.common.StreamingCallback {
  void onNewText(String);
  default void onNewThought(String);
}
// Flow
Flow<GenerateContentResponse> generateContentStream(GenerateContentRequest);
```

### Deltas or snapshots — decided from the bytecode

The internal adapter `com.google.android.gms.internal.mlkit_genai_prompt.zzyp` implements `StreamingCallback`. Its `onNewText(String)` body:

```
10: checkcast     kotlinx/coroutines/channels/SendChannel
15: invokestatic  Candidate$Companion.zza:(Ljava/lang/String;Ljava/lang/Integer;)LCandidate;
24: invokestatic  kotlinx/coroutines/channels/ChannelsKt.trySendBlocking:(…)
```

The incoming `String` is wrapped directly into a fresh `Candidate` and pushed to the channel. **There is no `StringBuilder`, no `append`, and no accumulator field anywhere in the method.** So each `GenerateContentResponse` emitted by `generateContentStream` carries only the newly generated chunk.

This is genuinely good news: **DECISIONS.md D5 exists because Apple's `ResponseStream` yields cumulative snapshots that the Apple provider must diff. Android needs no such conversion** — `onNewText` maps straight to our `textDelta`.

### Cancellation

Idiomatic coroutine cancellation. `generateContentStream` returns a `Flow` built over a `Channel` (`trySendBlocking` above implies `callbackFlow`), so collecting inside a cancellable scope and cancelling the job tears the stream down. `GenAiException.ErrorCode.CANCELLED` exists, so the native layer reports cancellation as a first-class code rather than a silent stop. `GenerativeModel.close()` is the explicit resource release for the client itself (separate from per-request cancellation).

**Unverified:** whether cancelling the coroutine actually stops AICore inference or merely stops delivery. Our contract (`RequestOptions.signal`, "must stop real work") requires the former. **Device test required.**

---

## 3. Structured output, tool calling, token counting

### Structured output — present in the SDK, **not usable from our bridge**

The typed path exists:

```java
public final class GenerateTypedContentRequest<T> {
  public final GenerateContentRequest getGenerateContentRequest();
  public final kotlin.reflect.KClass<T> getOutputClass();
  public final boolean getIncludeSchemaInPrompt();
}
```

`genai-schema:1.0.0-alpha1` is annotation-driven:

```java
public interface annotations.Generable { String description(); }
public interface annotations.Guide {
  String description(); int maxItems(); int minItems();
  double maximum(); double minimum(); String[] enumValues();
}
public final class guided.GenerableDetail$GuideDetail {
  String getName(); kotlin.reflect.KClass<?> getType(); boolean getNullable();
  … boolean isList(); kotlin.reflect.KClass<?> getListItemType();
}
```

Every route to a schema terminates in a **`KClass`** — a compile-time Kotlin class — and the documented flow requires a KSP compiler plugin (`ksp("com.google.mlkit:genai-schema-compiler:1.0.0-alpha1")`) to generate the `GenerableProvider`.

Our contract takes `GenerateRequest.schema` as a **runtime JSON Schema handed across the bridge from JavaScript**. There is no Kotlin class to point `outputClass` at, and no public API accepts a schema document. Unless we generated classes at build time — impossible for a library whose consumers define their schemas in JS — **structured output is unreachable**.

**And it would be weak even if reachable.** The bytecode of `…mlkit_genai_prompt.zzys` shows how it is implemented: the schema is appended to the system instruction as *text*:

```
"\nContext:\nDo NOT generate unsafe content.\nIf contents are safe, you MUST output ONLY in the
 following JSON schema without any spaces or newlines:\n"
```

This is **prompt injection plus a JSON parse**, not constrained decoding — which is exactly why `STRUCTURED_OUTPUT_RESPONSE_ERROR` and `STRUCTURED_OUTPUT_MAX_TOKENS_ERROR` are distinct error codes. `GuideDetail` is also flat (a `KClass` type plus an optional list item type), so nested-object schemas look unsupported.

→ **`capabilities().structuredOutput = false`.** Confirmed.

### Tool calling — absent

No `Tool`, `FunctionDeclaration`, `FunctionCall`, or `FunctionResponse` type exists anywhere in `genai-prompt` or `genai-common`. The complete public class list is 40 types, enumerated in §1 and §5; none relate to tools.

→ **`capabilities().tools = false`.** Confirmed.

### Token counting — **exact, and better than expected**

```java
Object countTokens(GenerateContentRequest, Continuation<? super CountTokensResponse>);
public final class CountTokensResponse { public final int getTotalTokens(); }
Object getTokenLimit(Continuation<? super Integer>);
```

`countTokens` takes a **whole request**, not a string — the same design choice our `countTokens(messages)` made, and for the same reason (per-message framing overhead is the provider's business). The reference doc confirms it counts **input only**, and that `countTokens(request) + maxOutputTokens` must not exceed `getTokenLimit()`.

→ **`capabilities().tokenCounting = 'exact'`** — matching Apple. Note the caveat: the count is only as honest as our invented role encoding (§1), since we count the request we actually built.

---

## 4. Context window

**Discoverable at runtime**, which is better than the docs alone suggest: `getTokenLimit(): Int`.

| Source | Figure |
|---|---|
| `GenerativeModel.getTokenLimit()` | authoritative, per-device, runtime |
| Get Started doc | input *"approximately 3,000 English words"*; output *"under 4,000 tokens"* |
| Reference doc | *"The input size returned by countTokens plus the output size specified by `GenerateContentRequest.maxOutputTokens` should be no larger than the limit returned by this method."* |

**The budget is combined input+output** — the same semantics as Apple's `contextSize`, so the Phase 2 formula (`window − reservedForOutput − safetyMargin`) transfers unchanged.

**Not found:** any documented per-variant window split. The "4K vs 8K by nano variant" framing in the mandate is **not corroborated by any Google source**; the docs give one uniform ~4,096-token ceiling. The artifact does, however, carry a regex `nano-v(\d+)` (in `…mlkit_genai_prompt.zzzy`) used together with `getBaseModelName()` to gate features by model version — so per-variant behaviour is real, it is simply not documented as a window figure. Treat `getTokenLimit()` as the only trustworthy number and run it through `normalizeContextWindow` (D9).

**Locales:** there is **no enumeration API**. `genai-common` contains `internal.SapiLanguage`, but `javap` shows it is an **empty marker annotation** with no members. → **`capabilities().locales = UNKNOWN`**, and per D7 locale failures can only be discovered at generation time. This is a real regression against Apple's 24 enumerated tags, and it means D30's `unsupportedLocale` fallback trigger can never fire on Android — there is no code for it either (§5).

---

## 5. Availability model and the mapping onto our taxonomy

### The states

```java
public interface com.google.mlkit.genai.common.FeatureStatus {
  int UNAVAILABLE; int DOWNLOADABLE; int DOWNLOADING; int AVAILABLE;
}
Object checkStatus(Continuation<? super Integer>);       // returns one of the four
Flow<DownloadStatus> download();                          // triggers + observes
```

```java
public abstract class DownloadStatus {}
DownloadStatus$DownloadStarted   { long getBytesToDownload(); }
DownloadStatus$DownloadProgress  { long getTotalBytesDownloaded(); }
DownloadStatus$DownloadCompleted { INSTANCE }
DownloadStatus$DownloadFailed    { GenAiException getE(); }
```

Note `checkStatus()` returns a bare `Int`, not an enum — an unrecognised future value is possible and must not crash us.

### Mapping onto `UnavailableReason`

| Android signal | Our `Availability` | Notes |
|---|---|---|
| `FeatureStatus.AVAILABLE` | `{ available: true }` | D9 still applies — see §7 |
| `FeatureStatus.DOWNLOADING` | `{ available: false, reason: 'modelNotReady' }` | `detail` from `DownloadProgress` |
| `FeatureStatus.DOWNLOADABLE` | `{ available: false, reason: 'modelNotReady' }` | eligible, assets absent; `download()` is the remedy |
| `FeatureStatus.UNAVAILABLE` | `{ available: false, reason: 'deviceNotEligible' }` | AICore allowlist says no |
| `com.google.android.aicore` package absent | `{ available: false, reason: 'unsupportedPlatform' }` | resolvable via the `<queries>` entry without calling the SDK |
| `Build.VERSION.SDK_INT < 26` | `{ available: false, reason: 'unsupportedPlatform' }` | manifest floor |
| `ErrorCode.AICORE_INCOMPATIBLE` | `{ available: false, reason: 'deviceNotEligible' }` | |
| `ErrorCode.NEEDS_SYSTEM_UPDATE` | `{ available: false, reason: 'unsupportedPlatform' }` | `detail` should say "system update required" |
| `ErrorCode.NOT_ENOUGH_DISK_SPACE` | `{ available: false, reason: 'modelNotReady' }` | transient in the useful sense — user can free space |

**`notEnabled` has no Android analogue.** It exists because Apple has a user-facing Apple Intelligence toggle; AICore has no equivalent opt-in. The reason stays in the union (it is Apple's), and the Android provider simply never returns it. Worth one sentence in the provider's docblock so nobody "fixes" the apparent omission.

**A four-state model maps cleanly onto our three usable reasons.** No new `UnavailableReason` is needed — a genuinely good result for a taxonomy designed against Apple.

### The error codes

`GenAiException` is the one exception type, and it is richer than Apple's:

```java
public class GenAiException extends Exception {
  public int getErrorCode();
  public java.time.Duration getRetryDelay();   // ← note this
}
```

21 codes, verbatim from the artifact, mapped:

| `GenAiException.ErrorCode` | `LLMError` | D30 fallback | Transient |
|---|---|---|---|
| `CANCELLED` | `cancelled` | never | — |
| `REQUEST_TOO_LARGE` | `contextOverflow` | **on** | — |
| `NOT_AVAILABLE` | `unavailable` (`modelNotReady`) | **on** | — |
| `AICORE_INCOMPATIBLE` | `unavailable` (`deviceNotEligible`) | **on** | — |
| `NEEDS_SYSTEM_UPDATE` | `unavailable` (`unsupportedPlatform`) | **on** | — |
| `NOT_ENOUGH_DISK_SPACE` | `unavailable` (`modelNotReady`) | **on** | — |
| `BUSY` | `rateLimited` (`resetDate` ← `getRetryDelay()`) | **on** | — |
| `PER_APP_BATTERY_USE_QUOTA_EXCEEDED` | `rateLimited` (`resetDate` ← `getRetryDelay()`) | **on** | — |
| `BACKGROUND_USE_BLOCKED` | `unknown` | **on** | `true` |
| `REQUEST_TOO_SMALL` | `invalidRequest` | never | — |
| `NOT_SUPPORTED` | `invalidRequest` | never | — |
| `INVALID_INPUT_IMAGE` | `invalidRequest` | never | — |
| `STRUCTURED_OUTPUT_REQUEST_ERROR` | `invalidRequest` | never | — |
| `STRUCTURED_OUTPUT_RESPONSE_ERROR` | `unknown` | **on** | `true` |
| `STRUCTURED_OUTPUT_MAX_TOKENS_ERROR` | `contextOverflow` | **on** | — |
| `REQUEST_PROCESSING_ERROR` | `unknown` | **on** | `true` |
| `RESPONSE_PROCESSING_ERROR` | `unknown` | **on** | `true` |
| `RESPONSE_GENERATION_ERROR` | `unknown` | **on** | `true` |
| `CACHE_PROCESSING_ERROR` | `unknown` | **on** | `true` |
| `UNKNOWN` | `unknown` | off | `undefined` |
| `AUDIO_BUFFER_OVERFLOW` | n/a | — | — |

**`getRetryDelay(): Duration` is a gift.** Apple's `RateLimited.resetDate` has a direct Android counterpart, so `RateLimitedErrorDetails.resetDate` is populatable on both platforms.

**There is no `guardrail` code.** Safety appears to be handled as prompt text (the injected *"Do NOT generate unsafe content"* string in `zzys`) rather than as a typed refusal, so a blocked response most likely arrives as ordinary text or as `RESPONSE_GENERATION_ERROR`. **We cannot reliably raise `guardrail` on Android**, which means D30's deliberate "guardrail does not fall through by default" policy is unenforceable there — a safety-relevant asymmetry worth recording.

---

## 6. Device eligibility and the emulator question

### Eligibility is an allowlist, not a spec

The canonical list is the `#prompt-device` anchor on https://developers.google.com/ml-kit/genai, organised by Gemini Nano version (as of 2026-09):

- **nano-v2** — Honor Magic V5/7/7 Pro; iQOO 13; Motorola Razr 60 Ultra / Razr Ultra 2025; OnePlus 13/13s; OPPO Find N5; POCO F7 Ultra, F8 Pro/Ultra, X7 Pro, X8 Pro; realme GT 7 Pro; Samsung Galaxy Z Fold7, Z TriFold; vivo X200 FE, T4 Ultra; Xiaomi 14T Pro, 15, 15T(/Pro), 15 Ultra, 17(/Ultra), Pad Mini.
- **nano-v3** — Pixel 9 and 10 families (incl. Pro/Pro XL/Pro Fold); Honor Magic 8 Pro; iQOO 15; Lenovo Idea Tab Pro Gen 2, Legion Tab Gen 5; Motorola Signature; OnePlus 15/15R; OPPO Find X8/X9 (+Pro), Reno 14/15 Pro series; realme GT 7T; **Samsung Galaxy S26/S26+/S26 Ultra**; Sharp AQUOS R11; Sony Xperia 1 VIII; vivo X200(/T/Pro), X300(/Pro).
- **nano-v4** — Pixel 11 family; Samsung Galaxy Z Flip8, Z Fold8, Z Fold8 Ultra.

Two things this list teaches:

1. **Reach is far wider than "Pixel only."** Flagship Samsung, Xiaomi, OPPO, OnePlus, vivo, Honor and Motorola devices are all covered. The mandate's "Pixel 8+? 10-only?" framing is out of date — **Pixel 8 is absent entirely**, and the floor is Pixel 9.
2. **It is an allowlist.** `googlesamples/mlkit#944` reports a 12 GB-RAM OnePlus 12 returning "Feature Unavailable" while apparently meeting every hardware bar, with no Google response. You cannot predict eligibility from specs; you must call `checkStatus()`. Devices with an **unlocked bootloader** are documented as unsupported.

A point-in-time caveat: the Aug 2025 Android Developers Blog put Pixel 9 Pro on nano-v2, while today's page has the whole Pixel 9 family on nano-v3. Variants move under devices via OTA. **Never cache a variant assumption; read `getBaseModelName()`.**

### Emulator: **no. Definitively.**

This is the finding that governs the whole dev/CI loop, so the evidence is laid out in full:

- No Google source anywhere claims emulator/AVD support for AICore, Gemini Nano, or ML Kit GenAI, at any API level or system-image flavour.
- The AICore Developer Preview announcement (2026-04-02) offers, as the fallback for non-AICore devices, *"a CPU implementation that is not representative of final production performance"* and the **AI Edge Gallery app** — i.e. still a **physical device**, never an emulator. (https://android-developers.googleblog.com/2026/04/AI-Core-Developer-Preview.html)
- A Google AI Developer Forum thread asking precisely this question ("Is there any official emulator/simulator workflow for Gemini Nano / AICore Prompt API testing on Android?") stands **unanswered by Google**. (https://discuss.ai.google.dev/t/…/147148)
- Google's own sibling stack states it outright: MediaPipe LLM Inference *"does not reliably support device emulators."*
- The AAR's own manifest is consistent with this: it declares `<queries><package android:name="com.google.android.aicore" /></queries>` and requests `com.google.android.apps.aicore.service.BIND_SERVICE`. **AICore is a preinstalled system service.** It is not on any public AVD system image, and it is not installable from Play, so there is nothing for the SDK to bind to on an emulator.

**Consequence:** there is **no CI path and no laptop-only dev loop**. Every behavioural question in this document marked "unverified" — the role encoding, real cancellation, streaming granularity end-to-end, the actual `getTokenLimit()` value — requires **purchased, allowlisted hardware**. This is qualitatively worse than the Apple situation, where the development Mac itself runs the model and `fm serve` gives a local rig (D8).

---

## 7. Terms and licensing

From **https://developers.google.com/ml-kit/genai-terms** ("ML Kit GenAI API Additional Terms of Service") and the base https://developers.google.com/ml-kit/terms:

| Clause | Text | Impact on us |
|---|---|---|
| Documented-features-only | *"You will only use the Services to facilitate the features described in the ML Kit GenAI API documentation."* | The nearest thing to a "no raw model access" clause. A general-purpose prompt pass-through is arguably *within* the documented Prompt API, but an explicit "no raw access" clause was **not found**. |
| No competing models | *"You may not use the Services to develop models or products that compete with the Services (e.g., Gemini Nano or the ML Kit GenAI API)."* | A cross-platform *router* is plausibly adjacent to this. Low but non-zero risk; worth a maintainer read. |
| No reverse engineering | *"You may not attempt to reverse engineer, extract, or replicate any component of the Services, including the underlying data or models (e.g., parameter weights)."* | Fine — we call the public API. |
| Preview exclusion | *"You may not use any Services identified as 'Preview' or 'Experimental Access' … for production use."* | **`ModelReleaseStage.PREVIEW` must not be our default.** Default to `STABLE`. |
| Age gate | *"You must be 18 years of age or older to use the APIs, and you won't use the Services as part of a website, application, or other service directed towards or likely to be accessed by individuals under the age of 18."* | **Material for a public library.** TaalTree is a language-learning product; any under-18 audience puts a *consumer* in breach. This must be documented loudly, not buried. |
| Medical exclusion | *"You may not use the Services in clinical practice, to provide medical advice…"* | Document for consumers. |
| Telemetry | *"The ML Kit APIs also send metrics about the performance and utilization of the APIs in your app to Google"*; *"You are responsible for informing users of your app about Google's processing of ML Kit metrics data as required by applicable law."* | **The Apple provider sends nothing off-device; this one does.** Our marketing and README must not imply "on-device ⇒ no data leaves". The disclosure obligation passes through to every consumer. |
| Attribution | **Not found.** Only a CC BY 4.0 notice on the documentation, not the SDK. | No attribution burden identified. |
| **Redistribution / sublicensing** | **UNRESOLVED.** Google's standard mobile-SDK template contains *"You may not distribute any software … created using the SDK to any third party without Google's prior written authorization"*-style language, and `ml-kit/terms` is templated from that family, but this could **not** be verified verbatim on the live page in this pass. | **This is the one open legal question, and it is precisely the one that matters for a redistributable npm package.** Must be read by a human before any build decision is executed. |

---

## 8. Plan B: MediaPipe LLM Inference

`com.google.mediapipe:tasks-genai` (0.10.27 at time of writing) runs bring-your-own-weights models (Gemma 3 1B/2B as `.task`/`.litertlm`) on its own runtime rather than through AICore, so it is **not gated by Google's device allowlist** — the docs describe it as *"optimized for high-end Android devices, such as Pixel 8 and Samsung S23 or later"*, i.e. a performance floor rather than a permission list. That is its one real advantage. It does not, however, solve the problem that actually blocks us: the same docs state it *"does not reliably support device emulators"*, so there is still no CI path. Its costs are severe for our shape: weights **cannot be bundled in the APK** (*"The model is too large to be bundled in an APK"* — Google recommends runtime download from your own server, or `adb push` for development), which turns a library install into a model-hosting-and-distribution problem with its own licensing, bandwidth and storage burden; and it offers no token counting, no availability model, and no structured output to map onto our contract. **Viable as a *different* product, not as a drop-in second Android provider.** If the Prompt API's device allowlist proves too narrow to be useful, MediaPipe is the fallback to revisit — but it should be a separate, explicitly opt-in provider package, never the default.

---

## 9. Kotlin / Expo integration shape

**Expo Modules API maturity: adequate.** The repo already carries a dependency-free Android stub (`android/src/main/java/expo/modules/ondevicellm/OnDeviceLlmModule.kt`, `android/build.gradle` with only `com.android.library` + `expo-module-gradle-plugin`, and an empty `<manifest/>`). `expo-modules-core` supports `AsyncFunction` with Kotlin **coroutines** and `Events` + `sendEvent` for streaming, which is the exact pair this API needs — `suspend fun generateContent(...)` and `Flow.collect { sendEvent(...) }`. D17's wire shape (`generate` resolving `{ ok, result } | { ok, error }`, `startStream` reporting everything through `onStreamEvent`) transfers to Android unchanged, and the richer `GenAiException` payload (`getErrorCode()`, `getRetryDelay()`) survives it exactly as D17 intended.

**The dependency burden is real and it is the design constraint.** `genai-prompt:1.0.0-beta4` pulls, transitively and at `compile` scope:

```
com.google.android.gms:play-services-basement:18.9.0
com.google.android.gms:play-services-tasks:18.2.0
com.google.mlkit:common:18.11.0
com.google.mlkit:genai-common:1.0.0-beta4
com.google.mlkit:genai-schema:1.0.0-alpha1
com.google.android.datatransport:transport-api:2.2.1
com.google.android.datatransport:transport-backend-cct:2.3.3
com.google.android.datatransport:transport-runtime:2.2.6
com.google.firebase:firebase-encoders:16.1.0
com.google.firebase:firebase-encoders-json:17.1.0
com.google.guava:listenablefuture:1.0
org.jetbrains.kotlin:kotlin-stdlib:2.3.21
org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3 (+ -guava 1.5.0, -reactive 1.7.3)
```

That is **Play Services plus a Firebase datatransport telemetry pipeline** landing in the APK of anyone who installs our package — including an app that only ever uses the Apple provider but ships an Android build. Expo autolinking includes every `android/` module of every dependency unconditionally; there is no per-provider opt-out at the autolinking layer.

**Can the android module stay dependency-free until the provider lands? Today, yes — it already is.** When the provider lands, the options are, in order of preference:

1. **Consumer-supplied dependency.** Ship the Kotlin provider guarded by reflection or `compileOnly`, and require the app to add `implementation("com.google.mlkit:genai-prompt:…")` itself. Zero default burden; costs one documented install step.
2. **Gradle property opt-in.** `expo-module-gradle-plugin` supports reading `gradle.properties`; gate the dependency on e.g. `onDeviceLlm.enableAndroidProvider=true`.
3. **Separate package** (`@taaltreelabs/on-device-llm-android`) — cleanest isolation, but contradicts §9's stated appeal ("users get it with a version bump instead of a new install").

Option 1 or 2 keeps §9's single-package promise without taxing every consumer. **Option 3 becomes correct if the redistribution clause (§7) turns out to forbid shipping the SDK inside our artifact** — in which case the consumer-supplied shape is not merely preferable but mandatory, which is a second reason to resolve that clause first.

---

## 10. Gap analysis: our `LLMProvider` contract vs. the Prompt API

| Contract member | Android support | Gap |
|---|---|---|
| `id` | n/a | none |
| `availability()` | `checkStatus(): Int` → 4 states | **None — clean 4→3 mapping.** `notEnabled` unused. |
| `capabilities().contextWindow` | `getTokenLimit(): Int`, combined in+out | **None.** Same semantics as Apple. Run through `normalizeContextWindow`. |
| `capabilities().streaming` | `true` | **None — and better than Apple**: native deltas, no D5 diffing. |
| `capabilities().structuredOutput` | `false` | **Hard gap.** `KClass`-only + KSP codegen; a runtime JSON Schema cannot be expressed. §3. |
| `capabilities().tools` | `false` | **Hard gap.** No tool types exist at all. Phase 3 parity impossible. |
| `capabilities().tokenCounting` | `'exact'` | **None.** `countTokens(request)` matches our per-message design. |
| `capabilities().locales` | `UNKNOWN` | **Gap.** No enumeration API (`SapiLanguage` is an empty marker). D7's pre-check and D30's `unsupportedLocale` trigger are both inert on Android. |
| `capabilities().modelLabel` | `getBaseModelName(): String` (`"nano-v3"`) | **None.** Better than expected. |
| `countTokens(messages)` | `countTokens(GenerateContentRequest)` | Minor — accuracy inherits the role-encoding guess. |
| `prewarm(messages?)` | `warmup()`, plus `Caches`/`PromptPrefix` for prefix warming | **None — arguably richer than Apple.** `warmup()` takes no messages, but `Caches.create(...)` warms a prefix. |
| `generate(request)` | `generateContent(GenerateContentRequest)` | **Role gap** (below). |
| `stream(request)` | `generateContentStream(...): Flow` | **None**, modulo cancellation verification. |
| `RequestOptions.signal` | coroutine cancellation + `ErrorCode.CANCELLED` | **Unverified**: does cancelling stop AICore inference, or only delivery? Contract demands the former. |
| **`Message[]` → request** | `List<Content>`, **no role field** | **The worst gap.** §1. Multi-turn role attribution must be invented by us and is unverifiable without hardware. |
| Error taxonomy | 21 `GenAiException` codes | Maps well; `getRetryDelay()` → `resetDate` is a bonus. **No `guardrail` code** — that mapping is unachievable. |
| `LLMError` `cause` fidelity | `getErrorCode()` + message | **None.** D17's payload channel carries it. |

**Summary:** of 16 contract members, **10 map cleanly, 2 are hard gaps already expected to be `false` (structured output, tools), 1 is a soft gap (locales), 2 are unverifiable without hardware (cancellation, role encoding), and 1 — the message-list role gap — is a genuine design problem.**

---

## 11. D9-style risk register

D9 was learned the hard way on Apple: *availability said yes, generation said no.* Android's equivalents, with evidence:

1. **`AVAILABLE` then failure — documented in the wild.** AICore surfaces errors of the shape `AICore failed with error type <N>-<TYPE>`, e.g. `2-INFERENCE_ERROR` / `29-INTERNAL_ERROR: Inference failed` and `1-DOWNLOAD_ERROR` / `0-UNKNOWN: Feature is unavailable`. `googlesamples/mlkit#985` reports `Feature not available` / `"Feature 636 is not available"` crashes on **real, AICore-equipped Pixel hardware**. **D9's transient-unknown lane is not optional on Android; it is load-bearing from day one.**
2. **Models stuck downloading indefinitely, with nothing reported to the app** (XDA forums; GrapheneOS os-issue-tracker #6706). Our `modelNotReady` must therefore be treated as possibly-permanent: a `DOWNLOADING` state that never advances needs a timeout in the caller, not infinite patience.
3. **The SDK already retries internally, and admits it.** `…mlkit_genai_prompt.zzzy` contains the literal string `"Inference failed with prefix cache, retry without cache."` — Google's own code treats first-attempt inference failure as expected. If we adopt `Caches`/`PromptPrefix`, we inherit this failure mode.
4. **Beta with an explicit no-compatibility promise.** *"Changes may be made to this API that break backward compatibility."* Four betas shipped between 2026-01-28 and 2026-07-21 — roughly one every six weeks. Pinning is mandatory; a floating version range would be reckless.
5. **`checkStatus()` returns a bare `Int`.** A fifth state added in beta5 must degrade to a sane reason (`modelNotReady` with a `detail`, not a crash and not a silent `available`).
6. **Battery/background quotas are first-class failure modes** (`PER_APP_BATTERY_USE_QUOTA_EXCEEDED`, `BACKGROUND_USE_BLOCKED`) with **no iOS analogue**. A long chat session can be throttled by the OS mid-conversation. `getRetryDelay()` makes this survivable, but only if we wire it.
7. **No emulator ⇒ no regression safety net.** Every one of the above is undetectable in CI. A beta SDK that breaks compatibility every six weeks, on hardware we can only test manually, is the compounding risk in this document.
8. **Safety asymmetry.** With no `guardrail` code (§5), a refusal on Android most likely arrives as ordinary generated text. D30's "guardrail does not fall through by default" cannot be honoured, and an app relying on that policy would behave differently per platform.

---

## 12. Recommendation

### **Build when X — not now.**

The API is *far* better suited to our contract than §9 assumed. If the decision rested on API shape alone, the answer would be "build now": availability maps 4→3 with no new reason codes, token counting is **exact** and takes a request rather than a string, streaming is **native deltas** (no D5 diffing), `warmup()` matches `prewarm()`, and `getRetryDelay()` populates `resetDate`. That is a better fit than the OpenAI provider gets.

It is blocked by three facts, in order of weight:

**The three load-bearing facts**

1. **No emulator, at all — so there is no CI and no laptop dev loop.** AICore is a preinstalled system service; the AAR binds to `com.google.android.apps.aicore.service.BIND_SERVICE` and queries the `com.google.android.aicore` package, neither of which exists on any AVD image. Google has left the direct question unanswered on its own forum and points non-AICore users at physical devices. Combined with a beta SDK that ships breaking changes every ~6 weeks, this means **every regression is caught by hand, on purchased hardware, or not at all.** This is the fact that decides it.
2. **`Content` has no role field.** `GenerateContentRequest.contents` is a `List<Content>`, `Content` holds only `parts`, and the strings `role`/`user`/`model`/`assistant` appear **nowhere** in 1,473 classes. Our contract is stateless and message-based; Android gives us no way to express whose turn is whose except by inventing a text encoding — one we cannot validate without the hardware from fact 1.
3. **The redistribution clause is unresolved.** Whether we may ship `genai-prompt` inside a redistributable npm package is exactly the question a public library must answer before writing code, and it could not be settled from the live terms page in this pass.

Against these, the things people assume are blockers mostly are not: device reach is **much** wider than "Pixels" (Samsung S26, Xiaomi, OPPO, OnePlus, vivo, Honor, Motorola all on the list), and `structuredOutput: false` / `tools: false` are exactly what our `Capabilities` flags are designed to express.

### The gates — build when **all three** are true

- **G1 — Hardware.** At least one allowlisted device in hand (a Pixel 9/10/11 is the cheapest nano-v3/v4 route), accepted as a permanent manual-test obligation with no CI coverage.
- **G2 — Licence.** A human has read https://developers.google.com/ml-kit/terms and confirmed a redistributable wrapper is permitted — or the design has moved to the consumer-supplied-dependency shape (§9 option 1), which sidesteps it.
- **G3 — GA, or an accepted beta tax.** `genai-prompt` reaches `1.0.0` — or the maintainer explicitly accepts re-verifying against a breaking beta roughly every six weeks.

G1 is the expensive one and it does not get cheaper. G3 is the one most likely to resolve itself: four betas in eight months with a widening device list is a stack heading for GA.

### Phase plan, if the gates open

Deliberately front-loaded with the things hardware can answer, because hardware is the scarce resource.

- **A — Spike (1 device, ~2 days, throwaway).** A bare Kotlin activity, no Expo. Answer the four unverified questions: does `List<Content>` do anything useful without roles, and what encoding works; does coroutine cancellation stop inference or only delivery; is `generateContentStream` delta-per-emission end-to-end; what does `getTokenLimit()` actually return on this device. **Record the answers in DECISIONS.md — they are the Android equivalents of D2 and D5, and they cannot be guessed.**
- **B — Contract decisions.** Ratify: role encoding (the D2-equivalent); `structuredOutput: false` / `tools: false` / `tokenCounting: 'exact'` / `locales: UNKNOWN`; the `FeatureStatus` → `UnavailableReason` table (§5); the 21-code error table (§5); and that `guardrail` is unreachable, with the D30 consequence written down.
- **C — Dependency shape.** Implement §9 option 1 or 2 so the default consumer pays nothing. Verify with a clean Android build of an Apple-only example app that no Play-Services or Firebase-datatransport artifact appears.
- **D — Provider.** Kotlin module + TS wrapper on D17's existing wire shape. `availability`/`capabilities`/`countTokens`/`prewarm` first (all cheap, all mappable), then `generate`, then `stream`.
- **E — Test rig.** Whatever is testable off-device: the message→`Content` conversion, the error-code and status mapping tables, and the "root import must not throw on a device without AICore" case. Everything else is a documented manual checklist run per SDK bump.

Until G1–G3 open, the correct state for `android/` is exactly what it is today: **a dependency-free stub**, with the package reporting `unsupportedPlatform` on Android as the contract already requires.
