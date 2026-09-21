# Plan: open-source on-device LLM toolkit for React Native / Expo

Written September 2026. The Apple APIs described here are changing between OS releases, so treat every API name in this document as a lead to verify against the installed SDK, not as fact.

## 1. What we're building and why

An open-source, MIT-licensed package that lets a React Native or Expo app use Apple's on-device Foundation Model, with the surrounding machinery that every app ends up writing by hand.

There are already several packages that bridge `LanguageModelSession` to JavaScript (listed in section 3). What none of them provide is the layer above the bridge:

1. **Hybrid routing**: one interface that uses the on-device model when it's available and suitable, and falls back to a developer-supplied cloud endpoint otherwise, under a policy the developer controls.
2. **Context budget management**: the on-device window is small (8K tokens on the newer model variant, 4K on older ones). Apps need tested utilities for keeping a conversation inside that budget.
3. **A provider abstraction** that makes the two above possible, and leaves room for an Android on-device provider later.

The first consumer is TaalTree, a React Native/Expo language-learning app that wants on-device answers for simple, lesson-grounded questions and a cloud model for anything harder. Design for that use case, but keep everything app-agnostic: nothing about language learning belongs in this package.

The maintainer is a solo developer, strongest on backend/TypeScript, comfortable with Swift but not looking for a large native maintenance burden. When a design choice trades native code for TypeScript, prefer TypeScript. The same reasoning is behind shipping one package instead of several: one version number, one README, one release process.

## 2. Shape of the solution

**One npm package**, structured as a standard Expo module, with subpath exports separating the parts that need React Native from the parts that don't. The working name is `@taaltreelabs/on-device-llm`, under the maintainer's existing npm scope; check availability and ask before settling on it.

| Import path | Contents | May import RN / Expo / native? |
|---|---|---|
| `@taaltreelabs/on-device-llm` | Everything, re-exported for RN apps | Yes |
| `.../core` | Types, provider interface, error taxonomy, context manager, router, mock provider | **No** |
| `.../openai` | Provider for any Chat Completions-compatible HTTP endpoint (the cloud fallback, and `fm serve` during development) | **No** |
| `.../apple` | Provider backed by the Swift module wrapping the FoundationModels framework | Yes |
| `.../react` | Hooks: `useAvailability`, `useChat`, `useGenerate` | React only |

Repo layout follows the Expo module convention: `src/` (with `core/`, `openai/`, `apple/`, `react/` subdirectories matching the exports), `ios/` for Swift, an `android/` directory reserved for the stretch goal in section 9, `example/` for the Expo dev-client app, and `plugin/` only if a config plugin turns out to be needed.

### The isolation rule

`core` and `openai` must be importable from plain Node with no React Native, Expo, or native module anywhere in their import graph. This is what makes the Node integration tests against `fm serve` possible, and it lets someone use the context manager server-side. It's the one benefit a multi-package split would have provided, so it has to be enforced mechanically now that the boundary is only a directory:

- An ESLint `no-restricted-imports` rule (or equivalent) blocking `react`, `react-native`, `expo*`, and `../apple` / `../react` from within `src/core` and `src/openai`.
- A CI test that imports the built `core` and `openai` entry points from bare Node and fails if resolution touches anything forbidden.
- `react` is an optional peer dependency. `core` and `openai` have zero runtime dependencies.

One thing to verify early: Metro's handling of `package.json` `exports`. It has been enabled by default in recent React Native versions, but confirm against the RN versions this package intends to support, and decide whether older versions need a fallback (top-level proxy directories) or are simply out of scope.

The provider interface and error taxonomy are part of the public API, exported from `core`, so third parties can write their own providers without living in this repo.

### Stateless providers

The central design decision: **the provider interface is stateless and message-based**, like Chat Completions. A request carries the full message list; the provider returns a response. The context manager and router own the conversation; providers don't.

This creates a tension with the native API, where `LanguageModelSession` is stateful and accumulates its own transcript. Resolve it like this: the Apple provider builds a session from the supplied messages on each request (the framework has supported initializing a session from a transcript; verify the current initializer). Start with rebuild-per-request because it's simple and correct. Later, as an optimization, cache the last session and reuse it when the incoming messages are exactly the cached history plus one new user turn. Don't build the cache until the simple version is working and measured.

The reason for this choice: if providers own state, the context manager can't trim history, the router can't move a conversation from on-device to cloud between turns, and every provider has to reimplement the same bookkeeping.

### Provider interface (starting point, refine in Phase 0)

```ts
interface LLMProvider {
  readonly id: string;
  availability(): Promise<Availability>;      // available | unavailable + reason code
  capabilities(): Promise<Capabilities>;      // contextWindow, streaming, structuredOutput, tools, tokenCounting, locales
  countTokens?(messages: Message[]): Promise<number>;
  generate(req: GenerateRequest, opts?: { signal?: AbortSignal }): Promise<GenerateResult>;
  stream(req: GenerateRequest, opts?: { signal?: AbortSignal }): AsyncIterable<StreamEvent>;
}
```

`GenerateRequest` carries `messages`, optional `schema` (JSON Schema for structured output), optional `tools`, and sampling options (`temperature`, `maxOutputTokens`). `GenerateResult` carries `text` or `object`, `finishReason`, `usage` when known, and `providerId` so callers can see which provider answered.

Before finalizing, look at whether the Vercel AI SDK's `LanguageModelV2` provider spec is a better target than a bespoke interface. If conforming to it costs little, do that, since it buys compatibility with an existing ecosystem. If it forces awkward compromises (it may around availability and token counting), keep the bespoke interface and write a thin adapter later. Record the decision and reasoning in `DECISIONS.md`.

### Normalized errors

Every provider maps its failures onto one taxonomy, because the router branches on these:

`unavailable` (with reason: `deviceNotEligible`, `notEnabled`, `modelNotReady`, `unsupportedPlatform`, `unsupportedLocale`), `contextOverflow`, `guardrail`, `rateLimited`, `cancelled`, `network`, `invalidRequest`, `unknown` (always with the original error attached).

## 3. Prior art to study first

Read the source of these before writing the native module. The goal is to learn where they hit problems, not to copy code; check each license before borrowing anything beyond ideas.

- `@react-native-ai/apple` (Callstack, in `callstackincubator/ai`): AI SDK provider, tool calling, the best-maintained of the group.
- `SwiftyJunnos/expo-foundation-models`: Expo module that handles iOS 26 and 27 side by side. Read its `KNOWN_ISSUES.md`; it documents at least one API that Apple announced but didn't ship.
- `corasan/react-native-foundation-models`: Nitro module with streaming and tools.
- `@ratley/react-native-apple-foundation-models`: good availability reason-code handling.
- `gregbarbosa/fm-proxy` and `1duo/apple-fm-serve`: not RN, but their notes catalog quirks of the `fm` CLI and server (schema limits, token usage reporting).

A finding that would change the plan: if one of these is solid enough to wrap, the `apple` provider can be a thin TypeScript adapter over it (taken as a peer dependency) instead of a new native module, and this package would contain no Swift at all. Evaluate this honestly in Phase 0 and present the trade-off. The maintainer asked for a native module to be built, so the default is to build it, but the adapter option should be on the table with evidence.

## 4. What's hard

These are the places a straightforward implementation goes wrong.

**Streaming yields snapshots, not deltas.** On iOS 26 the framework's response stream emitted the cumulative text so far on each iteration, where Chat Completions emits deltas. Check what the current SDK does, then pick one convention for `StreamEvent` (deltas are the better fit for the OpenAI-compatible provider and for UI code) and convert in the Apple provider.

**Structured output needs runtime schemas.** `@Generable` is a compile-time Swift macro, which is useless across a bridge. The route is `DynamicGenerationSchema` built at runtime from JSON Schema passed from JS. Support a documented subset (objects, arrays, strings, numbers, booleans, enums, optional fields, nesting) and reject anything else with a clear `invalidRequest` error rather than silently dropping constraints.

**Tool calling crosses the bridge mid-generation.** The native model calls a Swift `Tool`, which has to invoke a JS function and await its result. That means a request/response protocol over events: native emits a tool-call event with a call ID, JS runs the handler, JS calls back into native with the result, native resumes. Handle timeouts, handler exceptions, and cancellation arriving while a tool call is in flight.

**One request per session at a time.** A session that's already responding will reject or misbehave on a second request. With rebuild-per-request this mostly disappears, but the session cache (if built) has to respect it.

**Context overflow is an error, not a truncation.** The framework throws when the window is exceeded. Map it to `contextOverflow`. The context manager exists to make this rare, and the router should be able to treat it as a fallback trigger.

**Token counting may or may not exist natively.** The `fm` CLI has a token-count subcommand, which suggests the capability exists somewhere. Check whether the public SDK exposes it. If yes, wire it to `countTokens`. If not, ship a conservative heuristic estimator (characters divided by roughly 3.5, configurable) and mark `capabilities.tokenCounting` as `estimated` so callers know to leave more margin.

**Locale support matters.** The on-device model supports a specific set of languages. Expose what the SDK reports, and surface `unsupportedLocale` as an availability reason. TaalTree teaches Dutch, French, German, and Spanish, so this isn't hypothetical.

**Guardrails.** Guardrail violations should surface as `guardrail` with whatever detail the SDK provides. Whether a guardrail refusal falls through to the cloud provider is a policy decision for the app developer; default to not falling through.

**A single package means the root import runs everywhere.** Because the root entry point re-exports the Apple provider, importing it on Android, web, or an iOS version without the framework must never throw at module load. Resolve the native module lazily and report `unavailable` instead.

## 5. Phases

Work in order. Each phase ends with its acceptance criteria met, tests green, and a short entry in `DECISIONS.md` for any non-obvious choice. Stop and check in with the maintainer at the marked points.

### Phase 0: reconnaissance and decisions

- Confirm the toolchain: Xcode version, iOS SDK version, whether the FoundationModels framework is present. Read the framework's Swift interface directly from the SDK to establish the real API surface: session initializers, streaming type, generation options, error cases, availability reasons, token counting, locale support, anything new in iOS 27 (Private Cloud Compute access, image input, context options).
- Read the prior art in section 3. Write up what each does well and where it struggles.
- Decide: bespoke provider interface vs. AI SDK spec. Build native module vs. adapt an existing one. Expo Modules API vs. Nitro/TurboModules (default to Expo Modules API unless there's a concrete reason; the first consumer is an Expo app, and the Expo module layout is what makes the single-package shape natural).
- Scaffold the repo, most likely with `create-expo-module` (verify it's still the recommended tool), then add: TypeScript strict, vitest, eslint with the isolation rule from section 2, the `exports` map, and the bare-Node import test. MIT license. Confirm Metro resolves the subpath exports from the example app.

**Stop here.** Present the API surface findings and the three decisions for review before writing library code.

### Phase 1: core types and the OpenAI-compatible provider

No device needed for this phase, which is why it comes first.

- `src/core`: message and request types, provider interface, error taxonomy, a scriptable mock provider for tests.
- `src/openai`: `generate` and `stream` (SSE parsing, `[DONE]` handling, abort via `AbortSignal`), configurable base URL, headers, and model name. Map HTTP and API errors onto the taxonomy. Use only `fetch` and web-standard APIs so it runs in both Node and React Native; check how streaming `fetch` bodies behave in RN, since that has historically needed a polyfill or `expo/fetch`, and if so accept an injectable `fetch` rather than importing one.
- Integration tests that run against `fm serve` on the development Mac when it's reachable, and skip cleanly when it isn't. It listens on loopback (port 1976 has been the default; read it from an env var) and accepts `"model": "system"`. This gives real-model testing from Node without a device.

Acceptance: a Node script importing only `.../core` and `.../openai` can hold a multi-turn conversation with `fm serve`, streaming and non-streaming, and cancel mid-stream. The isolation test passes.

### Phase 2: context manager

Pure functions in `src/core`, exhaustively unit-tested. This is the part most likely to have subtle bugs, and the easiest to test.

- Budget calculation: `window - reservedForOutput - safetyMargin`, with a larger default margin when token counts are estimated.
- Pinned messages (the system prompt, and any message flagged `pinned`) are never dropped.
- `slidingWindow`: drop oldest turns until under budget. Drop user/assistant pairs together; never leave an orphaned assistant message.
- `rollingSummary`: when usage crosses a threshold, summarize the older portion using a supplied provider, replace it with one summary message, keep the last N turns verbatim. The summarizer provider is injectable so an app can summarize with the cloud model while chatting on-device.
- A slot for app-owned structured state: a function the app supplies that renders current state into the system prompt on each request. This is the recommended pattern for purpose-built apps, so make it first-class and document it well.
- If even the pinned messages plus the newest turn exceed budget, return a `contextOverflow` error rather than sending a doomed request.

Acceptance: property-style tests showing the output never exceeds budget, pinned messages always survive, and pairs are never split. An integration test against `fm serve` that runs a conversation well past the window without an overflow error.

### Phase 3: Apple native provider

Swift in `ios/`, TypeScript wrapper in `src/apple`. Build in this order, with the example app growing alongside so each step is verifiable.

1. Availability with reason codes, capabilities, supported locales.
2. `generate` with instructions and sampling options. Session built from messages per request.
3. `stream`, converted to deltas, with cancellation that really stops native generation.
4. Session prewarming, if the SDK offers it, exposed as an optional call.
5. Token counting (native or estimated).
6. Structured output via runtime schema construction.
7. Tool calling across the bridge.
8. Lazy native-module resolution: on non-iOS platforms and unsupported OS versions, importing the package root works and the provider reports `unavailable` with `unsupportedPlatform`. Build the example app for Android to prove it.
9. Config plugin only if Info.plist or entitlement changes turn out to be needed.

Foundation Models has worked in the iOS Simulator when the host Mac has Apple Intelligence enabled; verify this still holds, since it makes iteration much faster.

**Stop after step 3** for the maintainer to run the example app on a physical device. Simulator behavior isn't sufficient evidence for performance or availability handling. Stop again after step 7.

Acceptance: the example app chats, streams, cancels, returns a schema-valid object, and completes a tool round-trip on a physical device; on Android it shows a clean "unavailable" state.

### Phase 4: router and React hooks

- In `src/core`: `createRouter({ providers, policy })` returns something that itself implements `LLMProvider`, so routers compose and the rest of an app doesn't care whether it's talking to one provider or several.
- Policy inputs: ordered provider preference, availability, estimated request tokens against each provider's window, a caller-supplied task tag (for example `simple` vs. `reasoning`), and a caller-supplied predicate for anything else.
- Fallback triggers, each individually configurable: `unavailable`, `contextOverflow`, `network`, and optionally `guardrail` (off by default). Never retry on `cancelled` or `invalidRequest`.
- Don't fall back after streaming has started emitting content to the caller; a response that switches models halfway through is worse than an error.
- An `onRoute` callback reporting which provider handled each request and why, so apps can build their own telemetry. The package itself never logs or transmits prompt or response content.
- In `src/react`: `useAvailability` (re-checks when the app returns to foreground, since a model download may have completed), `useChat` (messages, streaming text, status, error, `send`, `stop`, `reset`, wired to the context manager), `useGenerate` for one-shot calls.

Acceptance: in the example app, toggling a "simulate unavailable" switch moves the conversation to the cloud provider on the next turn with history intact.

### Phase 5: documentation and release readiness

- One README covering: quick start, the import paths and what each is for, the structured-state pattern, choosing a context strategy, writing a routing policy, writing a custom provider, and a compatibility matrix (OS version, RN version, device eligibility, feature support). Move longer guides to a `docs/` directory if the README gets unwieldy.
- An honest "when not to use this" section that points at the existing packages for apps that only need the raw bridge.
- CI: typecheck, lint (including the isolation rule), unit tests, the bare-Node import test, and an iOS build of the example app. Integration tests against `fm serve` stay local-only.
- Verify the published tarball contents with `npm pack`: compiled JS and type declarations for every subpath, the `ios/` sources and podspec, no example app, no tests.
- **Do not publish to npm**; the maintainer will do the first release by hand.

## 6. Working agreements

- Verify every Apple API against the installed SDK before using it. If something in this plan turns out to be wrong, follow the SDK and note the discrepancy in `DECISIONS.md`.
- Keep dependencies minimal. `core` and `openai` have none at runtime. Justify any addition elsewhere.
- Keep the internal boundaries between `core`, `openai`, `apple`, and `react` clean even though they ship together. If the project ever outgrows one package, splitting along those lines should be a mechanical change.
- Small, reviewable commits with messages that explain why.
- Tests accompany the code they cover, in the same commit.
- When blocked on something only a human can do (physical device runs, Apple developer account steps, npm scope access), say so plainly and continue with whatever unblocked work remains.
- If a phase turns out much larger than described, stop and re-plan with the maintainer rather than pushing through.

## 7. What done looks like

An Expo app can install one package, write about twenty lines of setup, and get a chat hook that answers on-device when it can, in the cloud when it can't, never overflows the context window, and tells the app which path each response took. A Node script can import the same package's `core` and `openai` paths and use the context manager with no React Native in sight. The native module is small enough that the maintainer can keep it current with one OS release a year.

## 8. Out of scope

Embeddings, speech, transcription, image generation, adapter/LoRA loading, retrieval, and any UI components beyond the example app. Several existing packages cover the first three. These can be revisited after a first release if there's demand.

## 9. Stretch: Android provider

Google offers on-device Gemini Nano through ML Kit's GenAI APIs on supported devices. An Android provider implementing the same interface would make this the only cross-platform option in the ecosystem, and the single-package shape suits it: the Kotlin goes in the `android/` directory of the same Expo module, the TypeScript wrapper in `src/android`, and users get it with a version bump instead of a new install.

It's also a second fast-moving native target with narrow device support, so don't start it until Phases 0 through 5 are complete and the iOS side has been used in a real app. When the time comes, begin with the same reconnaissance step as Phase 0: establish the current API surface, device eligibility, and context limits before designing anything.
