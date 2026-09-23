// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LLMError, MockProvider, type GenerateRequest } from '../../core';
import { useGenerate } from '../useGenerate';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const REQUEST: GenerateRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('useGenerate', () => {
  it('happy path: loading flips, result/object populate', async () => {
    const provider = new MockProvider();
    provider.script({ type: 'result', text: 'hello', object: { greeting: 'hello' } });

    const { result } = renderHook(() => useGenerate(provider));
    expect(result.current.loading).toBe(false);

    let promise!: ReturnType<typeof result.current.generate>;
    act(() => {
      promise = result.current.generate(REQUEST);
    });
    expect(result.current.loading).toBe(true);

    const outcome = await act(async () => promise);

    expect(outcome.text).toBe('hello');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.result).toEqual(outcome);
    expect(result.current.object).toEqual({ greeting: 'hello' });
  });

  it('error path: rejects, sets error, leaves result untouched', async () => {
    const provider = new MockProvider();
    provider.script({ type: 'error', error: new LLMError({ code: 'guardrail' }) });

    const { result } = renderHook(() => useGenerate(provider));

    let promise!: ReturnType<typeof result.current.generate>;
    act(() => {
      promise = result.current.generate(REQUEST);
    });

    await act(async () => {
      await expect(promise).rejects.toMatchObject({ code: 'guardrail' });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error?.code).toBe('guardrail');
    expect(result.current.result).toBeUndefined();
  });

  it('abort() cancels the in-flight call', async () => {
    const provider = new MockProvider();
    provider.script({ type: 'result', text: 'slow', delayMs: 100 });

    const { result } = renderHook(() => useGenerate(provider));

    let promise!: ReturnType<typeof result.current.generate>;
    act(() => {
      promise = result.current.generate(REQUEST);
    });

    act(() => {
      result.current.abort();
    });

    await act(async () => {
      await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error?.code).toBe('cancelled');

    const call = provider.calls.at(-1);
    expect(call?.signal?.aborted).toBe(true);
  });

  it('is superseded-safe: only the latest call updates result/loading/error', async () => {
    const provider = new MockProvider();
    // First (slow) turn scripted first so it is consumed by the first call.
    provider.script({ type: 'result', text: 'slow', delayMs: 50 });
    provider.script({ type: 'result', text: 'fast', delayMs: 10 });

    const { result } = renderHook(() => useGenerate(provider));

    let slowPromise!: ReturnType<typeof result.current.generate>;
    let fastPromise!: ReturnType<typeof result.current.generate>;
    act(() => {
      slowPromise = result.current.generate(REQUEST);
    });
    act(() => {
      fastPromise = result.current.generate(REQUEST);
    });

    // The fast call resolves first (10ms) and should populate state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const fastOutcome = await act(async () => fastPromise);
    expect(fastOutcome.text).toBe('fast');
    expect(result.current.result?.text).toBe('fast');
    expect(result.current.loading).toBe(false);

    // The slow call resolves later (its own promise still resolves for its
    // caller) but must NOT clobber the state the fast call already set.
    const slowOutcome = await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      return slowPromise;
    });
    expect(slowOutcome.text).toBe('slow');
    expect(result.current.result?.text).toBe('fast');
    expect(result.current.loading).toBe(false);
  });

  it('is unmount-safe: no state update, and the in-flight call is aborted', async () => {
    const provider = new MockProvider();
    provider.script({ type: 'result', text: 'late', delayMs: 100 });

    const { result, unmount } = renderHook(() => useGenerate(provider));

    act(() => {
      result.current.generate(REQUEST).catch(() => undefined);
    });

    unmount();

    const call = provider.calls.at(-1);
    expect(call?.signal?.aborted).toBe(true);

    // Advancing time (and letting the aborted call's rejection settle) after
    // unmount must not throw an "update on an unmounted component" warning
    // (React just doesn't have a component to warn about here, but this
    // also exercises that nothing else throws).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  });
});
