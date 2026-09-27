# Import paths and Node.js usage

[Back to the README](../README.md)

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
