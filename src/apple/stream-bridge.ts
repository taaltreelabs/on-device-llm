/**
 * Native events -> `AsyncIterable<StreamEvent>`.
 *
 * The native side pushes; `for await` pulls. Bridging the two needs a buffer
 * (the model can outrun a consumer that awaits between chunks) and a way to
 * notice the consumer leaving early, because leaving early has to stop real
 * work on the device — not merely stop listening.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. **No lost events.** The listener is attached *before* `startStream` is
 *    called, and everything that arrives is queued whether or not the
 *    consumer is currently awaiting.
 * 2. **No crossed streams.** Every payload carries its `requestId` and
 *    anything else is ignored, so two concurrent streams over the one shared
 *    `onStreamEvent` channel never interleave.
 * 3. **Cancellation on every exit path.** `return`, `break`, `throw` in the
 *    consumer's loop, and an `AbortSignal` all end up calling native
 *    `cancel(requestId)`.
 *
 * It is also the JavaScript half of the tool protocol (DECISIONS.md D24): a
 * `toolCall` event starts the request's handler *without blocking the event
 * loop* — two tool calls can be in flight at once — and its outcome goes back
 * through `resolveToolCall(callId, …)`. A handler that throws fails the
 * request, with the original error kept as the `LLMError`'s cause.
 */

import {
  LLMError,
  toLLMError,
  type GenerateResult,
  type StreamEvent,
  type ToolExecutor,
} from '../core';
import { toLLMErrorFromNative } from './errors';
import type { AppleNativeModule, NativeStreamEvent, NativeSubscription } from './native/types';
import { parseObjectJson, toFinishReason, toTokenUsage } from './wire';

/**
 * Unbounded FIFO with an async `next()`.
 *
 * Unbounded on purpose: the alternative is dropping deltas or blocking the
 * native emitter, and one response is bounded by the model's context window
 * (a few thousand tokens), so the buffer cannot grow without limit in
 * practice. A consumer that never drains is a consumer that will be
 * garbage-collected along with its queue.
 */
class EventQueue {
  private readonly buffer: NativeStreamEvent[] = [];
  private waiting: ((event: NativeStreamEvent) => void) | undefined;

  push(event: NativeStreamEvent): void {
    const resolve = this.waiting;
    if (resolve !== undefined) {
      this.waiting = undefined;
      resolve(event);
      return;
    }
    this.buffer.push(event);
  }

  async next(): Promise<NativeStreamEvent> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return buffered;
    return new Promise<NativeStreamEvent>((resolve) => {
      this.waiting = resolve;
    });
  }
}

/** Inputs for {@link bridgeNativeStream}. */
export interface StreamBridgeOptions {
  readonly native: AppleNativeModule;
  readonly requestId: string;
  readonly providerId: string;
  /** Kicks off the native stream. Called after the listener is attached. */
  readonly start: () => Promise<void>;
  readonly signal?: AbortSignal;
  /** Handler per tool name, already resolved by `buildNativeRequest`. */
  readonly toolHandlers?: ReadonlyMap<string, ToolExecutor>;
}

/** Text the model can read, from whatever a handler returned. */
function toToolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch (cause) {
    throw new Error(
      `The tool handler returned a value that cannot be serialized to JSON: ${String(cause)}`
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Start a promise nobody is going to await, swallowing its rejection.
 *
 * Tool handlers and bridge replies are deliberately not awaited by the event
 * loop (that is what lets two tool calls run at once), and an unhandled
 * rejection from one of them must not take the process down — every failure
 * that matters is already reported through `resolveToolCall` and the request's
 * own error path.
 */
function runDetached(work: () => Promise<unknown>): void {
  const noop = (): void => {};
  work().then(noop, noop);
}

/**
 * Turn one native stream into an `AsyncGenerator<StreamEvent>`.
 *
 * Terminates when a `finish` event arrives (yielded as `StreamEvent`
 * `finish`) or an `error` event arrives (thrown as a typed `LLMError`). The
 * native side guarantees exactly one terminal event per request, so this does
 * not need a timeout of its own — a caller who wants one passes an
 * `AbortSignal`.
 *
 * Being an async *generator*, the body below — listener included — does not
 * run until the first `next()`. That is the right laziness for a provider:
 * building a stream object costs nothing and starts no generation, so a
 * caller who never iterates never occupies the neural engine. It does mean
 * `start()` is called from inside the first pull, not from `stream()`.
 */
export async function* bridgeNativeStream(
  options: StreamBridgeOptions
): AsyncGenerator<StreamEvent, void, undefined> {
  const { native, requestId, providerId, start, signal } = options;

  if (signal?.aborted === true) {
    throw new LLMError({ code: 'cancelled' }, { providerId, cause: signal.reason });
  }

  const queue = new EventQueue();
  let terminated = false;

  /**
   * Aborts when this request ends, however it ends. Handed to every tool
   * handler so long-running work (a fetch, a query) can stop when the answer
   * is no longer wanted — a reply arriving after this is discarded natively.
   */
  const toolScope = new AbortController();
  /**
   * The first handler error, kept so the request's failure can carry it as
   * `cause`. Native tells us *that* a tool failed; only this side still has the
   * original `Error`, and losing it would leave the developer with our
   * paraphrase of their own exception.
   */
  let toolFailure:
    { readonly toolName: string; readonly callId: string; readonly error: unknown } | undefined;

  const subscription: NativeSubscription = native.addListener(
    'onStreamEvent',
    (event: NativeStreamEvent) => {
      // Demultiplex: this listener sees every stream's events.
      if (event.requestId !== requestId) return;
      queue.push(event);
    }
  );

  /**
   * Run one tool call and reply to native.
   *
   * Not awaited by the event loop below, on purpose: the model can have two
   * calls outstanding, and awaiting the first here would serialise them (and
   * stall the stream's own events behind app code). Every path ends in exactly
   * one `resolveToolCall`, and a `false` from it means the call had already
   * timed out or been cancelled — normal, and ignored.
   */
  const runToolCall = (call: { callId: string; toolName: string; args: unknown }): void => {
    const reply = (resultJson: string | null, errorMessage: string | null): void => {
      const resolveToolCall = native.resolveToolCall?.bind(native);
      if (resolveToolCall === undefined) return;
      // The native side may already have abandoned this call, or the module may
      // be torn down. Either way the request's own error path reports it.
      runDetached(() => resolveToolCall(call.callId, resultJson, errorMessage));
    };

    const handler = options.toolHandlers?.get(call.toolName);
    if (handler === undefined) {
      // `buildNativeRequest` makes this unreachable for tools we declared, so
      // this is the model inventing a tool name, or a stale native module.
      const error = new Error(`No handler is registered for the tool "${call.toolName}".`);
      toolFailure ??= { toolName: call.toolName, callId: call.callId, error };
      reply(null, error.message);
      return;
    }

    runDetached(async () => {
      try {
        const result = await handler({
          callId: call.callId,
          toolName: call.toolName,
          arguments: call.args,
          signal: toolScope.signal,
        });
        reply(toToolResultText(result), null);
      } catch (error) {
        toolFailure ??= { toolName: call.toolName, callId: call.callId, error };
        reply(null, describeError(error));
      }
    });
  };

  const cancelNative = (): void => {
    native.cancel(requestId).catch(() => {
      // The request may already have finished; a failed cancel of a request
      // that no longer exists is not worth surfacing.
    });
  };

  const onAbort = (): void => {
    // Stop the Swift Task. The native side answers with a `cancelled` error
    // event, which becomes the `LLMError` this generator throws — so the
    // abort path and the native-failure path share one piece of code.
    cancelNative();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      await start();
    } catch (err) {
      // Only reachable if the bridge call itself fails (a malformed argument,
      // a module torn down mid-call). Generation failures arrive as events.
      throw toLLMError(err, { providerId, transient: true });
    }

    while (!terminated) {
      const event = await queue.next();
      switch (event.type) {
        case 'delta':
          if (event.delta !== '') {
            yield { type: 'textDelta', delta: event.delta };
          }
          break;
        case 'objectSnapshot': {
          // A partial snapshot is often not parseable yet (a half-written
          // string, a missing brace). That is expected, not an error: skip it
          // and let the next one through. The `finish` event carries the
          // authoritative, complete object.
          let snapshot: unknown;
          try {
            snapshot = JSON.parse(event.snapshotJson) as unknown;
          } catch {
            break;
          }
          yield { type: 'objectSnapshot', snapshot };
          break;
        }
        case 'toolCall': {
          let args: unknown;
          try {
            args = JSON.parse(event.argumentsJson) as unknown;
          } catch {
            // The framework's own serialisation should always parse; if it does
            // not, the handler still gets the text so it can decide.
            args = event.argumentsJson;
          }
          runToolCall({ callId: event.callId, toolName: event.toolName, args });
          yield {
            type: 'toolCall',
            callId: event.callId,
            toolName: event.toolName,
            arguments: args,
          };
          break;
        }
        case 'finish': {
          terminated = true;
          const usage = toTokenUsage(event.result.usage);
          const result: GenerateResult = {
            // Authoritative: the last native snapshot, not the concatenation
            // of the deltas above. They are equal unless the D18 fallback
            // fired (see ios/Core/SnapshotDiffer.swift).
            text: event.result.text,
            ...(event.result.objectJson !== undefined
              ? { object: parseObjectJson(event.result.objectJson, providerId) }
              : {}),
            finishReason: toFinishReason(event.result.finishReason),
            ...(usage !== undefined ? { usage } : {}),
            providerId,
          };
          yield { type: 'finish', result };
          return;
        }
        case 'error': {
          terminated = true;
          const error = toLLMErrorFromNative(event.error, providerId);
          if (toolFailure !== undefined) {
            // The request failed because a tool handler did. Re-raise with the
            // handler's own error as `cause`, keeping the native diagnostics
            // alongside it: the app's stack trace is the useful half.
            throw new LLMError(error.details, {
              message: error.message,
              providerId,
              cause: {
                toolName: toolFailure.toolName,
                callId: toolFailure.callId,
                handlerError: toolFailure.error,
                native: error.cause,
              },
            });
          }
          throw error;
        }
      }
    }
  } finally {
    subscription.remove();
    signal?.removeEventListener('abort', onAbort);
    // Tell any handler still running that nobody is waiting for it.
    toolScope.abort();
    if (!terminated) {
      // We are leaving without a terminal event: the consumer broke out of
      // its loop, threw, or was aborted. `finally` is the only place that
      // sees all three, and the whole point of Phase 3 step 3 is that this
      // stops native generation rather than just unsubscribing from it.
      cancelNative();
    }
  }
}
