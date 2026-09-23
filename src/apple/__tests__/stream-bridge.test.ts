/**
 * The event -> `AsyncIterable` bridge: buffering, demultiplexing, and the
 * cancellation paths that Phase 3 step 3 is really about.
 *
 * Note the `pull()` helper below. `stream()` returns a lazy async generator,
 * so nothing — not the listener, not `startStream` — happens until the first
 * `next()`. Every test therefore starts a pull before emitting anything,
 * which is also what a real consumer's `for await` does.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isLLMError, type StreamEvent } from '../../core';
import { AppleProvider } from '../provider';
import { FakeNativeModule } from './fake-native';

let native: FakeNativeModule;
const make = (): AppleProvider => new AppleProvider({}, () => native);

/** Somewhere for drain loops to put events they do not inspect. */
let drained: StreamEvent[];

beforeEach(() => {
  native = new FakeNativeModule();
  drained = [];
});

const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };

/** Start a stream, kick off the first pull, and wait until native was asked to start. */
async function pull(
  provider: AppleProvider,
  options?: { signal?: AbortSignal }
): Promise<{
  iterator: AsyncIterator<StreamEvent>;
  first: Promise<IteratorResult<StreamEvent>>;
  id: string;
}> {
  const iterator = provider.stream(ask, options)[Symbol.asyncIterator]();
  const first = iterator.next();
  await native.startStreamCalled;
  return { iterator, first, id: native.lastStreamRequestId };
}

/** Drain an iterator that has already had its first `next()` issued. */
async function drain(
  iterator: AsyncIterator<StreamEvent>,
  first: Promise<IteratorResult<StreamEvent>>
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  let next = await first;
  while (next.done !== true) {
    events.push(next.value);
    next = await iterator.next();
  }
  return events;
}

/** Let queued microtasks and timers run. */
const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe('happy path', () => {
  it('turns deltas into textDelta events and finish into a GenerateResult', async () => {
    const { iterator, first, id } = await pull(make());

    native.emit({ requestId: id, type: 'delta', delta: 'Hel', reset: false });
    native.emit({ requestId: id, type: 'delta', delta: 'lo', reset: false });
    native.emit({
      requestId: id,
      type: 'finish',
      result: { text: 'Hello', finishReason: 'stop', usage: { outputTokens: 2 } },
    });

    expect(await drain(iterator, first)).toEqual([
      { type: 'textDelta', delta: 'Hel' },
      { type: 'textDelta', delta: 'lo' },
      {
        type: 'finish',
        result: {
          text: 'Hello',
          finishReason: 'stop',
          usage: { outputTokens: 2 },
          providerId: 'apple',
        },
      },
    ]);
  });

  it('attaches its listener before asking native to start', async () => {
    // Otherwise a fast first delta would be emitted into the void.
    let listenersAtStart = -1;
    native.startStream = async (requestId: string) => {
      listenersAtStart = native.listenerCount;
      native.calls.startStream.push([requestId]);
    };
    const iterator = make().stream(ask)[Symbol.asyncIterator]();
    iterator.next().catch(() => undefined);
    await tick();
    expect(listenersAtStart).toBe(1);
  });

  it('buffers events emitted faster than the consumer pulls', async () => {
    // The model can outrun a consumer that awaits between chunks; nothing may
    // be dropped in the gap.
    const { iterator, first, id } = await pull(make());
    for (const delta of ['a', 'b', 'c']) {
      native.emit({ requestId: id, type: 'delta', delta, reset: false });
    }
    native.emit({ requestId: id, type: 'finish', result: { text: 'abc', finishReason: 'stop' } });

    expect((await first).value).toEqual({ type: 'textDelta', delta: 'a' });
    expect((await iterator.next()).value).toEqual({ type: 'textDelta', delta: 'b' });
    expect((await iterator.next()).value).toEqual({ type: 'textDelta', delta: 'c' });
    expect((await iterator.next()).value).toMatchObject({ type: 'finish' });
  });

  it('drops empty deltas rather than yielding no-op events', async () => {
    const { first, id } = await pull(make());
    native.emit({ requestId: id, type: 'delta', delta: '', reset: false });
    native.emit({ requestId: id, type: 'delta', delta: 'x', reset: false });
    expect((await first).value).toEqual({ type: 'textDelta', delta: 'x' });
  });

  it('trusts the final snapshot over the concatenated deltas (D18)', async () => {
    // A `reset` delta means the model rewrote text already delivered, which a
    // delta stream cannot retract. `finish.result.text` is authoritative.
    const { iterator, first, id } = await pull(make());
    native.emit({ requestId: id, type: 'delta', delta: 'Hello wor', reset: false });
    native.emit({ requestId: id, type: 'delta', delta: 'there', reset: true });
    native.emit({
      requestId: id,
      type: 'finish',
      result: { text: 'Hello there', finishReason: 'stop' },
    });

    const events = await drain(iterator, first);
    const concatenated = events
      .filter(
        (event): event is Extract<StreamEvent, { type: 'textDelta' }> => event.type === 'textDelta'
      )
      .map((event) => event.delta)
      .join('');
    expect(concatenated).toBe('Hello worthere');
    expect(events[events.length - 1]).toMatchObject({ result: { text: 'Hello there' } });
  });

  it('removes its listener when the stream ends', async () => {
    const { iterator, first, id } = await pull(make());
    expect(native.listenerCount).toBe(1);
    native.emit({ requestId: id, type: 'finish', result: { text: '', finishReason: 'stop' } });
    await drain(iterator, first);
    expect(native.listenerCount).toBe(0);
  });
});

describe('demultiplexing', () => {
  it('ignores events belonging to another request', async () => {
    const { first, id } = await pull(make());
    native.emit({ requestId: 'someone-else', type: 'delta', delta: 'WRONG', reset: false });
    native.emit({ requestId: id, type: 'delta', delta: 'mine', reset: false });
    expect((await first).value).toEqual({ type: 'textDelta', delta: 'mine' });
  });

  it('keeps two concurrent streams separate, including out-of-order arrival', async () => {
    const provider = make();
    const a = await pull(provider);
    // A second stream needs its own `startStreamCalled` latch, so watch the
    // call log instead.
    const bIterator = provider.stream(ask)[Symbol.asyncIterator]();
    const bFirst = bIterator.next();
    await tick();
    const idB = native.lastStreamRequestId;
    expect(idB).not.toBe(a.id);

    // Interleaved, and B terminates first.
    native.emit({ requestId: idB, type: 'delta', delta: 'b1', reset: false });
    native.emit({ requestId: a.id, type: 'delta', delta: 'a1', reset: false });
    native.emit({ requestId: idB, type: 'finish', result: { text: 'b1', finishReason: 'stop' } });
    native.emit({ requestId: a.id, type: 'delta', delta: 'a2', reset: false });
    native.emit({
      requestId: a.id,
      type: 'finish',
      result: { text: 'a1a2', finishReason: 'stop' },
    });

    expect(await drain(bIterator, bFirst)).toEqual([
      { type: 'textDelta', delta: 'b1' },
      { type: 'finish', result: { text: 'b1', finishReason: 'stop', providerId: 'apple' } },
    ]);
    expect(await drain(a.iterator, a.first)).toEqual([
      { type: 'textDelta', delta: 'a1' },
      { type: 'textDelta', delta: 'a2' },
      { type: 'finish', result: { text: 'a1a2', finishReason: 'stop', providerId: 'apple' } },
    ]);
  });
});

describe('cancellation', () => {
  it('cancels native generation when the consumer breaks out of the loop', async () => {
    // The point of Phase 3 step 3: leaving the loop has to stop the work on
    // the device, not merely stop listening to it.
    const stream = make().stream(ask);
    const consume = (async () => {
      for await (const event of stream) {
        if (event.type === 'textDelta') break;
      }
    })();
    await native.startStreamCalled;
    const id = native.lastStreamRequestId;
    native.emit({ requestId: id, type: 'delta', delta: 'x', reset: false });
    await consume;

    expect(native.calls.cancel).toEqual([id]);
    expect(native.listenerCount).toBe(0);
  });

  it('cancels when the consumer throws out of the loop', async () => {
    const stream = make().stream(ask);
    const consume = (async () => {
      for await (const event of stream) {
        drained.push(event);
        throw new Error('consumer blew up');
      }
    })();
    await native.startStreamCalled;
    const id = native.lastStreamRequestId;
    native.emit({ requestId: id, type: 'delta', delta: 'x', reset: false });
    await expect(consume).rejects.toThrow('consumer blew up');
    expect(native.calls.cancel).toEqual([id]);
  });

  it('does not cancel after a natural finish', async () => {
    const stream = make().stream(ask);
    const consume = (async () => {
      for await (const event of stream) drained.push(event);
    })();
    await native.startStreamCalled;
    native.emit({
      requestId: native.lastStreamRequestId,
      type: 'finish',
      result: { text: 'done', finishReason: 'stop' },
    });
    await consume;
    expect(native.calls.cancel).toEqual([]);
  });

  it('cancels natively and throws `cancelled` when the signal fires mid-stream', async () => {
    const controller = new AbortController();
    const stream = make().stream(ask, { signal: controller.signal });
    const consume = (async () => {
      for await (const event of stream) drained.push(event);
    })();
    await native.startStreamCalled;
    const id = native.lastStreamRequestId;

    controller.abort();
    await tick();
    expect(native.calls.cancel).toEqual([id]);

    // The native side answers a cancel with a `cancelled` error event, so the
    // abort path and the native-failure path share one piece of code.
    native.emit({
      requestId: id,
      type: 'error',
      error: { code: 'cancelled', message: 'The request was cancelled' },
    });
    await expect(consume).rejects.toSatisfy((err: unknown) => isLLMError(err, 'cancelled'));
  });

  it('throws `cancelled` without starting anything when the signal is already aborted', async () => {
    const stream = make().stream(ask, { signal: AbortSignal.abort() });
    await expect(
      (async () => {
        for await (const event of stream) drained.push(event);
      })()
    ).rejects.toSatisfy((err: unknown) => isLLMError(err, 'cancelled'));
    expect(native.calls.startStream).toHaveLength(0);
  });
});

describe('errors', () => {
  it('throws a typed LLMError from an error event, mid-stream', async () => {
    const stream = make().stream(ask);
    const events: StreamEvent[] = [];
    const consume = (async () => {
      for await (const event of stream) events.push(event);
    })();
    await native.startStreamCalled;
    const id = native.lastStreamRequestId;

    native.emit({ requestId: id, type: 'delta', delta: 'partial', reset: false });
    native.emit({
      requestId: id,
      type: 'error',
      error: { code: 'contextOverflow', message: 'too big', contextSize: 8192, tokenCount: 9001 },
    });

    await expect(consume).rejects.toSatisfy(
      (err: unknown) =>
        isLLMError(err, 'contextOverflow') &&
        err.details.contextSize === 8192 &&
        err.details.tokenCount === 9001
    );
    // Deltas delivered before the failure are kept; a half-delivered stream is
    // still a stream, and the caller has already rendered them.
    expect(events).toEqual([{ type: 'textDelta', delta: 'partial' }]);
    expect(native.listenerCount).toBe(0);
  });

  it('wraps a failure of the startStream call itself as a transient unknown', async () => {
    native.startStream = async () => {
      throw new Error('bridge went away');
    };
    const stream = make().stream(ask);
    await expect(
      (async () => {
        for await (const event of stream) drained.push(event);
      })()
    ).rejects.toSatisfy(
      (err: unknown) => isLLMError(err, 'unknown') && err.details.transient === true
    );
  });
});
