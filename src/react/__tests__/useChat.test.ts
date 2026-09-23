// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LLMError, MockProvider } from '../../core';
import { useChat } from '../useChat';

// Fake timers throughout: `MockProvider`'s scripted chunk delays run on
// `setTimeout`, and this sandbox's real timers are not reliable enough for
// millisecond-scale assertions (observed: a 5-50ms scripted delay
// occasionally taking well over a second of wall-clock time under load,
// which no `waitFor` timeout budget survives). Advancing fake time
// deterministically removes that flakiness entirely.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useChat', () => {
  it('sends a message, streams deltas visibly, then appends the assistant turn', async () => {
    const provider = new MockProvider();
    provider.script({
      type: 'stream',
      chunks: [
        { text: 'Hel', delayMs: 5 },
        { text: 'lo', delayMs: 5 },
      ],
    });

    const { result } = renderHook(() => useChat({ provider }));

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.send('Hi there');
    });

    expect(result.current.messages).toEqual([{ role: 'user', content: 'Hi there' }]);
    expect(result.current.status).not.toBe('idle');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });
    expect(result.current.streamingText).toBe('Hel');

    // The second chunk's delay is also its stream's last event before
    // `finish` (which fires with no further delay), so this single advance
    // both delivers 'lo' and completes the turn -- there is no stable
    // in-between "streamingText === 'Hello'" tick to observe separately.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
      await sendPromise;
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.streamingText).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages).toEqual([
      { role: 'user', content: 'Hi there' },
      { role: 'assistant', content: 'Hello' },
    ]);
  });

  it('stop() aborts the in-flight turn, keeps partial streamingText, and does not set error', async () => {
    const provider = new MockProvider();
    provider.script({
      type: 'stream',
      chunks: [
        { text: 'Par', delayMs: 20 },
        { text: 'tial', delayMs: 20 },
      ],
    });

    const { result } = renderHook(() => useChat({ provider }));

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.send('Hi');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(result.current.streamingText).toBe('Par');

    act(() => {
      result.current.stop();
    });

    await act(async () => {
      await sendPromise;
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
    expect(result.current.streamingText).toBe('Par');
    expect(result.current.messages).toEqual([{ role: 'user', content: 'Hi' }]);

    const call = provider.calls.at(-1);
    expect(call?.signal?.aborted).toBe(true);
  });

  it('on a non-cancelled error, keeps the user message, appends no assistant message, and leaves partial streamingText', async () => {
    const provider = new MockProvider();
    provider.script({
      type: 'stream',
      chunks: ['Oops '],
      error: new LLMError({ code: 'network' }),
    });

    const onErrorCalls: string[] = [];
    const { result } = renderHook(() =>
      useChat({ provider, onError: (error) => onErrorCalls.push(error.code) })
    );

    await act(async () => {
      await result.current.send('Trigger');
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error?.code).toBe('network');
    expect(result.current.streamingText).toBe('Oops ');
    expect(result.current.messages).toEqual([{ role: 'user', content: 'Trigger' }]);
    expect(onErrorCalls).toEqual(['network']);
  });

  it('rejects a second send() while one is already in flight, with invalidRequest', async () => {
    const provider = new MockProvider();
    provider.script({ type: 'stream', chunks: [{ text: 'slow', delayMs: 20 }] });

    const { result } = renderHook(() => useChat({ provider }));

    let firstPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.send('first');
    });

    await expect(result.current.send('second')).rejects.toMatchObject({ code: 'invalidRequest' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
      await firstPromise;
    });
    expect(result.current.messages.map((message) => message.content)).toEqual(['first', 'slow']);
  });

  it('reset() clears messages/streamingText/error/lastFit and aborts any in-flight turn', async () => {
    const provider = new MockProvider();
    // A second, much-later chunk keeps the stream genuinely in flight after
    // the first fires -- otherwise `finish` (no delay of its own) would
    // complete the turn in the same tick as the first chunk, and reset()
    // would have nothing in flight left to abort.
    provider.script({
      type: 'stream',
      chunks: [
        { text: 'x', delayMs: 20 },
        { text: 'y', delayMs: 10_000 },
      ],
    });

    const { result } = renderHook(() => useChat({ provider }));
    act(() => {
      result.current.send('hello').catch(() => undefined);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(result.current.streamingText).toBe('x');

    act(() => {
      result.current.reset();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.streamingText).toBeUndefined();
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
    expect(result.current.lastFit).toBeUndefined();

    // Let the aborted turn's own async cleanup settle without warnings.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('aborts the in-flight turn on unmount', async () => {
    const provider = new MockProvider();
    provider.script({ type: 'stream', chunks: [{ text: 'x', delayMs: 50 }] });

    const { result, unmount } = renderHook(() => useChat({ provider }));
    act(() => {
      result.current.send('hello').catch(() => undefined);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(provider.calls.length).toBe(1);
    expect(result.current.status).toBe('streaming');

    unmount();

    const call = provider.calls[0];
    expect(call?.signal?.aborted).toBe(true);
  });

  it('trims history via fitContext when it exceeds the provider window, and reports it in lastFit', async () => {
    const provider = new MockProvider({ capabilities: { contextWindow: 40 } });
    const longText = 'A'.repeat(60);

    const { result } = renderHook(() =>
      useChat({ provider, context: { reservedForOutput: 0, safetyMargin: 0 } })
    );

    for (let round = 0; round < 3; round += 1) {
      provider.script({ type: 'stream', chunks: [`reply-${round}`] });
      // Sequential on purpose: each round must complete before the next is sent.
      await act(async () => {
        await result.current.send(`${longText}-${round}`);
      });
    }

    expect(result.current.lastFit).toBeDefined();
    expect(result.current.lastFit?.dropped.length).toBeGreaterThan(0);
    expect(result.current.lastFit?.strategy).toBe('slidingWindow');

    const lastRequest = provider.requests.at(-1);
    expect(lastRequest?.messages.length).toBe(result.current.lastFit?.sentCount);
    expect(lastRequest?.messages.length).toBeLessThan(result.current.messages.length);
  });

  it('pins the system prompt ahead of history on every turn', async () => {
    const provider = new MockProvider();
    provider.script({ type: 'stream', chunks: ['ok'] });

    const { result } = renderHook(() => useChat({ provider, systemPrompt: 'Be terse.' }));

    await act(async () => {
      await result.current.send('hi');
    });

    const request = provider.requests.at(-1);
    expect(request?.messages[0]).toEqual({ role: 'system', content: 'Be terse.', pinned: true });
    // The system prompt is not part of the returned `messages` history.
    expect(result.current.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});
