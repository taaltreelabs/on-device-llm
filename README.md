# @taaltreelabs/on-device-llm

One interface over Apple's on-device Foundation Model and your own cloud endpoint, for
React Native and Expo apps. The on-device model answers when it is available and the
request suits it; a Chat Completions-compatible endpoint you configure answers when it
is not. In between sit the parts every app otherwise writes by hand: a context-window
budget manager that keeps a conversation inside a 4–8K token window, a routing policy you can
read and test, a normalized error taxonomy both providers map onto, and React hooks
wired to all of it. Prompts stay on the device unless your policy sends them elsewhere,
and the package never logs or transmits prompt or response content.

**Status: early release (0.1.x).** The API may still change before 1.0. The library itself is complete through the router and hooks —
see [`docs/plan.md`](docs/plan.md) for the plan and [`DECISIONS.md`](DECISIONS.md) for
why the API looks the way it does.

## Quick start

```bash
npm install @taaltreelabs/on-device-llm
```

The Apple provider is a native Expo module, so an iOS build needs a development client
(`npx expo run:ios`), not Expo Go, and the app's iOS deployment target must be **27.0** —
see [Troubleshooting](#the-native-module-is-missing-at-runtime-though-the-build-was-green).
Add the package to `plugins` in `app.json` too. Its config plugin applies the native patch a
freshly prebuilt Expo 57 app needs before it will launch on the iOS 27 SDK — see
[the app crashes at launch](#the-app-crashes-at-launch-with-uiscene-life-cycle-is-required):

```json
{
  "expo": {
    "plugins": ["@taaltreelabs/on-device-llm"]
  }
}
```

Setup is one router and one hook:

```tsx
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { createRouter } from '@taaltreelabs/on-device-llm/core';
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';
import { useChat } from '@taaltreelabs/on-device-llm/react';
import { fetch as expoFetch } from 'expo/fetch';
import { Button, Text, View } from 'react-native';

const llm = createRouter({
  providers: [
    createAppleProvider(),
    createOpenAIProvider({
      baseUrl: 'https://your-endpoint.example.com/v1',
      model: 'your-model',
      apiKey: process.env.EXPO_PUBLIC_LLM_API_KEY,
      // Bare React Native's fetch cannot stream; expo/fetch can. See "Streaming
      // on React Native" below.
      fetch: expoFetch as unknown as typeof fetch,
      contextWindow: 128_000,
    }),
  ],
});

export function Assistant() {
  const { messages, streamingText, status, send } = useChat({
    provider: llm,
    systemPrompt: 'You are a concise assistant.',
  });

  return (
    <View>
      {messages.map((message, index) => (
        <Text key={index}>{message.content}</Text>
      ))}
      {streamingText !== undefined && <Text>{streamingText}</Text>}
      <Button
        title="Ask"
        disabled={status !== 'idle'}
        onPress={() => void send('What should I cook tonight?')}
      />
    </View>
  );
}
```

That is the whole setup. The router tries the on-device model first, falls back to the
cloud endpoint when the device model is unavailable, the conversation outgrows its
window, the network call fails, or the language is unsupported; `useChat` runs every turn
through the context manager before sending it, streams deltas into `streamingText`, and
appends the finished turn to `messages`. `result.providerId` — and the `onRoute` callback
— tell you which provider answered.

## Import paths

The package ships one npm module with five entry points. The split is mechanical, not
cosmetic: `core` and `openai` are verified on every CI run to have nothing React, React
Native, Expo, or native anywhere in their import graph.

| Import path                   | Contains                                                                                                                   | May import                             | Use it when                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `@taaltreelabs/on-device-llm` | Everything below, re-exported                                                                                              | RN, Expo, native                       | You are in a React Native app and do not care about the boundary |
| `.../core`                    | Types, `LLMProvider`, `LLMError`, context manager, `createRouter`, `normalizeJsonSchema`, `estimateTokens`, `MockProvider` | Nothing (zero runtime dependencies)    | Always — this is the API everything else conforms to             |
| `.../openai`                  | `createOpenAIProvider` for any Chat Completions-compatible endpoint                                                        | Nothing but `fetch`                    | You need a cloud fallback, or a server-side provider             |
| `.../apple`                   | `createAppleProvider`, backed by the Swift FoundationModels module                                                         | RN, Expo, native — all resolved lazily | You want on-device generation                                    |
| `.../react`                   | `useAvailability`, `useChat`, `useGenerate`                                                                                | `react` only                           | You are building UI                                              |

**Importing the package root is safe on every platform.** Nothing resolves the native
module at load time. On Android, on web, and under Node, `createAppleProvider()` returns
a provider that reports `unavailable` with reason `unsupportedPlatform` and whose
`generate`/`stream` throw the matching `LLMError`. Nothing crashes, and a router simply
falls past it.

**`core` and `openai` run under plain Node**, which is a feature rather than an accident
of the layout. The context manager, the router, the schema normalizer, and the
OpenAI-compatible provider are usable server-side with no React Native in sight:

```ts
import { fitContext, rollingSummary, type Message } from '@taaltreelabs/on-device-llm/core';
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';

const provider = createOpenAIProvider({
  baseUrl: 'http://127.0.0.1:1976/v1', // fm serve, during development
  model: 'system',
  contextWindow: 4096,
});

const history: Message[] = [
  { role: 'system', content: 'You are a terse assistant.', pinned: true },
  { role: 'user', content: 'What did we decide about the roll-out date?' },
];

const fitted = await fitContext(history, { provider, reservedForOutput: 256 });
for await (const event of provider.stream({ messages: fitted.messages })) {
  if (event.type === 'textDelta') process.stdout.write(event.delta);
}

// rollingSummary and every other strategy are plain functions too.
void rollingSummary;
```

## Requirements and compatibility

| Requirement                   | Value                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS / macOS (on-device model) | **27.0 or newer** (DECISIONS.md D4). iOS 26 shipped the framework; it is deliberately not supported, and reports `unsupportedPlatform`.                                                                                                                                  |
| Expo SDK                      | 57                                                                                                                                                                                                                                                                       |
| React Native                  | 0.86                                                                                                                                                                                                                                                                     |
| React                         | Optional peer dependency; required only for `.../react`                                                                                                                                                                                                                  |
| Runtime dependencies          | None                                                                                                                                                                                                                                                                     |
| Device                        | Apple Intelligence-eligible hardware, with Apple Intelligence turned on and the model assets downloaded                                                                                                                                                                  |
| Android                       | Cloud routing (`openai`) works out of the box, same as any other JS runtime. On-device (Gemini Nano) ships separately via [`@taaltreelabs/on-device-llm-android`](https://github.com/taaltreelabs/on-device-llm-android) — see [Android on-device?](#android-on-device). |

Everything except the Apple provider runs anywhere a modern JavaScript runtime does,
including Node and the browser.

### Availability and its three-and-a-bit reasons

`provider.availability()` answers `{ available: true }` or `{ available: false, reason,
detail? }`. The reasons:

| Reason                | Means                                                                                                                                      | What an app should do                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `deviceNotEligible`   | The hardware cannot run the model. Also reported when `createAppleProvider({ locale })` names a language the model does not support (D19). | Permanent. Route to the cloud, or hide the on-device feature.                                 |
| `notEnabled`          | Eligible hardware, Apple Intelligence switched off.                                                                                        | Ask the user to enable it in Settings.                                                        |
| `modelNotReady`       | Enabled, but assets are still downloading or otherwise not ready.                                                                          | Transient. Re-check on foreground — `useAvailability`'s `resubscribe` option exists for this. |
| `unsupportedPlatform` | No such capability here: Android, web, Node, or an OS below the floor.                                                                     | Permanent for this install. The import still works and the provider still answers politely.   |

`unsupportedLocale` is deliberately **not** an availability reason (D7): Apple's enum has
exactly three cases, and a model that works in English is not "unavailable" because you
asked in Polish. It is an `LLMError` code raised per request, and it is a fallback
trigger by default.

One caveat is load-bearing enough to repeat: **`available: true` means "nothing known is
blocking", not "the next request will succeed"** (D9). See
[Troubleshooting](#availability-says-available-but-every-generation-fails).

### Feature support

|                   | `apple`                                                                                                   | `openai`                                                               | `MockProvider` |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| Streaming         | Yes, real token deltas                                                                                    | Yes, with a streaming `fetch` injected; otherwise one aggregated delta | Yes, scripted  |
| Structured output | Yes, when the model reports guided generation                                                             | Yes (`response_format`), subject to your endpoint                      | Scripted only  |
| Tool calling      | Yes, with timeout and cancellation                                                                        | **No** — a request carrying `tools` is rejected as `invalidRequest`    | No             |
| Token counting    | `exact` (native `tokenCount`)                                                                             | `estimated` (`estimateTokens`)                                         | Configurable   |
| Context window    | Reported by the device (4K or 8K depending on the model variant); `UNKNOWN` when the framework cannot say | Whatever you configure; `UNKNOWN` by default                           | Configurable   |
| Locales           | 24 BCP-47 tags, enumerated                                                                                | `UNKNOWN` unless you configure them                                    | Configurable   |

`UNKNOWN` is a real, typed value exported from `core`, not a stand-in for zero or
infinity. The context manager and the router both handle it explicitly rather than
guessing (D11).

## Privacy

Every provider in this package answers the same question — where does the content
actually go? — differently enough that "on-device LLM toolkit" cannot be the whole
privacy story on its own. Here is the honest, per-provider breakdown:

| Provider                                           | Where content goes                                                                                | Notes                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apple`                                            | Nowhere off the device. Inference runs entirely on-device via Apple's FoundationModels framework. | No network calls, nothing sent to Apple, no disclosure duty. See Apple's own framework documentation for the on-device processing model this provider wraps.                                                                                                            |
| `openai`                                           | Wherever `baseURL` points — the endpoint **you** configure.                                       | This provider does not hardcode OpenAI's servers; it speaks the Chat Completions wire format to whatever host you give it. Whatever that endpoint's own data-handling terms are, they are yours to read, not this package's to soften. Nothing goes anywhere else.      |
| The package itself (`core`, the router, the hooks) | Nowhere.                                                                                          | `core` never logs or transmits message content. The router's `onRoute` callback (`src/core/router/router.ts`) is deliberately content-free — it reports provider ids, error codes, and durations, never a prompt, a response, or an error message that might quote one. |

This is why the Android on-device provider is a separate package rather than a mode of
this one — see [Android on-device?](#android-on-device) below.

## Guides

### The structured-state pattern

**Start here if your app has state the model needs.** A chat history is a poor database.
If the model needs the user's open tasks, the document they have in front of them, or the
step of a flow they are on, do not hope it survives twenty turns of history and do not pay
to keep those turns in the window. Render the state fresh into the system prompt on every
request:

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { fitContext } from '@taaltreelabs/on-device-llm/core';

const provider = createAppleProvider();
const store = { tasks: [{ title: 'Renew passport', done: false, due: '2026-10-01' }] };

const fitted = await fitContext(
  [
    { role: 'system', content: 'You are a task assistant. Be brief.', pinned: true },
    { role: 'user', content: 'What should I do first?' },
  ],
  {
    provider,
    systemState: () =>
      store.tasks.length === 0
        ? 'No open tasks.'
        : store.tasks
            .map((task) => `- [${task.done ? 'x' : ' '}] ${task.title} (due ${task.due})`)
            .join('\n'),
  }
);

await provider.generate({ messages: fitted.messages });
```

The system prompt that reaches the model becomes:

```text
You are a task assistant. Be brief.

[current state]
- [ ] Renew passport (due 2026-10-01)
```

The renderer takes no arguments on purpose: the state belongs to your app, and a closure
reaches any store without threading a generic parameter through the context manager. The
block is idempotent — the previous block is stripped before the new one is appended, so
feeding a result back in replaces it rather than stacking copies. State rendered this way
is always current and costs the same at turn 2 and turn 200, which is strictly better than
hoping it survives in history.

Full guide: [docs/context.md](docs/context.md#the-structured-state-pattern).

### Choosing a context strategy

`fitContext` measures the conversation, computes a budget of
`window - reservedForOutput - safetyMargin`, and trims until it fits. It is pure: you own
your message array, it returns a new one. Two strategies ship, and a third slot takes
your own function.

| Strategy                   | What it does                                                                                                           | Choose it when                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slidingWindow` (default)  | Drops whole oldest turns until the conversation fits. Pinned messages and the newest turn never go.                    | Most apps. Free, deterministic, no extra model call.                                                                                                                        |
| `rollingSummary`           | At 70% of budget, summarizes everything but the newest turns into one `system` message, then keeps trimming if needed. | Long conversations where early context genuinely matters. Costs one model call, and the summarizer is injectable — summarize with the cloud model while chatting on-device. |
| Your own `ContextStrategy` | `(messages, environment) => Promise<FitContextResult>`                                                                 | You have a relevance filter or a domain-specific compaction. Compose it on top of the shipped ones.                                                                         |

The defaults are 512 tokens reserved for output and a safety margin of 64 tokens when
counting is exact, **256 when it is estimated** (D10). The margin is never zero, because
`countTokens` cannot see the schema, tool declarations, or prompt framing the provider
adds at request time.

The truth about unknown windows (D11): when a provider reports `contextWindow: UNKNOWN` —
which every cloud endpoint does unless you configure one — the default is to pass the
conversation through untrimmed with a warning and `withinBudget: 'unknown'`. Trimming to a
guessed limit is guessing; if the request really does overflow, the provider's own
`contextOverflow` carries the real numbers, which beats anything we could have invented.
`onUnknownContextWindow: 'error'` and `assumedContextWindow` are both available when you
want something stricter.

Full guide: [docs/context.md](docs/context.md#choosing-a-strategy).

### Writing a routing policy

A router is itself an `LLMProvider`, so routers compose and nothing downstream needs to
know how many providers sit behind the one it holds. The policy is declarative data with
one narrow escape hatch (D28):

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { createRouter } from '@taaltreelabs/on-device-llm/core';
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';

const apple = createAppleProvider();
const cloud = createOpenAIProvider({
  id: 'cloud',
  baseUrl: 'https://your-endpoint.example.com/v1',
  model: 'your-model',
});

const llm = createRouter({
  providers: [apple, cloud], // preference order, and the fallback order
  policy: {
    preferred: 'apple',
    require: { fitsContextWindow: true },
    tags: {
      reasoning: { preferred: 'cloud' },
      translate: { require: { locale: 'nl' } },
    },
  },
  fallback: { guardrail: false },
  onRoute: (report) => {
    console.log(report.providerId, report.why, report.fellBack, report.attempts);
  },
});

await llm.generate({
  messages: [{ role: 'user', content: 'Explain this proof.' }],
  taskTag: 'reasoning',
});
```

Three rules keep a policy auditable. It chooses a **starting point, not an execution
plan** — fallback order after the first choice is always the configured order. `require`
can only ever **narrow** the field, so "could this policy send a prompt to the cloud?" is
answerable by reading `providers` alone. And `select`, the function escape hatch, outranks
`require` for its own choice, because it was handed the same availability, capability, and
token facts the router used.

The default fallback triggers, verbatim from D30:

| Code                             | Default | Configurable             |
| -------------------------------- | ------- | ------------------------ |
| `unavailable`                    | **on**  | yes                      |
| `contextOverflow`                | **on**  | yes                      |
| `network`                        | **on**  | yes                      |
| `rateLimited`                    | **on**  | yes                      |
| `guardrail`                      | off     | yes                      |
| `unsupportedLocale`              | **on**  | yes                      |
| `unknown` + `transient === true` | **on**  | yes (`unknownTransient`) |
| `unknown`, otherwise             | off     | yes (`unknown`)          |
| `cancelled`                      | never   | **no**                   |
| `invalidRequest`                 | never   | **no**                   |

`cancelled` and `invalidRequest` are not fields on `FallbackTriggers` at all: a boolean
nobody may set to `true` is one that eventually gets set to `true` by accident, so
`{ fallback: { cancelled: true } }` does not compile. The user asked to stop; spending a
second provider's battery and money is the one thing they definitely did not want.

**There is no mid-stream fallback.** The fallback window closes on the first event handed
to the consumer, and events are never pre-buffered to widen it — buffering a stream to
make the router's job easier turns every stream into a non-stream. A response that
switches models halfway through is worse than an error.

**`onRoute` is content-free by construction.** Every field is an id, an enum, a boolean,
or a number: there is no `request`, no `messages`, no message string. A telemetry hook is
the single most likely place for prompt text to leak into a log aggregator, and the only
reliable way to prevent that is not to hand it over. The package never logs or transmits
prompt or response content anywhere.

Full guide: [docs/routing.md](docs/routing.md).

### Structured output

Pass a JSON Schema as `request.schema` and get `result.object`. The supported subset is
deliberately small, and **everything outside it is rejected loudly** as `invalidRequest`,
naming the keyword and its path.

Supported: `object` (with `properties`, `required`, nesting), `array` (`items`,
`minItems`, `maxItems`), `string` (`enum` of strings, `const`, `pattern` — see below),
`integer`/`number` (`minimum`, `maximum`), `boolean`, and non-recursive `$ref` into
`$defs`/`definitions`, which is inlined.

Rejected, each by name and path: `allOf`, `oneOf`, `not`, `if`/`then`/`else`, type unions
such as `type: ['string', 'null']`, recursive `$ref`, tuple `items`/`prefixItems`,
non-string `enum`, `additionalProperties: true`, `minLength`, `maxLength`, `format`,
`multipleOf`, `exclusiveMinimum`, `exclusiveMaximum`, `minProperties`, `maxProperties`,
`uniqueItems`, `patternProperties`, `propertyNames`, `nullable`, and the rest of the
unhonorable set. `pattern` passes the portable normalizer and is rejected by the Apple
encoder specifically, because the framework accepts it at schema-decode time and then
fails at generation.

The reason for the noise is the whole point: a schema that asks for `minLength: 3` and
gets a one-character string back is worse than a schema that was rejected, because you
believe the constraint is in force. Pure annotations (`$schema`, `$id`, `$comment`,
`default`, `deprecated`, `examples`, `readOnly`, `writeOnly`) are dropped, and reported in
`normalizeJsonSchema`'s `dropped` list rather than silently ignored.

Full guide: [docs/structured-output.md](docs/structured-output.md).

### Tool calling

A tool is its definition **and** its handler, together, per request — so "every tool the
model can see has something to run" is checkable before generation starts:

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';

const apple = createAppleProvider({ toolCallTimeoutMs: 30_000 });

const result = await apple.generate({
  messages: [{ role: 'user', content: 'Should I charge my phone soon?' }],
  tools: [
    {
      name: 'getBatteryLevel',
      description: 'Reads the current battery level (0 to 1) and charging state.',
      parameters: { type: 'object', title: 'Args', properties: {}, additionalProperties: false },
      execute: async () => ({ level: 0.42, state: 'unplugged' }),
    },
  ],
});

console.log(result.text);
```

Every tool call has a deadline, 30 seconds by default. A timeout fails the request as
`unknown` with `transient: true`, which the router treats as a fallback trigger; a handler
that throws fails as `unknown` with `transient: false`, which it does not, because app
code that failed deterministically will fail the same way at the next provider. Cancelling
a request resumes every pending tool continuation as well as cancelling generation —
cancelling the task alone would leave the call suspended forever. Handlers also receive an
`AbortSignal` that fires when the request ends, however it ends.

`RequestOptions.onToolCall` is the documented fallback for an app that dispatches every
tool through one function. Note that the `openai` provider reports `tools: false` and
rejects a request carrying tools rather than answering without them.

Full guide: [docs/tools.md](docs/tools.md).

### Writing a custom provider

`LLMProvider` is exported from `core` precisely so third parties can implement it without
living in this repo. Four rules, all normative:

1. **Stateless.** Every request carries the full conversation; hold no conversation state
   between calls.
2. **Never throw at import time.** Resolve native modules lazily inside method bodies, so
   importing your package on the wrong platform reports `unavailable` instead of crashing.
3. **Throw only `LLMError`.** Map every failure onto the taxonomy and run unclassified
   throws through `toLLMError` so the original survives as `cause`. Set `providerId`.
4. **Routers are providers.** `createRouter()` returns an `LLMProvider`, so anything that
   accepts one accepts a router.

`MockProvider` in `core` is the reference implementation and a genuinely useful test
double: script turns, errors, and streams, then assert on `calls`.

Full guide, including the error taxonomy table with when to use each code:
[docs/custom-providers.md](docs/custom-providers.md).

### Streaming on React Native

React Native's built-in `fetch` is a polyfill over `XMLHttpRequest`: `response.body` has no
`getReader()`, so nothing can stream through it. The `openai` provider therefore takes an
injectable `fetch`, resolved lazily on every call, and **you must pass one in an Expo app**
or streaming silently degrades to a single aggregated `textDelta` at the end:

```ts
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';
import { fetch as expoFetch } from 'expo/fetch';

export const cloud = createOpenAIProvider({
  baseUrl: 'https://your-endpoint.example.com/v1',
  model: 'your-model',
  apiKey: process.env.EXPO_PUBLIC_LLM_API_KEY,
  fetch: expoFetch as unknown as typeof fetch,
});
```

The Apple provider is unaffected: it streams over the native event bridge and needs
nothing injected. In bare React Native without the Expo modules runtime, supply your own
WHATWG-compliant streaming `fetch`; the package will not add one, since `core` and
`openai` have zero runtime dependencies.

Full guide: [docs/streaming.md](docs/streaming.md).

## Troubleshooting

### Availability says available but every generation fails

**Symptom.** `availability()` reports `{ available: true }`, `capabilities()` reports
`contextWindow: UNKNOWN` (the framework returned `0`), and every `generate`/`stream` fails
with an `unknown` error whose `cause` mentions `SensitiveContentAnalysisML error 15` or
`ModelManagerError 1013`. Token counting throws too.

**What it is.** The on-device model stack is wedged. This is observed behavior on a
development Mac, not a hypothetical: availability is a check on configuration, not a
health check, which is why the documentation repeats that `available: true` means "nothing
known is blocking", never "the next request will succeed" (D9).

**Remedies, in order of increasing disruption.** Wait — it often clears itself within
minutes. Toggle Apple Intelligence off and back on in Settings. Reboot the device or Mac.
On a Mac, confirm that the model assets are actually present rather than mid-download.

**Why the package behaves the way it does.** Untyped `NSError`s from the native layer map
to `unknown` with `transient: true` rather than crashing the request path, and
`unknownTransient` is a fallback trigger that is **on** by default — so a router with a
cloud provider configured routes around a wedged stack instead of failing the user's turn.
This is the entire reason that lane exists in the taxonomy. If you are running a single
Apple provider with no fallback, you will see the raw error; that is the honest outcome.

### The native module is missing at runtime though the build was green

**Symptom.** The app builds with no errors and no warnings, and then
`createAppleProvider()` reports `unsupportedPlatform` on a device that should support the
model, or `requireNativeModule('OnDeviceLlm')` fails outright.

**Cause.** `expo-modules-autolinking` filters modules by deployment target. The podspec
declares iOS 27.0 (D4). If your app's Podfile platform is lower — the Expo template
default is much lower — `pod install` **silently omits the module entirely**:
`Podfile.lock` has no entry for it, and the build succeeds because nothing referenced it.

**Fix.** Raise `ios.deploymentTarget` to `27.0` (via `expo-build-properties` in
`app.json`, as the example app does), then reinstall pods. Raise the app target's own
`IPHONEOS_DEPLOYMENT_TARGET` too, or the app's Swift fails to compile with _"compiling for
iOS 16.4, but module 'OnDeviceLlm' has a minimum deployment target of iOS 27.0"_. Check
`Podfile.lock` for an `OnDeviceLlm` entry as the confirmation step — a green build is not
one.

### The app crashes at launch with "UIScene life cycle is required"

**Symptom.** A new Expo app builds and installs, then closes immediately on launch — on a
device and in the Simulator alike — with this in the logs:

```text
Application failed to launch: UIScene life cycle is required for apps built with this SDK.
```

**Cause.** Not this package: apps built with the iOS 27 SDK must use UIKit's scene-based
life cycle, and the Expo 57 `prebuild` template still starts React Native from the
`AppDelegate` with no scene. Any Expo 57 app built with Xcode for iOS 27 hits it, with or
without this library (DECISIONS.md D40).

**Fix.** Add the package's config plugin to `app.json` and prebuild again. It applies the
patch below for you (DECISIONS.md D41):

```json
{
  "expo": {
    "plugins": ["@taaltreelabs/on-device-llm"]
  }
}
```

```bash
npx expo prebuild --platform ios --clean
```

The plugin only changes an `AppDelegate.swift` it recognises as Expo's template, and it is
safe to run again. If yours has been customised, `prebuild` prints a warning from
`@taaltreelabs/on-device-llm` and leaves the file alone. Then make these three changes in
`ios/<YourApp>/` by hand — the same ones the [example app](example/ios) carries:

1. In `AppDelegate.swift`, adopt `ExpoReactNativeFactoryProvider` and stop starting React
   Native yourself — build the factory, keep it, and let the scene delegate start it:

   ```swift
   @main
   class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
     var window: UIWindow?

     var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
     var reactNativeFactory: RCTReactNativeFactory?
     var reactNativeFactoryModuleName: String { "main" }

     public override func application(
       _ application: UIApplication,
       didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
     ) -> Bool {
       let delegate = ReactNativeDelegate()
       let factory = ExpoReactNativeFactory(delegate: delegate)
       delegate.dependencyProvider = RCTAppDependencyProvider()

       reactNativeDelegate = delegate
       reactNativeFactory = factory

       // No window and no startReactNative(...) here: SceneDelegate does both.
       return super.application(application, didFinishLaunchingWithOptions: launchOptions)
     }

     // ...the template's Linking and Universal Links overrides stay as they are.
   }
   ```

2. Add a scene delegate. Put it in a new `SceneDelegate.swift` added to the app target, or
   at the bottom of `AppDelegate.swift` so the Xcode project needs no new file:

   ```swift
   class SceneDelegate: ExpoAppSceneDelegate {}
   ```

3. Declare the scene in `Info.plist`:

   ```xml
   <key>UIApplicationSceneManifest</key>
   <dict>
     <key>UIApplicationSupportsMultipleScenes</key>
     <false/>
     <key>UISceneConfigurations</key>
     <dict>
       <key>UIWindowSceneSessionRoleApplication</key>
       <array>
         <dict>
           <key>UISceneConfigurationName</key>
           <string>Default Configuration</string>
           <key>UISceneDelegateClassName</key>
           <string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
         </dict>
       </array>
     </dict>
   </dict>
   ```

Then rebuild (`npx expo run:ios`). A JavaScript reload is not enough, because this is native
code. Without the plugin, `npx expo prebuild --clean` regenerates `ios/` from the template
and discards a hand-applied patch, so re-apply it after a clean prebuild.

### `fm serve` behaves oddly during local development

Apple's `fm` CLI ships a Chat Completions-compatible server that is genuinely useful for
testing this package's `openai` provider from Node against a real model, with no device
and no cloud account. It is a **local development rig only, never a shipping dependency**:
the macOS 27 license text arguably forbids programmatic use in a shipped product, and the
binary is nowhere near the published package (D8). With that said, its quirks:

- **Every response is SSE**, even when the request does not set `stream: true`. The
  `openai` provider detects a `text/event-stream` content type on a non-streaming request
  and parses it anyway.
- **Errors arrive in band**, as a frame inside an otherwise-successful `200` stream,
  rather than as an HTTP status. The provider raises them as `LLMError`s from the
  iterator.
- **It binds to loopback only**, port 1976 by default. A simulator can reach
  `127.0.0.1`; a physical device cannot, and needs the Mac's LAN address — the example app
  derives it from `Constants.expoConfig.hostUri`.
- **`tool_choice` is broken upstream.** Auto mode never populates `tool_calls`, and a
  forced choice is rejected outright. Do not use `fm serve` to test tool calling; use the
  Apple provider and the Swift harness.
- **Recursive `$defs` hang the server permanently**, for every later request too, until
  the process is restarted. The schema normalizer rejects recursive `$ref` before a
  request is ever built, which is one of the things that rejection buys you.
- **`max_tokens` is ignored**, and the context window on the audited build is 4096 tokens.

Integration tests that target `fm serve` skip cleanly when it is not reachable, so a
normal `npm run test` needs nothing running.

### Metro cannot resolve the subpath exports

Metro has resolved `package.json` `exports` by default since React Native 0.79, so on the
supported floor (RN 0.86 / Expo SDK 57) the five entry points resolve with no
configuration. If you have opted out with `unstable_enablePackageExports: false`, turn it
back on; there is no proxy-directory fallback and none is planned.

If you are working against a local checkout the way `example/` does — Metro
`extraNodeModules` pointing at the repo, `watchFolders` including it — watch for the
**nested-resolution trap**: `babel.config.js`'s `require('babel-preset-expo')` walks _up_
out of the app's own `node_modules` and can find an older copy at the repo root, paired
with an older React Native. The symptom is an unrelated-looking transform failure such as
_"Unable to determine event arguments for onModeChange"_, and `expo export` fails outright.
The fix is to add `babel-preset-expo` to the app's own `devDependencies`, pinned to the
version its `expo` depends on, so local resolution wins.

## When not to use this

This package is the layer _above_ the bridge. If you do not want that layer, several good
packages give you the bridge alone, and all of them are MIT-licensed:

- **[`@react-native-ai/apple`](https://github.com/callstackincubator/ai)** — a Vercel AI
  SDK provider, so it plugs into that ecosystem's `generateText`/`streamText` directly. The
  best-maintained of the group, with a real organization behind it. Choose it if AI SDK
  compatibility matters more to you than availability reason codes, pre-flight token
  counting, or capability discovery, none of which the AI SDK spec has a place for.
- **[`expo-foundation-models`](https://github.com/SwiftyJunnos/expo-foundation-models)** —
  an Expo module with the most diagnostic-rich availability surface of the group, real
  locale support, and a documented dual iOS 26/27 path. Choose it if you need iOS 26
  support or single-prompt generation with good diagnostics.
- **[`react-native-foundation-models`](https://github.com/henrypldev/react-native-foundation-models)**
  — a Nitro module with streaming and tool calling, small but carefully engineered. Choose
  it if you are already invested in Nitro. Note that it emits cumulative snapshots rather
  than deltas, so you write the diffing yourself.

Also look elsewhere if:

- **You target iOS below 27.** The floor is deliberate (D4) and there are no compatibility
  paths; on iOS 26 this package reports `unsupportedPlatform` and routes to your cloud
  provider. `expo-foundation-models` handles 26 and 27 side by side.
- **You want embeddings, speech, transcription, image generation, adapter/LoRA loading, or
  retrieval.** All explicitly out of scope, and other packages cover the first three.
- **You want UI components.** Out of scope. The example app is a manual test rig, not a
  component library.
- **You only ever call a cloud model.** You do not need a router or an on-device provider;
  use your vendor's SDK. The context manager alone might still be worth importing from
  `core`.

### Android on-device?

This package ships cloud routing on Android out of the box (the `openai` provider works
anywhere a modern JavaScript runtime does), but no on-device Android provider. That lives
in a separate, separately-named companion package:
[`@taaltreelabs/on-device-llm-android`](https://github.com/taaltreelabs/on-device-llm-android),
which wraps Gemini Nano via Google's ML Kit GenAI APIs behind the same `LLMProvider`
contract, so it drops into the same router as a provider like any other. It is packaged
separately, rather than folded into this one, because ML Kit's terms include metrics
telemetry sent to Google and a pass-through disclosure duty to your own users — an
asterisk that this package's "on-device and private" story should not silently absorb.
It is pre-release and device-allowlisted; read that repo's own README before relying on
it.

## Development

```text
src/core/      types, provider interface, error taxonomy, context manager, router, MockProvider
src/openai/    Chat Completions-compatible provider
src/apple/     TypeScript half of the native provider
src/react/     hooks
ios/           Swift: OnDeviceLlmModule.swift (Expo glue) + Core/ (FoundationModels logic)
android/       reserved for the Android stretch goal
harness/       Swift package that exercises the framework directly against the live model
example/       Expo dev-client app used as the manual test rig
scripts/       check-isolation, fm acceptance
docs/          this documentation, plus the Phase 0 research under docs/research/
```

The gates, all runnable with no device:

```bash
npm run build          # tsc to build/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint, including the core/openai isolation rule
npm run test           # vitest; integration tests skip when fm serve is unreachable
npm run check:isolation # walks the built import graph for react/react-native/expo/native
npm run check:pack     # verifies the published tarball's contents
```

Two more need real hardware or a real server:

- **`npm run harness:apple`** — a Swift package (`harness/`) that drives FoundationModels
  directly, outside React Native, and asserts against the live model: transcript
  round-trips, snapshot-to-delta conversion, cancellation, prewarming, token counting, the
  supported/unsupported schema constraint matrix, and a full tool round trip with a timeout
  and a mid-call cancel. Needs macOS 27 and a healthy model; it skips rather than fails
  when availability is `available` but generation is wedged (D9). This is the regression
  test for a future OS widening or narrowing what the framework supports.
- **`npm run acceptance:fm`** — the Phase 1 acceptance script: a plain Node script
  importing only the **built** `core` and `openai` entry points, holding a multi-turn
  conversation with `fm serve`, streaming and non-streaming, and cancelling mid-stream. Run
  `npm run build` first. Exit code `2` means `fm serve` was unreachable and nothing was
  tested, which is the expected result when it is not running.

The example app (`example/`) is an Expo dev-client rig with a provider toggle
(`MockProvider` or the real router), a "simulate on-device unavailable" switch that moves
the conversation to the cloud provider on the next turn with history intact, a
structured-output demo, and a tool round-trip demo. It needs `npx expo run:ios` and an iOS
deployment target of 27.0.

## License

MIT. See [LICENSE](LICENSE).
