# Writing a custom provider

`LLMProvider` and the error taxonomy are exported from
`@taaltreelabs/on-device-llm/core` precisely so that third parties can implement new
providers without living in this repo. A custom provider drops into `createRouter` next
to the shipped ones and works with `fitContext` and the hooks unchanged.

- [The contract](#the-contract)
- [The interface](#the-interface)
- [A minimal provider](#a-minimal-provider)
- [The error taxonomy](#the-error-taxonomy)
- [MockProvider as a reference and a test double](#mockprovider-as-a-reference-and-a-test-double)

## The contract

Four rules, all normative rather than advisory.

1. **Stateless.** Every request carries the full conversation; hold no conversation state
   between calls. Native session objects may be cached as an optimization, but only when
   the incoming messages are exactly the cached history plus one new turn. If providers
   own state, the context manager cannot trim history, the router cannot move a
   conversation between providers mid-conversation, and every provider reimplements the
   same bookkeeping.
2. **Never throw at import time.** Resolve native modules lazily inside method bodies, in
   a `try`/`catch`, so importing your package on Android, on web, or under Node works and
   simply reports `unavailable` / `unsupportedPlatform`.
3. **Throw only `LLMError`.** Map every failure onto the taxonomy, and run unclassified
   throws through `toLLMError` so the original is preserved as `cause`. Set `providerId`
   to your provider's `id`.
4. **Routers are providers.** `createRouter()` returns an `LLMProvider`, so anything that
   takes one takes a router, and callers cannot tell how many providers sit behind the one
   they hold.

Two smaller obligations follow from how the rest of the package uses the interface:

- **`capabilities()` must not throw for a merely unavailable provider.** Report the
  best-known capabilities, with `UNKNOWN` where honest, and let `availability()` carry the
  bad news.
- **`countTokens` should throw rather than guess** when the underlying call fails. The
  context manager catches exactly that and widens its safety margin from 64 tokens to 256.
  A silent estimate keeps the narrow margin under an exact-looking number, which is how a
  "measured" budget overflows.

## The interface

```ts
import type {
  Availability,
  Capabilities,
  GenerateRequest,
  GenerateResult,
  Message,
  RequestOptions,
  StreamEvent,
} from '@taaltreelabs/on-device-llm/core';

export interface Sketch {
  readonly id: string;
  availability(): Promise<Availability>;
  capabilities(): Promise<Capabilities>;
  countTokens?(messages: readonly Message[]): Promise<number>;
  prewarm?(messages?: readonly Message[]): Promise<boolean>;
  generate(request: GenerateRequest, options?: RequestOptions): Promise<GenerateResult>;
  stream(request: GenerateRequest, options?: RequestOptions): AsyncIterable<StreamEvent>;
}
```

| Member | Notes |
| --- | --- |
| `id` | Short, lowercase, unique within an app. It appears on every `GenerateResult` and `LLMError` and is the only handle a policy, a report, or a test has on you, so keep it stable across versions. |
| `availability()` | Cheap enough to call on app start and on foreground. `available: true` means "nothing known is blocking", never "the next request will succeed". |
| `capabilities()` | May touch the network or a native layer, hence async. |
| `countTokens` | Present **iff** `capabilities().tokenCounting !== 'none'`. Counts *messages*, not a string, because per-message framing overhead is provider-specific and only you know it. |
| `prewarm` | A hint, not a contract: resolve `true` when the hint was delivered, `false` when there was nothing to prewarm. Never throws, and it deliberately makes no performance claim. Unlike `generate`, the messages need not end with a user turn — the case it is for is a screen that has opened and a user who has not finished typing. |
| `generate` | Rejects with an `LLMError` on any failure. |
| `stream` | Returns the iterable **synchronously**, not a promise, so callers can wire it up without an extra `await` and so validation happens at call time. Work should not start until iteration begins. |

**Stream shape.** The last event of a successful stream is exactly one `finish`, carrying
the same `GenerateResult` that `generate()` would have produced. Failures throw out of the
iterator rather than arriving as an event — that is what `for await` plus `try` already
handles, and it makes "the stream failed" impossible to ignore. `textDelta` carries only
the new characters, never the accumulated text; if your backend yields cumulative
snapshots, diff them.

A provider whose backend cannot stream may emit a single `textDelta` followed by `finish`,
but must then report `capabilities().streaming === false` so callers can choose not to
pretend.

## A minimal provider

```ts
import {
  estimateTokens,
  toLLMError,
  LLMError,
  UNKNOWN,
  type Availability,
  type Capabilities,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type Message,
  type RequestOptions,
  type StreamEvent,
} from '@taaltreelabs/on-device-llm/core';

export class EchoProvider implements LLMProvider {
  readonly id = 'echo';

  async availability(): Promise<Availability> {
    return { available: true };
  }

  async capabilities(): Promise<Capabilities> {
    return {
      contextWindow: 8192,
      streaming: true,
      structuredOutput: false,
      tools: false,
      tokenCounting: 'estimated',
      locales: UNKNOWN,
      modelLabel: 'echo',
    };
  }

  async countTokens(messages: readonly Message[]): Promise<number> {
    return estimateTokens(messages);
  }

  async generate(request: GenerateRequest, options?: RequestOptions): Promise<GenerateResult> {
    try {
      options?.signal?.throwIfAborted();
      if (request.schema !== undefined) {
        throw new LLMError(
          { code: 'invalidRequest' },
          { providerId: this.id, message: 'echo does not support structured output' }
        );
      }
      const last = request.messages[request.messages.length - 1];
      return { text: last?.content ?? '', finishReason: 'stop', providerId: this.id };
    } catch (error) {
      // Converts an AbortError into `cancelled` and anything else into
      // `unknown`, preserving the original as `cause`.
      throw toLLMError(error, { providerId: this.id });
    }
  }

  async *stream(
    request: GenerateRequest,
    options?: RequestOptions
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const result = await this.generate(request, options);
    for (const word of result.text.split(' ')) {
      options?.signal?.throwIfAborted();
      yield { type: 'textDelta', delta: `${word} ` };
    }
    yield { type: 'finish', result };
  }
}
```

Three details in there are the ones worth copying. `stream` is an async generator, so it
returns its iterable synchronously and does no work until the first `next()`. Every abort
path goes through `toLLMError`, so a `DOMException` from `fetch` or
`AbortSignal.throwIfAborted()` surfaces as `cancelled` rather than as `unknown`. And the
`finish` event carries the same result `generate()` would have returned, so a consumer
never needs a second call to learn the `finishReason` or the `providerId`.

## The error taxonomy

One class, `LLMError`, discriminated on `details.code`. There is no class hierarchy and no
`instanceof` ladder: `catch (e) { if (isLLMError(e)) … }` is the whole story, and
`isLLMError` uses a non-enumerable brand rather than `instanceof`, so it keeps working
across two copies of the package in one dependency tree or an error crossing a bundle
boundary.

```ts
import { LLMError } from '@taaltreelabs/on-device-llm/core';

export const example = new LLMError(
  { code: 'contextOverflow', contextSize: 4096, tokenCount: 5200 },
  { providerId: 'apple', cause: new Error('native: ContextSizeExceeded') }
);
```

| Code | Use it when | Payload | Router falls back by default |
| --- | --- | --- | --- |
| `unavailable` | The provider cannot serve requests at all. Same reason `availability()` would report. | `reason` (`deviceNotEligible`, `notEnabled`, `modelNotReady`, `unsupportedPlatform`) | Yes |
| `contextOverflow` | The request did not fit the window. Include the real numbers if your backend reports them — the context manager uses them to correct a bad estimate. | `contextSize?`, `tokenCount?` | Yes |
| `guardrail` | A safety guardrail blocked the request or response. | — | **No** |
| `unsupportedLocale` | The model does not support the language of the request. Never an availability reason. | `locale?` | Yes |
| `rateLimited` | Too many requests. | `resetDate?` (an absolute `Date`, resolved from `Retry-After` if that is what you have) | Yes |
| `cancelled` | An `AbortSignal` fired. **Every** abort path must surface as this, including the `DOMException` that `fetch` raises. | — | Never (not configurable) |
| `network` | Transport failure talking to a remote provider. | `status?` | Yes |
| `invalidRequest` | The request is wrong and will fail again unchanged: an unsupported schema construct, an unrecognized role, a conversation that does not end with a user message, a sampling option you have no equivalent for. | — | Never (not configurable) |
| `unknown` | Everything else. Always construct it with the original error as `cause`. | `transient?` | Only when `transient === true` |

**`transient` is the field to get right.** `true` means "retrying or failing over may
work" — a system-level hiccup, a timeout, a wedged model manager. `false` means "this will
fail again" — app code that threw deterministically. `undefined` means you genuinely do not
know, and is treated like `false`, because treating "don't know" as retryable makes every
mystery failure cost two generations and two bills.

`LLMErrorOptions` takes `message`, `providerId`, and `cause`. **The message must never
contain prompt or response content**: it ends up in logs, and this package's guarantee is
that content does not.

`toLLMError(error, { providerId })` is the catch-all: it passes an existing `LLMError`
through, converts an abort into `cancelled`, and wraps anything else as `unknown` with the
original as `cause`. `isAbortError` is exported too, for the cases where you want to branch
before wrapping.

Adding a code later is a semver-minor change for callers that use `switch` with a
`default`, which is the documented way to consume the union. `timeout`, `refusal`, and
`parseError` are the ones most likely to be added when something branches on them; until
then the honest mappings are `unknown`, `guardrail`, and `invalidRequest`.

## MockProvider as a reference and a test double

`MockProvider` is a complete, readable implementation of the interface and a genuinely
useful test double. It replays a queue of scripted turns and records every call:

```ts
import { estimateTokens, LLMError, MockProvider } from '@taaltreelabs/on-device-llm/core';

export async function demo(): Promise<void> {
  const provider = new MockProvider({
    id: 'mock',
    capabilities: { contextWindow: 320 },
    countTokens: estimateTokens,
    turns: [
      { type: 'stream', chunks: ['Hello', ' there'] },
      { type: 'error', error: new LLMError({ code: 'network', status: 503 }) },
    ],
  });

  for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    if (event.type === 'textDelta') process.stdout.write(event.delta);
  }

  // Append more turns at any time; a chat rig needs to keep answering.
  provider.script({ type: 'result', text: 'done', delayMs: 10 });

  console.log(provider.calls.length);
}
```

Turn kinds are `result` (text, `object`, `finishReason`, `usage`, `delayMs`), `error`
(thrown as-is, so a test asserts on exactly what it scripted), and `stream` (`chunks`, an
optional trailing `error` to fail mid-response, and an optional `object` emitted as an
`objectSnapshot` just before `finish`). `countTokens` takes a number, a function, or an
`LLMError` to throw — the last reproduces a provider whose counter fails, which is how the
context manager's margin-widening path gets tested. Omit it entirely and the provider has
no `countTokens` method at all and reports `tokenCounting: 'none'`.

`delayMs` exists so a test can abort mid-call: the scripted sleep loses to an
`AbortSignal`, so aborting during a delay rejects immediately rather than after it.
