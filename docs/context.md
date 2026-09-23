# Managing the context window

The on-device model's window is small — 4K tokens on the older variant, 8K on the newer
one — and the framework treats an overflow as an error, not as a truncation. This is the
part of the package that exists to make that rare.

Everything here is a pure function in `@taaltreelabs/on-device-llm/core`, usable from
plain Node. You own your message array; `fitContext` never mutates it and holds nothing
between calls.

- [The structured-state pattern](#the-structured-state-pattern)
- [How the budget is computed](#how-the-budget-is-computed)
- [Choosing a strategy](#choosing-a-strategy)
- [What survives trimming](#what-survives-trimming)
- [Unknown context windows](#unknown-context-windows)
- [Reading the result](#reading-the-result)

## The structured-state pattern

This is the first thing to reach for in a purpose-built app, ahead of any trimming
strategy.

A chat history is a poor database. If your app has state the model needs — a task list, a
shopping cart, the document currently open, the step of a flow the user is on — do not
hope the model remembers it from twenty turns ago, and do not pay for those twenty turns
to stay in the window. Render the state, freshly, into the system prompt on every request.
It is then always current, always exactly as long as the state is, and it costs the same
whether the conversation is two turns old or two hundred. History becomes what it should
be: recent phrasing and intent, which is exactly the part that is cheap to trim.

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { fitContext, type Message } from '@taaltreelabs/on-device-llm/core';

interface Task {
  readonly title: string;
  readonly done: boolean;
  readonly due?: string;
}

const provider = createAppleProvider();

function renderTasks(tasks: readonly Task[]): string {
  if (tasks.length === 0) return 'No open tasks.';
  return tasks
    .map((task) => `- [${task.done ? 'x' : ' '}] ${task.title} (due ${task.due ?? 'unset'})`)
    .join('\n');
}

export async function ask(history: readonly Message[], tasks: readonly Task[]) {
  const fitted = await fitContext(history, {
    provider,
    systemState: () => renderTasks(tasks),
  });
  return provider.generate({ messages: fitted.messages });
}
```

### Why the renderer takes no arguments

`() => string | undefined`, not `(state) => string`. The state belongs to your app: a
store, a hook, a database read. A closure reaches all of them, needs no generic parameter
threaded through `fitContext`'s options, and keeps this package from pretending to own a
state container it knows nothing about. If you already have `(state) => string`, pass
`() => render(store.get())`.

The renderer must be synchronous and side-effect free — load whatever you need before
calling `fitContext`. Returning `undefined` or an empty string renders nothing this turn,
which is the correct answer when there is no state worth sending; it still strips any
block left over from a previous pass.

### Where the block goes, and idempotence

By default the block is appended to the system prompt after a blank line, introduced by a
`[current state]` marker:

```text
You are a task assistant. Be brief.

[current state]
- [ ] Renew passport (due 2026-10-01)
- [x] Book dentist (due unset)
```

One system block is what Apple's `instructions` entry and Chat Completions both expect,
and a single block is harder for a model to ignore than a stray message. If your system
prompt is long and cached by your provider, `placement: 'ownMessage'` puts the state in a
pinned `system` message of its own immediately after the prompt, so the cached prefix is
not invalidated every turn.

Either way the block is **idempotent**: any previously rendered block is stripped before
the new one is appended, so feeding a previous result back in replaces the block rather
than stacking copies. `stripSystemState(content, marker)` is exported for an app that
persists the messages it *sent* rather than the ones it holds and needs its original
system prompt back.

The state block is rendered *before* measurement, so it is inside the budget like any
other content. That is the point: a state block big enough to matter should push history
out, not overflow the request.

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { fitContext, stripSystemState, type Message } from '@taaltreelabs/on-device-llm/core';

const provider = createAppleProvider();

export async function askWithOwnStateMessage(history: readonly Message[], state: string) {
  const fitted = await fitContext(history, {
    provider,
    systemState: { render: () => state, placement: 'ownMessage' },
  });
  return fitted.messages;
}

/** Recover the system prompt as it was before a state block was appended to it. */
export function originalPrompt(sentContent: string): string {
  return stripSystemState(sentContent);
}
```

## How the budget is computed

```text
budget = contextWindow - reservedForOutput - safetyMargin
```

| Knob | Default | Notes |
| --- | --- | --- |
| `contextWindow` | From `provider.capabilities()` | Apple's `contextSize` is a *combined* input+output budget, which is why output is reserved out of the same number. |
| `reservedForOutput` | 512 | A complete chat reply: roughly 350–400 English words. That is 12.5% of a 4K window, 6% of 8K. Set it to your `maxOutputTokens`. |
| `safetyMargin` | 64 exact / **256 estimated** | Never zero: `countTokens(messages)` cannot see the schema, tool declarations, or prompt framing the provider adds at request time. Four times larger for estimates because the `chars / 3.5` heuristic over-counts prose but *under*-counts code, CJK, and URLs. |

The ordering inside `fitContext` matters and is not obvious: the conversation is
**measured first**, and the budget is computed from the kind of measurement that actually
happened, not from the provider's advertised `tokenCounting`. A provider that claims
`'exact'` and then throws — Apple's counter has been observed throwing
`ModelManagerError 1013` — is measuring by estimate, and must get the wider margin. A
silent estimate under an exact-looking number is how a "measured" budget overflows.

If even the pinned messages plus the newest turn exceed the budget, `fitContext` **throws**
`LLMError` `contextOverflow` (carrying the measured `tokenCount` and the budget as
`contextSize`) rather than returning a result that says "impossible". Throwing means a
context-manager overflow routes exactly like a provider's own: `contextOverflow` is a
fallback trigger, so a router moves that turn to a provider with a bigger window.

## Choosing a strategy

### `slidingWindow` — the default

Drops whole turns, oldest first, until the conversation fits. No model call, no cost, no
surprises. Choose it unless you have a specific reason not to.

```ts
import { fitContext, type LLMProvider, type Message } from '@taaltreelabs/on-device-llm/core';

export async function trim(provider: LLMProvider, messages: readonly Message[]) {
  return fitContext(messages, {
    provider,
    strategy: 'slidingWindow',
    reservedForOutput: 384,
  });
}
```

### `rollingSummary` — when early context genuinely matters

When the conversation crosses a fraction of the budget, everything but the newest turns is
summarized into one `system` message, which is spliced in where the oldest replaced
message was. The summarizer is any `LLMProvider`, deliberately not necessarily the one the
conversation runs on — summarizing with the cloud model while chatting on-device is the
case this shape exists for.

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { fitContext, type Message } from '@taaltreelabs/on-device-llm/core';
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';

const apple = createAppleProvider();
const cloud = createOpenAIProvider({
  baseUrl: 'https://your-endpoint.example.com/v1',
  model: 'your-model',
});

export async function trimWithSummary(messages: readonly Message[]) {
  const fitted = await fitContext(messages, {
    provider: apple,
    strategy: {
      type: 'rollingSummary',
      summarizer: cloud,
      threshold: 0.7,
      keepRecentTurns: 2,
    },
  });

  // The summary cost a model call. Adopt it back into your own history so the
  // next turn does not pay for it again.
  if (fitted.summary !== undefined) {
    return { messages: fitted.messages, summary: fitted.summary };
  }
  return { messages: fitted.messages, summary: undefined };
}
```

| Option | Default | Why |
| --- | --- | --- |
| `threshold` | `0.7` | Summarization has to happen *before* the request would overflow. At `1.0` every summarization lands on the critical path of a request that is already too big, and a slow or failing summarizer would then always land on a turn that cannot degrade gracefully. |
| `keepRecentTurns` | `2` | The smallest number that keeps a question and its follow-up intact. Clamped to a minimum of 1 — the newest turn is the request itself and is never summarized. |
| `maxSummaryTokens` | See `DEFAULT_MAX_SUMMARY_TOKENS` | `maxOutputTokens` for the summarizer call. |
| `prompt` | `defaultSummaryPrompt` | Override to steer what the summary keeps. |
| `onSummarizerError` | `'slidingWindow'` | The user asked a question, not for a summary. When the summarizer fails, degrade to `slidingWindow` for that request and report a warning. `'throw'` is available for apps where losing old context silently is the worse outcome. An abort always propagates regardless. |

A summary is a non-pinned `system` message whose content starts with
`[summary of earlier conversation]` (D13). `system` because a summary is out-of-band
context, not a turn anybody took — as an `assistant` message the model reads it as its own
words. Marked in the *content* because that survives JSON storage, state updates, and
providers that copy only the fields they know. **Not pinned**, which is what keeps it
eligible to be folded into the next summary instead of accumulating forever;
`isSummaryMessage`, `summaryText`, and `createSummaryMessage` are exported for apps that
need to recognize or build one.

If the result still exceeds the budget after summarizing — a long system prompt, a verbose
summarizer, an enormous newest turn — `slidingWindow` runs over the result rather than
returning something that cannot be sent.

### A strategy of your own

`ContextStrategy` is `(messages, environment) => Promise<FitContextResult>`, and
`fitContext` takes one directly, so you can compose (summarize, then apply your own
relevance filter) without forking this package. `slidingWindow` and `rollingSummary` are
both exported and callable from inside your own strategy.

## What survives trimming

Turns are dropped **whole** and oldest-first, which is what makes "no orphaned assistant
message" fall out of the structure rather than being patched afterwards. The rules:

- A turn opens at a `user` message.
- Consecutive `user` messages merge into one turn — one reply answers both, so splitting
  them strands half the prompt.
- Consecutive `assistant` messages stay in the turn they answered.
- Leading `assistant` messages form a prologue turn.
- A non-pinned `system` message (a rolling summary) forms a turn of its own, unless it
  sits in front of a turn that has not been answered yet, in which case it joins it.
- The newest turn is never dropped.
- Pinned messages are never dropped.

`pinSystemMessages` defaults to `'first'` — the system prompt only. Pinning *every* system
message would make each rolling summary immortal, so a long conversation would accumulate
summaries it could never retire. `analyzeConversation` explicitly pins the first
*non-summary* system message, so a leading summary cannot become "the system prompt" by
accident.

Two of these rules were wrong in the first implementation and were caught by the
`fast-check` property tests, not by the hand-written cases: a lone non-pinned `system`
message used to split `[user, system, assistant]` into three turns, leaving the assistant
as the newest turn — a textbook orphan; and `rollingSummary` with `keepRecentTurns: 0`
summarized the question being asked.

## Unknown context windows

A provider may report `contextWindow: UNKNOWN`. Every cloud endpoint does unless you
configure one, and the Apple provider does it too when the framework returns a
non-positive `contextSize`, which happens when the on-device stack is wedged (D9).

`ContextBudget` is therefore a discriminated union — `bounded | unbounded` — not a number.
Both tempting substitutes are wrong: `Infinity` sends a doomed request while claiming it
fits, `0` refuses every request.

| `onUnknownContextWindow` | Behavior |
| --- | --- |
| `'passThrough'` (default) | Return the conversation untrimmed, with an unbounded budget, `withinBudget: UNKNOWN`, and an `unknownContextWindow` warning. |
| `'error'` | Throw `invalidRequest`. For apps that would rather not send a request they cannot reason about. |

`assumedContextWindow: 8192` bypasses the policy entirely and budgets against your number.
Trimming to a guessed limit is never the default: if the request does overflow, the
provider's own `contextOverflow` carries the real `contextSize` and `tokenCount`, which is
better information than any guess.

## Reading the result

`FitContextResult` carries `messages` (send these), `dropped` (what went, in original
order), `warnings`, `withinBudget` (`true` or `UNKNOWN`), `strategy`, `budget`,
`measurement` (of what will be sent) and `inputMeasurement` (of what came in, each with
its `kind` and `source`), `systemState` (whether a block was rendered and what it said),
and `summary` when one was produced.

The warning codes are `unknownContextWindow`, `tokenCounterFailed`, `summarizerFailed`,
`summarizerEmpty`, `nothingToSummarize`, and `summaryDropped` — the last of which means
information has genuinely been lost and is worth surfacing somewhere. Every warning
message is safe to log: none of them contains message content.

Send `result.messages`; keep your own array as the source of truth. The one thing worth
adopting back into your history is `result.summary` — it cost a model call. Do not adopt
the system-state block; it is re-rendered every pass, and harmlessly replaced if you do.

In a React app, `useChat` does all of this for you and surfaces the interesting part as
`lastFit`: `sentCount`, `historyCount`, `dropped`, `warnings`, `withinBudget`, `strategy`
— enough for a debug line like "sent 4 of 9 messages".
