// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MockProvider, type LLMProvider } from '../../core';
import { useAvailability } from '../useAvailability';
import { ControllableProvider } from './test-helpers';

describe('useAvailability', () => {
  it('checks on mount and resolves availability/capabilities', async () => {
    const provider = new MockProvider();
    const { result } = renderHook(() => useAvailability(provider));

    expect(result.current.loading).toBe(true);
    expect(result.current.availability).toBeUndefined();
    expect(result.current.capabilities).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.availability).toEqual({ available: true });
    expect(result.current.capabilities?.contextWindow).toBe(4096);
    expect(result.current.error).toBeUndefined();
  });

  it('re-checks when the provider identity changes', async () => {
    const providerA = new MockProvider({ id: 'a' });
    const providerB = new MockProvider({
      id: 'b',
      availability: { available: false, reason: 'notEnabled' },
    });

    const { result, rerender } = renderHook(
      ({ provider }: { provider: LLMProvider }) => useAvailability(provider),
      { initialProps: { provider: providerA as LLMProvider } }
    );

    await waitFor(() => expect(result.current.availability?.available).toBe(true));

    rerender({ provider: providerB });

    await waitFor(() => expect(result.current.availability?.available).toBe(false));
    expect(result.current.availability).toMatchObject({ reason: 'notEnabled' });
  });

  it('discards a superseded check (older generation resolving after a newer one)', async () => {
    const provider = new ControllableProvider();
    const first = provider.queueCheck(); // consumed by the mount effect
    const second = provider.queueCheck(); // consumed by the manual refresh() below

    const { result } = renderHook(() => useAvailability(provider));
    expect(provider.calls).toBe(1);

    act(() => {
      result.current.refresh();
    });
    expect(provider.calls).toBe(2);

    // Resolve out of order: the newer request settles first...
    act(() => {
      second.resolve({ available: true });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.availability).toEqual({ available: true });

    // ...then the stale one arrives and must be discarded.
    act(() => {
      first.resolve({ available: false, reason: 'modelNotReady' });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.availability).toEqual({ available: true });
  });

  it('refresh() triggers a manual re-check and flips loading synchronously', async () => {
    const provider = new MockProvider();
    const { result } = renderHook(() => useAvailability(provider));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.refresh();
    });
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.availability).toEqual({ available: true });
  });

  it('invokes the injectable resubscribe seam, re-checks when it fires, and cleans up on unmount', async () => {
    const provider = new MockProvider();
    let firedCheck: (() => void) | undefined;
    const cleanup = vi.fn();
    const resubscribe = (check: () => void): (() => void) => {
      firedCheck = check;
      return cleanup;
    };

    const { result, unmount } = renderHook(() => useAvailability(provider, { resubscribe }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(firedCheck).toBeDefined();

    act(() => {
      firedCheck?.();
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('polls via intervalMs', async () => {
    vi.useFakeTimers();
    try {
      const provider = new MockProvider();
      const availabilitySpy = vi.spyOn(provider, 'availability');

      renderHook(() => useAvailability(provider, { intervalMs: 1000 }));
      expect(availabilitySpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(availabilitySpy).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(availabilitySpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
