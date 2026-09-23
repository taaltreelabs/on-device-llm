# Streaming on React Native

Streaming works differently for the two shipped providers, and one of them needs a line of
setup that is easy to miss because **the failure mode is silence, not an error**.

- [The short version](#the-short-version)
- [Why React Native's fetch cannot stream](#why-react-natives-fetch-cannot-stream)
- [Injecting expo/fetch](#injecting-expofetch)
- [Bare React Native, and Node](#bare-react-native-and-node)
- [Consuming a stream](#consuming-a-stream)
- [Cancellation](#cancellation)
- [Snapshots, deltas, and the reset flag](#snapshots-deltas-and-the-reset-flag)

## The short version

| Provider | How it streams | What you must do |
| --- | --- | --- |
| `apple` | Over the native event bridge | Nothing |
| `openai` | SSE over `fetch` | **Inject a streaming `fetch`.** In Expo, `expo/fetch`. |

## Why React Native's fetch cannot stream

React Native's built-in `fetch` is a polyfill over `XMLHttpRequest`, not a native fetch.
`Response.body` does not implement `ReadableStream`, so `response.body.getReader()` is
unavailable. This is a long-standing, still-open limitation, and it silently breaks every
cloud LLM client that reaches for a reader.

The `openai` provider checks for a readable body rather than assuming one. When there is
none, it reads the whole response and emits **one aggregated `textDelta`** followed by
`finish`. The request succeeds, the text is correct, and nothing streams — which is why
this is worth a page of documentation rather than a footnote. If your assistant UI renders
all at once after a long pause, this is why.

## Injecting expo/fetch

`expo/fetch` is the WinterCG-compliant fetch that does support streaming via
`getReader()`, and it is the documented way to get token-by-token delivery in an Expo app.

```ts
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';
import { fetch as expoFetch } from 'expo/fetch';

export const cloud = createOpenAIProvider({
  baseUrl: 'https://your-endpoint.example.com/v1',
  model: 'your-model',
  apiKey: process.env.EXPO_PUBLIC_LLM_API_KEY,
  // The cast is needed because expo/fetch's types are structurally close to,
  // but not identical to, the DOM lib's `fetch`.
  fetch: expoFetch as unknown as typeof fetch,
  contextWindow: 128_000,
});
```

The `fetch` you pass is resolved **lazily on every call**, not captured at construction. An
app that has not finished setting up its fetch when the provider is built — or that wants
to swap it later, for a test or an interceptor — would otherwise be frozen onto whatever
`globalThis.fetch` was at module-evaluation time.

`expo/fetch` is the right tool and is not bulletproof; it has had regressions where
streaming batched all chunks into one, and where backgrounding the app mid-stream killed
an in-flight request. Verify it against the SDK your app actually targets rather than
assuming.

## Bare React Native, and Node

In bare React Native without the Expo modules runtime, supply your own WHATWG-compliant
streaming `fetch`. This package will not add one: `core` and `openai` have zero runtime
dependencies, and that is what lets them be imported from plain Node and audited in one
pass.

Under Node, `globalThis.fetch` streams correctly and nothing needs injecting — which is
what makes the `fm serve` integration tests and `npm run acceptance:fm` possible with no
device and no bundler.

## Consuming a stream

```ts
import type { LLMProvider, Message } from '@taaltreelabs/on-device-llm/core';

export async function ask(
  provider: LLMProvider,
  messages: readonly Message[],
  onDelta: (text: string) => void
): Promise<string> {
  let finalText = '';

  for await (const event of provider.stream({ messages })) {
    switch (event.type) {
      case 'textDelta':
        onDelta(event.delta); // only the new characters, never the accumulation
        break;
      case 'finish':
        finalText = event.result.text; // authoritative
        break;
      default:
        break; // ignore event types you do not recognize
    }
  }

  return finalText;
}
```

Three contract points:

- **`textDelta` carries deltas**, never accumulated text. That is the convention of Chat
  Completions, of UI code, and of this package; the Apple provider converts, because the
  framework yields cumulative snapshots.
- **Exactly one `finish` ends a successful stream**, carrying the same `GenerateResult`
  that `generate()` would have produced — so a consumer reads `finishReason`, `usage`, and
  `providerId` without a second call.
- **Failures throw out of the iterator** rather than arriving as an event. Wrap the
  `for await` in `try`/`catch`; `finish` never arrives for a failed or cancelled stream, so
  there is no "final" text to fall back to.

`useChat` does all of this for you and exposes the in-flight text as `streamingText`. It
deliberately leaves partial text on screen after an error or cancellation — discarding
text a user has already watched stream in is worse than leaving it there — and clears it
on the next `send()` or `reset()`.

## Cancellation

Pass an `AbortSignal` in `RequestOptions`, or use `useChat`'s `stop()`. Aborting must stop
real work, not merely stop forwarding events, and it surfaces as an `LLMError` with code
`cancelled` whether the signal was already aborted at call time or fires mid-flight.

For the Apple provider this required an explicit check that the framework does not do for
you: a cancelled `respond()` throws promptly, but a cancelled response **stream** does not
— the loop simply ends. The first implementation therefore reported a perfectly ordinary
`finish` for a generation the caller had stopped. Cancellation is now checked after the
loop as well as inside it, including the race where native finishes normally between
`abort()` firing and the cancel landing.

Breaking out of a `for await` early also counts as cancellation as far as a router's
telemetry is concerned, and it closes the router's fallback window like any other yielded
event.

## Snapshots, deltas, and the reset flag

Apple's `ResponseStream` yields cumulative snapshots, so the native bridge diffs them.
In the normal case each snapshot extends the last and the deltas concatenate exactly to
the final text — asserted against the live model in the Swift harness.

A snapshot that is **not** an extension means the model rewrote text already handed to the
consumer, and a delta stream physically cannot retract it. Of the three possible policies —
stall the stream and freeze the UI mid-sentence, re-emit the whole snapshot and duplicate
far more text, or emit only what is new past the longest common prefix — the last is what
happens, flagged `reset` on the wire.

The consequence for a consumer: **`finish.result.text` is authoritative**, and it is always
the last snapshot rather than the concatenation of the deltas. A UI that renders deltas
live and then swaps in the final text always converges. This has never been observed for
text generation; it is a guard, not a workaround, surfaced rather than swallowed so the
case stays observable if the framework's behavior ever changes.
