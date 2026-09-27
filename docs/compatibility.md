# Compatibility and availability

[Back to the README](../README.md)

| Requirement                   | Value                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS / macOS (on-device model) | **26.0 or newer** at runtime, with Apple Intelligence enabled. The package itself links into apps at iOS 16.4 or above; below iOS 26 it reports `unsupportedPlatform` and routes to your cloud provider. See [What differs on iOS 26](#what-differs-on-ios-26) for the gaps versus iOS 27. |
| Example app Expo SDK          | 57                                                                                                                                                                                                                                                                                                            |
| Example app React Native      | 0.86                                                                                                                                                                                                                                                                                                          |
| React                         | Optional peer dependency; required only for `.../react`                                                                                                                                                                                                                                                       |
| Runtime dependencies          | None                                                                                                                                                                                                                                                                                                          |
| Device                        | Apple Intelligence-eligible hardware, with Apple Intelligence turned on and the model assets downloaded                                                                                                                                                                                                       |
| Android                       | Cloud routing (`openai`) works out of the box, same as any other JS runtime. On-device (Gemini Nano) ships separately via [`@taaltreelabs/on-device-llm-android`](https://github.com/taaltreelabs/on-device-llm-android) — see [Android on-device?](../README.md#requirements).                               |

The example app uses Expo SDK 57 and React Native 0.86.3. The root development
manifest uses React Native 0.82.1; peer dependencies do not enforce a version floor.
These versions describe the repository configuration, not a compatibility guarantee
for every Expo or React Native release.

Everything except the Apple provider runs anywhere a modern JavaScript runtime does,
including Node and the browser.

## Availability

`provider.availability()` answers `{ available: true }` or `{ available: false, reason,
detail? }`. The reasons:

| Reason                | Means                                                                                                                                      | What an app should do                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `deviceNotEligible`   | The hardware cannot run the model. Also reported when `createAppleProvider({ locale })` names a language the model does not support. | Permanent. Route to the cloud, or hide the on-device feature.                                 |
| `notEnabled`          | Eligible hardware, Apple Intelligence switched off.                                                                                        | Ask the user to enable it in Settings.                                                        |
| `modelNotReady`       | Enabled, but assets are still downloading or otherwise not ready.                                                                          | Transient. Re-check on foreground — `useAvailability`'s `resubscribe` option exists for this. |
| `unsupportedPlatform` | No such capability here: Android, web, Node, or an OS below the floor.                                                                     | Permanent for this install. The import still works and the provider still answers politely.   |

`unsupportedLocale` is deliberately **not** an availability reason: Apple's enum has
exactly three cases, and a model that works in English is not "unavailable" because you
asked in Polish. It is an `LLMError` code raised per request, and it is a fallback
trigger by default.

One caveat is load-bearing enough to repeat: **`available: true` means "nothing known is
blocking", not "the next request will succeed"**. See
[Troubleshooting](troubleshooting.md#availability-says-available-but-every-generation-fails).

## Feature support

|                   | `apple`                                                                                                   | `openai`                                                               | `MockProvider` |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| Streaming         | Yes, real token deltas                                                                                    | Yes, with a streaming `fetch` injected; otherwise one aggregated delta | Yes, scripted  |
| Structured output | Yes, when the model reports guided generation                                                             | Yes (`response_format`), subject to your endpoint                      | Scripted only  |
| Tool calling      | Yes, with timeout and cancellation                                                                        | **No** — a request carrying `tools` is rejected as `invalidRequest`    | No             |
| Token counting    | `exact` (native `tokenCount`) from iOS 26.4; `estimated` below that                                       | `estimated` (`estimateTokens`)                                         | Configurable   |
| Context window    | Reported by the device (4K or 8K depending on the model variant); `UNKNOWN` when the framework cannot say | Whatever you configure; `UNKNOWN` by default                           | Configurable   |
| Locales           | 24 BCP-47 tags, enumerated                                                                                | `UNKNOWN` unless you configure them                                    | Configurable   |

`UNKNOWN` is a real, typed value exported from `core`, not a stand-in for zero or
infinity. The context manager and the router both handle it explicitly rather than
guessing.

## What differs on iOS 26

The on-device model runs from iOS 26.0, not only 27.0, but the iOS 26
bridge has less to work with than iOS 27's. All gaps disappear at iOS 27; none of them
affect the `openai` provider or the router.

| Area                                               | iOS 27+                                 | iOS 26.x                                                                          |
| -------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| `contextOverflow` error                            | Carries `contextSize` and `tokenCount`  | Neither field is present                                                          |
| `decodingFailure` error                            | Carries raw model output (`rawContent`) | No raw output                                                                     |
| `unsupportedLocale` error                          | Names the offending `locale`            | No `locale`                                                                       |
| `rateLimited` error                                | Carries `resetDate`                     | No `resetDate`                                                                    |
| `usage` / `finishReason`                           | Real per-response `usage`               | No `usage`; `finishReason` is always `'stop'`, even when truncated                |
| Token counting                                     | Always `exact`                          | `exact` from 26.4 onward, `estimated` on 26.0–26.3 (256-token safety margin) |
| `modelLabel`                                       | `variant.displayName`, queried live     | Fixed string `"Apple Foundation Model"`                                           |
| `supportsVision` / `supportsReasoning`             | Queried live                            | Fixed `false`                                                                     |
| `supportsGuidedGeneration` / `supportsToolCalling` | Queried live                            | Fixed `true`                                                                      |
| `contextWindow`                                    | Device-reported                         | `4096` below iOS 26.4                                                             |

**Simulator checks:** the iOS 26 fallbacks above have been exercised live on iOS 26.0 and
26.5 Simulators (capability fallbacks, estimated token counting, and the iOS 26 error
mapping confirmed). On 26.5, where the on-device model fails with a transient error, the
router's fallback to the cloud provider completed end to end.
The below-26 `unsupportedPlatform` path has now run live too, on an iOS 18.6 Simulator,
where the app launched normally and every call reported the documented fallback — but
still only on a Simulator, not a physical pre-26 iPhone — see
[iOS 26 verification notes](research/ios26-compat.md) for exactly what was run versus only compiled.
