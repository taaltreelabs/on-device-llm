# Ecosystem reconnaissance — Sept 2026

Research for Phase 0 of `@taaltreelabs/on-device-llm`. Verified via WebSearch/WebFetch and local `npm view` on 2026-09-20/21. Treat exact patch numbers as a snapshot of that day; re-check before Phase 0 sign-off if this doc goes stale.

---

## 1. Scaffolding: `create-expo-module`

**Yes, still the recommended tool.** It remains the official Expo-provided scaffolder for native modules (`npx create-expo-module@latest`), and it was substantially revamped in SDK 56.

- Current Expo SDK: **57** (`npm view expo version` → `57.0.24`), pairing with **React Native 0.86** (Expo docs SDK-to-RN table: SDK 57 → RN 0.86, SDK 56 → RN 0.85, SDK 55 → RN 0.83, SDK 54 → RN 0.81). `npm view create-expo-module version` → `57.0.1` (the tool version tracks the SDK it targets; always install `@latest`, not a pinned old major).
- Note: plain `npm view react-native version` resolves to `0.87.1` — that's upstream RN slightly ahead of what Expo has adopted; Expo SDK 57 ships RN 0.86, not 0.87. Don't assume "latest RN on npm" == "what Expo pairs with."
- Template changes relevant to us:
  - SDK 56 revamped `create-expo-module`: it's now modular (pick which features/platforms get scaffolded), supports non-interactive mode, and **no longer emits a barrel file by default** for local modules (pass `--barrel` to opt in). Old versions of the CLI always pulled the `@latest` template, which broke against the SDK 56+ template shape — so pin the CLI version to the SDK you're targeting.
  - Podspec: iOS deployment target should be bumped to **16.4** in any Expo module's podspec as of recent SDKs.
  - Swift module API: Expo Modules API has an **Expo Modules API 2.0** with new Swift macros (`@ExpoModule`, `@JS`, `@Event`) as an alternative to the older definition-DSL (`ModuleDefinition { ... }`) style. There's a documented `expo-migrate-module` skill/codemod for moving DSL modules to the macro style. Plan's assumption of "Expo Modules API, DSL-style" still works, but the macro API is worth evaluating in Phase 0 since it's the forward-looking style Expo is pushing.
  - SDK 56+ also allows defining Expo modules directly inside the app project (not just a separate package) — not directly relevant since we're building a standalone package, but confirms the module layout conventions are stable.

Sources: https://expo.dev/changelog/sdk-56 , https://expo.dev/changelog/sdk-57 , https://docs.expo.dev/versions/latest/ , https://docs.expo.dev/modules/get-started/ , https://github.com/expo/expo/pull/50138

---

## 2. Metro + `package.json` `exports`

- Metro added **beta** support for `exports` in React Native **0.72**; it became **enabled by default starting in React Native 0.79** (Metro 0.82). Apps can still opt out via `unstable_enablePackageExports: false` in `metro.config.js` if they hit compatibility problems, but the default is on.
- Given the plan's likely support floor, everything from **RN 0.81 onward (Expo SDK 54+)** has `exports` resolution on by default, and RN 0.79/0.80 also default it on. Only pre-0.79 RN needs the opt-in/fallback treatment.
- **Recommendation for a Sept 2026 support floor:** target **RN ≥ 0.81 / Expo SDK ≥ 54** as the sensible floor. Rationale: it's two SDKs behind current (57), well past the point `exports` is default-on, and past the New Architecture-mandatory line (0.76 made New Arch default; **0.82 permanently removed the legacy bridge architecture**, and SDK 55/RN 0.83 removed Legacy Architecture from the codebase entirely — so anything from 0.81 up is New-Architecture-only anyway, simplifying the native module). Below that floor, don't build a proxy-directory fallback — declare it unsupported and document the floor in the compatibility matrix, since maintaining dual resolution strategies for a solo maintainer isn't worth it and the ecosystem has clearly moved past bridge-era RN.
- Caveat worth flagging in Phase 0: Metro's `exports` resolution has known rough edges even when enabled — e.g. it can pick the wrong condition (`import` vs `react-native`) in `unstable_enablePackageExports` mode (facebook/metro#1278), and Expo tracks a live list of libraries incompatible with Metro's ESM/exports resolution (expo/expo discussion #36551). Worth testing our actual `exports` map against the example app early, per the plan's own Phase 0 checklist item.

Sources: https://reactnative.dev/blog/2023/06/21/package-exports-support , https://x.com/satya164/status/1916098945643593859 , https://github.com/facebook/metro/issues/1278 , https://github.com/expo/expo/discussions/36551 , https://blog.codemagic.io/react-native-new-architecture-ota-updates/ , https://docs.expo.dev/versions/latest/

---

## 3. Streaming fetch in React Native

- **RN's built-in `fetch` still does not support streaming response bodies.** It's a polyfill over `XMLHttpRequest`, not native `fetch`; Hermes/RN's `Response.body` does not implement `ReadableStream`, so `response.body.getReader()` is unavailable. This is a long-standing, still-open limitation as of 2026 (facebook/react-native#27741 remains the tracking issue; recent 2026 commentary confirms it — "Hermes does not implement ReadableStream on fetch, which silently breaks every cloud LLM SDK that calls `response.body.getReader()`").
- **`expo/fetch`** (shipped since SDK 52) is the WinterCG-compliant fetch that *does* support streaming via `getReader()`, and is the documented way to get real token-by-token streaming in an Expo app. However, it has had real stability regressions in 2026: SDK 53 reports of streaming batching all chunks into one instead of delivering incrementally (expo/expo#37310), and reports that backgrounding the app mid-stream kills active POST/streaming requests (expo/expo#42946, Feb 2026). So it's the right tool but not bulletproof — needs to be verified against whatever current SDK the app targets, not assumed.
- Workaround packages exist for bare RN (`react-native-fetch-api`, XHR-based SSE readers hitting ~60fps token delivery) but add a dependency `core`/`openai` should avoid per the plan's zero-runtime-deps rule.
- **Conclusion, matches the plan's own hedge:** the `openai` provider should **accept an injectable `fetch`** rather than importing one, exactly as section 5/Phase 1 already anticipates. Concretely:
  - Default to `globalThis.fetch` when not overridden (works fine for non-streaming Node/`fm serve` use and for RN's non-streaming needs).
  - In the README: **tell Expo users to pass `fetch` from `expo/fetch`** for real streaming (`import { fetch } from 'expo/fetch'`), and **tell bare-RN users** that global `fetch` will not stream — either use `expo/fetch` if they have the Expo modules runtime available, or supply their own WHATWG-compliant fetch (e.g. `react-native-fetch-api`) if they don't. Document this explicitly in the compatibility matrix since silent non-streaming fallback (rather than an error) is the likely failure mode people will hit and not understand.

Sources: https://github.com/facebook/react-native/issues/27741 , https://getwireai.com/blog/hermes-readablestream-llm-streaming-react-native-fix , https://github.com/expo/expo/issues/37310 , https://github.com/expo/expo/issues/42946 , https://docs.expo.dev/versions/latest/sdk/expo/ , https://github.com/vercel/ai/issues/3705

---

## 4. Vercel AI SDK provider spec

- **Current AI SDK major and spec version:** npm `ai` package `latest` dist-tag is **7.0.107** (`ai-v6`: 6.0.286, `ai-v5`: 5.0.261 kept as legacy dist-tags). The provider interface in the current major is **`LanguageModelV3`** (`@ai-sdk/provider`), up from `LanguageModelV2`. AI SDK 6 was the release that migrated V2→V3.
- **What implementing `LanguageModelV3` requires** (confirmed by reading `@react-native-ai/apple`'s actual source, `packages/apple-llm/src/ai-sdk.ts`, and the spec file on GitHub):
  - Required fields: `specificationVersion: 'v3'`, `provider: string`, `modelId: string`, `supportedUrls: Record<string, RegExp[]>` (media-type → URL patterns it can fetch itself).
  - Required methods: `doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult>` and `doStream(...): Promise<LanguageModelV3StreamResult>` (the `do`-prefix is deliberate, to push consumers through the `generateText`/`streamText` wrapper functions instead of calling the model directly).
  - `doGenerate`/`doStream` results carry `content` (text/tool-call/tool-result parts), `finishReason`, `usage` (structured `inputTokens`/`outputTokens` with cache sub-fields), and a `warnings` array (the spec's mechanism for "provider doesn't support X option you passed" — e.g. GPT-6+ silently dropping `temperature`/`topP` and returning a warning instead of erroring).
  - Provider-specific extras go through a namespaced `providerOptions` object on the prompt, not through new interface fields.
  - Packages: `@ai-sdk/provider` (types), `@ai-sdk/provider-utils` (helpers like `generateId`, `jsonSchema`, `parseJSON`) are the only two packages needed to implement a provider; the `ai` package itself is only needed by consumers calling `generateText`/`streamText`.
- **Assessment — does it have natural places for our three concerns?**
  - **(a) Availability with reason codes: no natural place.** There is no availability method in `LanguageModelV3` at all. `@react-native-ai/apple` bolts on `provider.isAvailable()` as a **custom method on the provider factory function**, entirely outside the spec — it's not callable through any AI SDK code path, only if a consumer knows to reach past the interface. There's no reason-code concept (`deviceNotEligible` vs `notEnabled` vs `modelNotReady`) anywhere in the spec; a caller just gets a generic thrown `Error` (with a bolted-on `.code` field, see below) if generation is attempted while unavailable.
  - **(b) Token counting: no natural place, and the reference implementation fakes it.** `usage.inputTokens`/`usage.outputTokens` exist in the *result* shape (post-hoc, after a generation), but there is no pre-flight `countTokens()` method in the spec. Confirming this isn't just a gap they haven't filled: `@react-native-ai/apple`'s `doGenerate` and `doStream` both hardcode `usage: { inputTokens: { total: 0, ... }, outputTokens: { total: 0, ... } }` — i.e., they satisfy the required shape with zeros because Apple's on-device API doesn't give them real numbers and the spec gives them nowhere else to put an estimate.
  - **(c) Capability discovery: no natural place.** No `capabilities()` / context-window / streaming-support / structured-output-support fields anywhere in `LanguageModelV3`. `modelId` is a fixed string (`'system-default'` in the reference impl) with no metadata attached.
  - **Errors don't map onto the spec either.** `@react-native-ai/apple` has its own `AppleLLMError` type with a `.code` field (`MODEL_UNAVAILABLE`, `UNSUPPORTED_OS`, `CONTEXT_WINDOW_EXCEEDED`, etc. — strikingly close to the plan's own taxonomy) but throws them as plain `Error`s from `doGenerate`/`doStream`; the AI SDK spec has no normalized error taxonomy for a provider to conform to, so this is 100% custom code sitting beside the spec, not using it.
  - **Structured output is uneven:** their `doGenerate` accepts a JSON schema via `responseFormat`, but `doStream` explicitly throws `'Streaming JSON responses is not yet supported.'` — a real, currently-shipping example of the plan's own predicted "structured output + streaming" pain point.
- **Conclusion: conforming to `LanguageModelV3` would force exactly the awkward compromises the plan flagged, confirmed empirically, not just in theory.** The plan's own bespoke interface (`availability()`, `capabilities()`, `countTokens?()`, normalized error taxonomy) has a natural home for all three concerns that `LanguageModelV3` structurally lacks. **Recommendation: keep the bespoke `core` interface as the source of truth** (matches the plan's fallback plan), and treat AI SDK compatibility as a **thin adapter** layered on top later if ecosystem compatibility becomes valuable — exactly mirroring what `@react-native-ai/apple` had to do anyway (bolt custom methods/error codes beside the spec rather than fit them inside it). This should go in `DECISIONS.md` as: "AI SDK spec evaluated and rejected as the primary interface; adapter to be considered as a later, optional addition once the bespoke interface is stable."

Sources: https://github.com/callstackincubator/ai (packages/apple-llm/src/ai-sdk.ts, errors.ts, index.ts — read directly), https://ai-sdk.dev/providers/community-providers/react-native-apple , https://www.react-native-ai.dev/docs , https://ai-sdk.dev/docs/foundations/provider-options , https://ai-sdk.dev/providers/community-providers/custom-providers , npm `ai` dist-tags (`npm view ai dist-tags`)

---

## 5. npm naming

- `npm view @taaltreelabs/on-device-llm` → **404 Not Found** (package name is free).
- `npm view @taaltreelabs/core`, `@taaltreelabs/llm`, `@taaltreelabs/foundation-models` → all **404** as well — nothing at all is currently published under the `@taaltreelabs` scope on the public registry. (`npm search @taaltreelabs` also returned "No matches found.") This doesn't distinguish "scope unclaimed" from "maintainer owns the scope/org but hasn't published anything yet" — npm's public API doesn't expose that without auth; `https://www.npmjs.com/org/taaltreelabs` returned an HTTP 403 rather than a clean 404, which is at least consistent with the org existing but being private/empty, worth the maintainer double-checking from their own logged-in npm account rather than relying on this scan.
- Unscoped/similar names already taken by prior-art packages the plan already knows about:
  - `expo-foundation-models` (SwiftyJunnos) — published, v1.0.2, actively maintained (published 4 days before this scan).
  - `react-native-foundation-models` (corasan) — published, v0.1.3, Nitro-based.
  - `@react-native-ai/apple` (Callstack) — published, v0.12.0, the AI-SDK-conformant one analyzed in Q4.
  - Plain `on-device-llm` and `react-native-on-device-llm` (unscoped) → both **404**, i.e. free, but irrelevant since the plan already commits to the scoped name.
- **No conflict found.** `@taaltreelabs/on-device-llm` is safe to use as the working name; nothing to negotiate. Did not publish or reserve anything, per instructions.

Sources: local `npm view`/`npm search` output (2026-09-21), https://www.npmjs.com/package/expo-foundation-models , https://www.npmjs.com/package/react-native-foundation-models , https://www.npmjs.com/package/@react-native-ai/apple

---

## 6. Vitest

- Current major: **Vitest 5** (`npm view vitest version` → `5.0.1`, published ~2 days before this scan). Timeline: Vitest 3.0 (Jan 2025) → Vitest 4.0 (Oct 2025) → Vitest 4.1 (Mar 2026) → **Vitest 5.0** (current, mid/late 2026). Vitest 4.1 still receives backported fixes, so 4.1/5.0 are the two versions worth supporting if pinning a range, but for a new project just target 5.x.
- **Known issues relevant to a package with `exports` subpaths and Node ESM**, all still live patterns as of the versions checked:
  - Vitest doesn't always respect custom/all `exports` conditions the way Node or Vite would — e.g. it's historically picked the Node build even under `environment: 'jsdom'` because it doesn't honor a `browser` condition in `exports` the way you'd expect (vitest-dev/vitest#2603).
  - Wildcard export patterns (`"./*/*"`) have triggered `Failed to load url <package>/<dir>/<module>` errors (vitest-dev/vitest#4761) — relevant since our `exports` map is a flat, explicit set of subpaths (`./core`, `./openai`, `./apple`, `./react`), not wildcards, so this specific bug shouldn't bite us, but it's a reason to keep the map explicit rather than templated.
  - General ESM/CJS resolution mismatches between what Vite/Vitest will bundle vs. what plain Node resolves are a recurring theme (vitest-dev/vitest#4007, #6875, #5486); the common fix is ensuring `"type": "module"` and consistent `main`/`module`/`exports` fields agree, and where needed using Vitest's `deps.inline`/`resolve.conditions` config to force matching what Node would pick.
  - **Practical implication for Phase 0:** the plan's own "bare-Node import test" (importing the *built* `core`/`opener` entry points, not source, from plain Node) is the right way to sidestep most of this — it validates against Node's actual resolver rather than Vitest's, which is where these discrepancies live. Vitest unit tests should additionally set `resolve.conditions`/test environment explicitly rather than relying on defaults, given the documented default-condition mismatches.

Sources: https://vitest.dev/blog/vitest-4 , https://vitest.dev/blog/vitest-4-1.html , https://qaskills.sh/blog/vitest-3-to-4-migration-guide , local `npm view vitest version` , https://github.com/vitest-dev/vitest/issues/2603 , https://github.com/vitest-dev/vitest/issues/4761 , https://github.com/vitest-dev/vitest/issues/4007 , https://github.com/vitest-dev/vitest/issues/6875 , https://vitest.dev/guide/common-errors
