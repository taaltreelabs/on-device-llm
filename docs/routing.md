# Writing a routing policy

`createRouter({ providers, policy })` returns something that itself implements
`LLMProvider`. Routers compose, and nothing downstream — not `useChat`, not
`fitContext`, not your own code — can tell whether it is holding one provider or five.

- [The shape of a policy](#the-shape-of-a-policy)
- [What a policy sees](#what-a-policy-sees)
- [Fallback triggers](#fallback-triggers)
- [When every provider fails](#when-every-provider-fails)
- [Streaming](#streaming)
- [Telemetry, and the privacy guarantee](#telemetry-and-the-privacy-guarantee)
- [Caching and staleness](#caching-and-staleness)
- [What the router reports about itself](#what-the-router-reports-about-itself)

## The shape of a policy

A policy is either a `RoutePolicyRules` object or a function
`(context) => providerId | undefined`, which is shorthand for `{ select: fn }`.

Both exist for a reason each. The object form is inspectable, serializable, diffable in a
review, and testable from a literal without running anything — which is what a rule that
decides where a user's words go ought to be. The function form exists because no fixed
vocabulary survives contact with a real app, and the alternative to an escape hatch is a
config language that grows one field per user.

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { createRouter } from '@taaltreelabs/on-device-llm/core';
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';

const apple = createAppleProvider({ locale: 'nl-NL' });
const cloud = createOpenAIProvider({
  id: 'cloud',
  baseUrl: 'https://your-endpoint.example.com/v1',
  model: 'your-model',
  contextWindow: 128_000,
});

export const llm = createRouter({
  providers: [apple, cloud],
  policy: {
    // A preference, not a requirement: if it is not eligible, configured order wins.
    preferred: 'apple',
    // A constraint. Can only ever narrow the field.
    require: { fitsContextWindow: true },
    // Per-task-tag overrides, keyed by GenerateRequest.taskTag.
    tags: {
      reasoning: { preferred: 'cloud' },
      translate: { require: { locale: 'nl' } },
    },
    // An arbitrary extra constraint.
    where: (candidate) => candidate.id !== 'cloud' || candidate.availability.available,
    // The escape hatch. Returning undefined defers to the rules above.
    select: (context) => (context.estimatedTokens > 3_000 ? 'cloud' : undefined),
  },
});
```

Three constraints on the shape are load-bearing:

1. **The policy chooses a starting point, not an execution plan.** Fallback order after
   the first choice is always the configured order. A policy that returned an ordering
   could silently reinvent — or disable — the fallback machinery, and the `attempts` chain
   would stop being comparable between requests.
2. **`require` can only ever narrow the field.** A constraint may make the router run out
   of providers; it can never send a request somewhere it would not otherwise have sent
   one. That makes "could this policy leak a prompt to the cloud?" answerable by reading
   `providers` alone.
3. **`select` outranks `require` for its own choice, and an unknown id is ignored.** An
   explicit choice beats a declarative filter — and the function was handed availability,
   capabilities, and token counts, so it could have checked. An id naming no configured
   provider falls through to the rules rather than failing the request.

### `require`

| Field | Default | Effect |
| --- | --- | --- |
| `available` | `true` | Skip providers reporting `available: false`. Turning it off is meaningful rather than perverse: availability has been observed wrong in the optimistic direction (D9), and an app that has seen it wrong in the pessimistic direction can force the attempt and let the `unavailable` fallback trigger sort it out. |
| `fitsContextWindow` | `true` | Skip providers whose *known* window cannot hold the request. An `UNKNOWN` window never fails it. |
| `minContextWindow` | — | Require a known window of at least this size. `UNKNOWN` **does** fail this one. |
| `streaming`, `structuredOutput`, `tools` | — | Require the capability flag. |
| `tokenCounting` | — | Require one of `'exact' \| 'estimated' \| 'none'`. |
| `locale` | — | Require the BCP-47 tag to appear in `capabilities().locales`, matched on the language subtag (`'nl-BE'` is satisfied by `'nl'`). `UNKNOWN` locales never fail it — most cloud endpoints cannot enumerate what they speak, and refusing them all for not answering an unanswerable question is worse than trying. |

Skips are reported in telemetry as `skipped:unavailable`, `skipped:contextWindow`,
`skipped:capability`, `skipped:locale`, and `skipped:policy`, so you can tell "the
on-device model was busy" from "the on-device model could never have served this request".

### The task tag

`GenerateRequest.taskTag` is a free-form string — `'simple'`, `'reasoning'`,
`'translate'`, whatever vocabulary your app routes on. It lives on the request rather than
on `RequestOptions` (D29) because it is plain serializable data that should survive being
stored, replayed, logged as metadata, and threaded through the context manager and the
hooks alongside the messages it describes, whereas `RequestOptions` holds the things that
cannot be serialized and change on every invocation.

**Every provider must ignore `taskTag`, and must not reject a request for carrying one.**
A routed request arrives at its provider with the tag still attached.

## What a policy sees

Predicates receive a `RouteCandidate` and a `RoutePolicyContext`. The candidate facts are
exactly the facts the router used, so a predicate never re-derives them and never pays for
the native calls twice:

| `RouteCandidate` field | |
| --- | --- |
| `provider`, `id`, `index` | The provider, its id, and its position in configured order (`0` is most preferred). |
| `availability` | What `availability()` reported (cached). |
| `capabilities` | What `capabilities()` reported (cached). A provider whose `capabilities()` rejected is described conservatively: everything `false`/`UNKNOWN`. |
| `tokens`, `tokenSource` | The request's cost as measured for *this* provider, and whether it came from the provider's own `countTokens()` or from `estimateTokens`. |
| `fitsContextWindow` | `true`, `false`, or `'unknown'`. |

`RoutePolicyContext` adds `request`, `taskTag`, `estimatedTokens` (the
provider-independent baseline), and `candidates`.

**The context-window check.** `estimateTokens` is computed once per request as the
baseline; a provider's own `countTokens()` is called only when it has one *and* a known
`contextWindow` — the only case where an exact number can change the decision. An
`UNKNOWN` window is not a disqualifier (D11): every cloud endpoint is in that state,
refusing them all would be worse than trying, and a provider that cannot describe its
window still reports a real `contextOverflow` with real numbers. `maxOutputTokens` is
counted against the same window, because Apple's `contextSize` is a combined input+output
budget. No safety margin is applied here — that is `fitContext`'s job, and a router that
applied its own would skip providers twice over.

`context.request` contains prompt content. A policy must never log it.

## Fallback triggers

| Code | Default | Configurable |
| --- | --- | --- |
| `unavailable` | **on** | yes |
| `contextOverflow` | **on** | yes |
| `network` | **on** | yes |
| `rateLimited` | **on** | yes |
| `guardrail` | off | yes |
| `unsupportedLocale` | **on** | yes |
| `unknown` + `transient === true` | **on** | yes (`unknownTransient`) |
| `unknown`, otherwise | off | yes (`unknown`) |
| `cancelled` | never | **no** |
| `invalidRequest` | never | **no** |

- **`cancelled` and `invalidRequest` are not fields on `FallbackTriggers` at all.** A
  boolean nobody may set to `true` is a boolean that eventually gets set to `true` by
  accident, so the prohibition lives in the type — `{ fallback: { cancelled: true } }` does
  not compile — and the runtime asserts it independently. `cancelled` means the caller
  asked to stop, and spending a second provider's money and battery is the one thing they
  definitely did not want. `invalidRequest` will be just as invalid at the next provider: a
  rejected schema construct is rejected everywhere, and a conversation that does not end
  with a user message still does not.
- **`rateLimited` is on.** Failing over is not retrying: `resetDate` may be minutes away,
  the limit belongs to *that* provider, and a second provider is precisely the thing that
  makes a rate limit survivable.
- **`unsupportedLocale` is on.** A capability gap, not a malfunction. Apple enumerates 24
  locales and a cloud model usually covers the rest, so falling back is what a
  Polish-speaking user wants. It is switchable because it does mean the prompt leaves the
  device — the same trade `unavailable` already makes by default.
- **`guardrail` is off.** A guardrail is a decision, not a malfunction; routing around it
  sends content one model refused to another, usually off-device. That is a policy choice
  an app must make deliberately rather than inherit.
- **`unknown` is split in two.** `transient: true` is a provider saying "this may work
  elsewhere or later" — a wedged model manager, a tool-call timeout — which is the exact
  signal a router exists to act on, so it is on. `transient: false` is a deterministic
  failure in app code (a tool handler that threw) and must not be retried.
  `transient: undefined` is a provider that does not know; treating "don't know" as
  retryable makes every mystery failure cost two generations and two bills, so `undefined`
  shares the `false` switch and is off by default.
- **An unrecognized future code does not fall back.** A failure nobody has classified
  should propagate until someone decides what it means.

```ts
import { createRouter, type LLMProvider } from '@taaltreelabs/on-device-llm/core';

export function buildRouter(providers: readonly LLMProvider[]) {
  return createRouter({
    providers,
    fallback: {
      // Let a refusal reach the user rather than shopping it around. (Already the default.)
      guardrail: false,
      // This app's providers are unrelated enough that a mystery failure is worth a retry.
      unknown: true,
    },
  });
}
```

### One shot per provider

A provider is tried **at most once per request**. Same-provider retry needs backoff,
jitter, and a budget, all of which belong to the caller who knows whether this is a
background summarization or a user watching a spinner — and a router that retried
internally would make `attempts` useless as a telemetry signal.

## When every provider fails

The router **rethrows the last real `LLMError`, verbatim, with the failing provider's own
`providerId`**. There is no `RouterExhaustedError`: `errors.ts` exists precisely so that
there is one error class and no `instanceof` ladder, and a new class would break every
`catch (e) { if (isLLMError(e)) … }` written against it. The attempt chain is not lost —
it goes to `onRoute`, which is where telemetry belongs and where it cannot tempt anyone
into control flow.

A synthetic error is constructed only when **no provider was asked at all**:

| Situation | Error |
| --- | --- |
| Every skip was an availability skip | `unavailable`, with the most hopeful aggregated reason and a `detail` listing every provider's verdict |
| A window skip was involved | `contextOverflow`, carrying the real window and the measured tokens |
| Otherwise | `invalidRequest` — a `require` block no provider can satisfy is a request that will fail again unchanged |

"Most hopeful" is deliberate: `modelNotReady` beats `notEnabled` beats
`deviceNotEligible` beats `unsupportedPlatform`, because "the model is still downloading"
tells a user something to do and "this platform has no such thing" does not.

## Streaming

**The fallback window closes on the first event handed to the consumer.** Events are
forwarded as they arrive and are never pre-buffered to widen that window — buffering a
stream to make the router's job easier turns every stream into a non-stream, which is the
thing streaming exists to avoid. A response that switches models halfway through is worse
than an error.

`toolCall` counts as a yielded event: by the time a consumer sees one, a handler the app
wrote has already run, and a second provider would run it again.

A consumer that breaks out of its `for await` is recorded as `cancelled`, not as a
success.

## Telemetry, and the privacy guarantee

`onRoute` is called exactly once per `generate()` and once per `stream()`, with a
`RouteReport`:

```ts
import { createRouter, type LLMProvider, type RouteReport } from '@taaltreelabs/on-device-llm/core';

export function routerWithTelemetry(
  providers: readonly LLMProvider[],
  track: (event: string, payload: Record<string, unknown>) => void
) {
  return createRouter({
    providers,
    onRoute: (report: RouteReport) => {
      track('llm_route', {
        requestId: report.requestId,
        providerId: report.providerId,
        why: report.why,
        fellBack: report.fellBack,
        attempts: report.attempts.map((attempt) => ({
          providerId: attempt.providerId,
          outcome: attempt.outcome,
          durationMs: attempt.durationMs,
        })),
      });
    },
  });
}
```

`RouteReport` is **content-free by construction**. Every field is an id, an enum, a
boolean, or a number. There is deliberately no `request`, no `messages`, no `error`, and
no message string: a telemetry hook is the single most likely place for prompt text to
leak into a log aggregator, and the only reliable way to prevent that is not to hand it
over.

More broadly: **the package never logs or transmits prompt or response content.** It has
no analytics, no crash reporting, no network calls of its own. The only places your
content goes are the providers you configured, and the only thing that decides which one
is the policy you wrote.

`why` is one of `'order'` (first eligible provider in configured order), `'preferred'`,
`'tag'`, `'policy'` (a `select` function named it), `'fallback'` (an earlier provider
failed and this one picked the request up), or `'exhausted'` (nobody answered). An
attempt's `outcome` is `'ok'`, an `LLMErrorCode`, or `skipped:<reason>`. `durationMs` is
`0` for a skip, because the introspection a skip rests on is shared and cached, so
charging it to one provider would be a lie.

`onRoute` must not throw; if it does, the router swallows it.

## Caching and staleness

Routing reads `availability()` and `capabilities()` through a per-provider TTL cache —
`cacheTtlMs`, default 5000 ms, `0` disables it, and concurrent lookups share one in-flight
promise. Three providers behind an uncached router is six native round trips before a
single token.

The staleness is safe in the direction that matters: `available: true` never meant "the
next request will succeed" (D9), so a stale `true` costs nothing a fresh one would not —
the failure is what the fallback chain is for. A stale `false` can pass over a provider
that just became usable, which is bounded by the TTL, self-correcting, and strictly less
costly than the alternative.

The router's own `availability()` and `capabilities()` always refresh and reprime the
cache, so they double as the "check now" call and as the invalidation hook
`useAvailability` needs.

## What the router reports about itself

A router is an `LLMProvider`, so it has to answer the same questions its providers do.

**`availability()`** is available iff **any** provider is. A router's job is to find a
working provider; reporting the preferred one would have a perfectly functional router
claim to be broken because a model is still downloading. When none is available, the
reason is the aggregated one and `detail` lists every provider's verdict.

**`capabilities()`** returns the **preferred available provider's** capabilities verbatim,
never a merge. A merge is a lie in both directions: union the booleans and the router
claims tool calling the chosen provider cannot do; intersect them and it denies structured
output the chosen provider supports perfectly well, so callers stop asking for it; take
the largest `contextWindow` and the context manager budgets 128K for a request about to go
to a 4K on-device model.

**`countTokens` and `prewarm` are optional per instance**, so their presence is decided
once at construction — present iff *some* configured provider has it — because a method
cannot appear later just because a provider came back, and a caller that captured
`router.countTokens` must not find it gone. Which provider serves the call is decided per
call. When no available provider can count, `countTokens` **throws** rather than
estimating, which is what lets the context manager notice and widen its safety margin from
64 tokens to 256. `prewarm` never throws and answers `false` when there is nothing to
warm.
