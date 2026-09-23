# Tool calling

The on-device model can call functions you supply, mid-generation, and continue with the
result. This is the part of the package with the most native machinery behind it, and the
part where every bridge surveyed before writing it had the same gap.

- [Defining a tool](#defining-a-tool)
- [One dispatcher instead of many handlers](#one-dispatcher-instead-of-many-handlers)
- [Deadlines](#deadlines)
- [Cancellation](#cancellation)
- [Observing calls while streaming](#observing-calls-while-streaming)
- [Provider support](#provider-support)

## Defining a tool

A tool is a definition **with** its handler, on the request:

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import type { ToolDefinition } from '@taaltreelabs/on-device-llm/core';

const lookupLesson: ToolDefinition = {
  name: 'lookupLesson',
  // This is prompt text — the model chooses tools by reading it, so it earns its tokens.
  description: 'Looks up a lesson by its id and returns its title and vocabulary list.',
  parameters: {
    type: 'object',
    title: 'LookupLessonArgs',
    properties: { lessonId: { type: 'string' } },
    required: ['lessonId'],
    additionalProperties: false,
  },
  execute: async (call) => {
    const { lessonId } = call.arguments as { lessonId: string };
    const response = await fetch(`https://example.com/lessons/${lessonId}`, {
      signal: call.signal,
    });
    return response.json();
  },
};

const apple = createAppleProvider();

export async function answer(question: string): Promise<string> {
  const result = await apple.generate({
    messages: [{ role: 'user', content: question }],
    tools: [lookupLesson],
  });
  return result.text;
}
```

The handler travels with the definition for a reason (D24). The alternatives were
configuring handlers on the provider — wrong, because tools belong to a conversation, not
to a model, and a router picks the provider per request — or passing a parallel handler
map, which is two structures to keep in sync whose failure mode (a definition with no
handler) surfaces mid-generation with a call already in flight. Keeping them together
makes "every tool the model can see has something to run" checkable **before** the request
starts, and that check runs at the call site, naming the tool.

`parameters` is validated by the same `normalizeJsonSchema` rules as
`GenerateRequest.schema` — see [structured-output.md](structured-output.md).

`ToolCall.arguments` is typed `unknown` because no provider can guarantee the model
produced something matching `parameters`; validate it in the handler if it matters. The
return value is converted to text for the model: a string passes through unchanged,
anything else is `JSON.stringify`d. Returning `undefined` sends an empty result, which the
model usually reads as "the tool had nothing to say" — prefer an explicit value.

Throwing from a handler fails the whole request, with your original error preserved as the
`LLMError`'s `cause`. That is deliberate: a tool that cannot answer has derailed the
generation, and a provider that swallowed the error would leave the model to invent the
missing fact.

## One dispatcher instead of many handlers

`execute` is optional on `ToolDefinition`, because a definition without one is still
meaningful — a request serialized for logging, or a cloud provider that round-trips tool
calls to the caller. An app that dispatches every tool through one function uses
`RequestOptions.onToolCall`:

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import type { ToolCall, ToolDefinition } from '@taaltreelabs/on-device-llm/core';

const tools: readonly ToolDefinition[] = [
  {
    name: 'getBatteryLevel',
    description: 'Reads the current battery level (0 to 1) and charging state.',
    parameters: { type: 'object', title: 'Args', properties: {}, additionalProperties: false },
  },
];

async function dispatch(call: ToolCall): Promise<unknown> {
  switch (call.toolName) {
    case 'getBatteryLevel':
      return { level: 0.42, state: 'unplugged' };
    default:
      throw new Error(`no handler for ${call.toolName}`);
  }
}

export async function run(prompt: string): Promise<string> {
  const apple = createAppleProvider();
  const result = await apple.generate(
    { messages: [{ role: 'user', content: prompt }], tools },
    { onToolCall: dispatch }
  );
  return result.text;
}
```

A per-tool `execute` wins when both are present. A tool with neither makes the request
`invalidRequest` before generation starts.

## Deadlines

Every tool call has a deadline: `AppleProviderConfig.toolCallTimeoutMs`, **30 000 ms by
default**.

There is a timeout at all because the alternative — which every bridge surveyed before
this one ships — is a handler that forgets to answer pinning the neural engine for the
life of the process, with no error and nothing in the log.

| Failure | Error | `transient` | Router falls back by default? |
| --- | --- | --- | --- |
| The handler did not answer in time | `unknown` | `true` | **Yes** |
| The handler threw | `unknown` | `false` | No |

The split is the point. A timeout means the request was well-formed and the thing that
failed — an app handler waiting on the network, a JS thread behind a render — may well
succeed on a retry elsewhere. A handler that threw is app code failing deterministically,
and a router must not spend a second provider on it.

## Cancellation

`abort()` on the request's `AbortSignal` resumes every pending tool continuation **and**
cancels the native generation task. Cancelling the task alone is not enough: the framework
cannot interrupt an `await` inside our own tool bridge, so the call would stay suspended
forever.

Handlers are handed an `AbortSignal` of their own (`ToolCall.signal`) that fires when the
request ends, however it ends — cancelled, timed out, or finished. A handler doing real
work should pass it along, because a reply after the abort is discarded.

Late and duplicate replies are no-ops, never crashes. JavaScript cannot know that the
native timer has already fired, so the race is entirely normal; a registry keyed by
`callId` rather than by request is what makes two concurrent calls to the same tool safe.

## Observing calls while streaming

`toolCall` is emitted as a `StreamEvent` for observability only. By the time a consumer
sees one, the provider has already handed the call to your handler and generation
continues when the handler answers — nothing is expected of the consumer. A UI can show
"looking up the lesson…"; a consumer that ignores the event misses nothing but the status
line.

```ts
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import type { ToolDefinition } from '@taaltreelabs/on-device-llm/core';

export async function streamWithStatus(
  prompt: string,
  tools: readonly ToolDefinition[],
  onStatus: (text: string) => void,
  onDelta: (delta: string) => void
): Promise<void> {
  const apple = createAppleProvider();
  for await (const event of apple.stream({ messages: [{ role: 'user', content: prompt }], tools })) {
    switch (event.type) {
      case 'toolCall':
        onStatus(`Running ${event.toolName}…`);
        break;
      case 'textDelta':
        onDelta(event.delta);
        break;
      default:
        break;
    }
  }
}
```

There is deliberately no `toolResult` event: the handler is your own code and already
knows what it returned.

Note that a request carrying tools runs on the streaming path even when you call
`generate()`, which folds the events into a result. A tool call has to reach JavaScript
mid-generation, and the non-streaming native call is one promise with no event channel;
building a second tool protocol for it would have doubled the surface for no behavior
change. One visible consequence: `finishReason: 'toolCalls'` never appears in practice,
because the framework resolves tool calls internally and then finishes normally. It is
reserved for a generation that genuinely ends with calls outstanding.

Because `toolCall` counts as an event handed to the consumer, it also closes a router's
fallback window — a second provider would run your handler again.

## Provider support

| Provider | `capabilities().tools` |
| --- | --- |
| `apple` | `true` when the model reports tool calling **and** the resolved native module implements the call protocol. Both halves are checked: npm makes a JavaScript half newer than the installed native half entirely possible, and a provider that advertises a protocol the native side cannot speak sends a router *toward* a provider that is about to fail. |
| `openai` | `false`. A request carrying `tools` is rejected as `invalidRequest` rather than answered without them — a model that was supposed to look something up and instead guessed is the worst of the available outcomes. |
| `MockProvider` | `false` by default; configurable, but it never calls `execute` itself. |

`fm serve` is not a way to test tool calling: `tool_choice: "auto"` never populates
`tool_calls` upstream, and a forced choice is rejected outright. Use the Apple provider,
or `npm run harness:apple`, which asserts a live tool round trip, a timeout firing, and a
mid-call cancel leaving no pending continuations.
