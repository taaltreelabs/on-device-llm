/**
 * `useAvailability` — mount-time (and refreshable) availability/capabilities
 * check for one `LLMProvider`.
 *
 * Isolation: this file may import `react` only (docs/plan.md §2's `.../react`
 * row; enforced for this directory by the ESLint override in
 * `eslint.config.cjs`). It must never import `react-native` or any
 * `expo`/`expo-*` package, which is why "re-check when the app returns to
 * foreground" (docs/plan.md §5 Phase 4) cannot be wired to `AppState`
 * directly here — see {@link UseAvailabilityOptions.resubscribe}.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Availability, Capabilities, LLMError, LLMProvider } from '../core';
import { toLLMError } from '../core';

/**
 * Options for {@link useAvailability}.
 */
export interface UseAvailabilityOptions {
  /**
   * Injectable subscription seam for "re-check when something outside React
   * changes" — the plan's motivating case is the app returning to the
   * foreground after a model download may have completed
   * (docs/plan.md §5 Phase 4). `src/react` cannot import `react-native`
   * (see the module doc), so it cannot wire `AppState` itself; instead it
   * accepts a function that does the wiring and calls `check()` when
   * appropriate, returning its own cleanup.
   *
   * Defaults to `undefined` (no resubscription — only mount, `provider`
   * changes, and `refresh()` trigger a check).
   *
   * Copy-paste starting point for a React Native / Expo app:
   *
   * ```ts
   * import { AppState } from 'react-native';
   *
   * const { availability, refresh } = useAvailability(provider, {
   *   resubscribe: (check) => {
   *     const subscription = AppState.addEventListener('change', (state) => {
   *       if (state === 'active') check();
   *     });
   *     return () => subscription.remove();
   *   },
   * });
   * ```
   *
   * A future release of the root (RN-permitted) entry point could ship this
   * wiring pre-built, e.g. `useAvailability(provider, { resubscribe: onForeground })`
   * exported from `@taaltreelabs/on-device-llm` rather than `.../react` —
   * out of scope for this hook, which has to stay importable with no RN in
   * its graph.
   */
  readonly resubscribe?: (check: () => void) => () => void;
  /**
   * Lazy polling alternative (or complement) to {@link resubscribe}: re-check
   * every `intervalMs` milliseconds while mounted. Omit (the default) for no
   * polling. Combine both if you want an immediate re-check on foreground
   * *and* a slow background poll as a fallback.
   */
  readonly intervalMs?: number;
}

/** Result of {@link useAvailability}. */
export interface UseAvailabilityResult {
  /** `undefined` until the first check resolves. */
  readonly availability: Availability | undefined;
  /** `undefined` until the first check resolves. */
  readonly capabilities: Capabilities | undefined;
  /** `true` while a check (initial, resubscribe-triggered, polled, or manual) is in flight. */
  readonly loading: boolean;
  /** Set when `availability()`/`capabilities()` themselves threw; cleared on the next successful check. */
  readonly error: LLMError | undefined;
  /** Manually trigger a re-check, e.g. from a "Refresh" button. */
  readonly refresh: () => void;
}

interface State {
  readonly availability: Availability | undefined;
  readonly capabilities: Capabilities | undefined;
  readonly loading: boolean;
  readonly error: LLMError | undefined;
}

const INITIAL_STATE: State = {
  availability: undefined,
  capabilities: undefined,
  loading: true,
  error: undefined,
};

/**
 * Check `provider.availability()` and `provider.capabilities()` on mount and
 * whenever `provider`'s identity changes, with a `refresh()` for manual
 * re-checks and an injectable seam for app-driven re-checks (see
 * {@link UseAvailabilityOptions.resubscribe}).
 *
 * **Superseded-request-safe**: if `provider` changes (or `refresh()`/the
 * resubscribe callback fires) while a check is in flight, the in-flight
 * check's result is discarded when it resolves — only the most recently
 * started check is ever applied to state. There is no cancellation of the
 * underlying `availability()`/`capabilities()` calls (neither method takes an
 * `AbortSignal` — docs/core/provider.ts), so this is done by tagging each
 * check with a generation counter rather than by aborting anything.
 */
export function useAvailability(
  provider: LLMProvider,
  options: UseAvailabilityOptions = {}
): UseAvailabilityResult {
  const { resubscribe, intervalMs } = options;

  const [state, setState] = useState<State>(INITIAL_STATE);

  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  // Does the actual fetch and applies the result — no setState call
  // reachable *synchronously* from its own body, only from the `.then`/
  // `.catch` continuations. That's deliberate: `react-hooks/set-state-in-effect`
  // flags a setState statically reachable directly from an effect body (see
  // the mount effect below, and the identical pattern/comment in the example
  // app's `App.tsx`), so the mount/provider-change effect calls this
  // directly rather than going through `check`, which sets `loading`
  // synchronously.
  const runCheck = useCallback((generation: number, activeProvider: LLMProvider): void => {
    Promise.all([activeProvider.availability(), activeProvider.capabilities()])
      .then(([availability, capabilities]) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState({ availability, capabilities, loading: false, error: undefined });
      })
      .catch((thrown: unknown) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: toLLMError(thrown, { providerId: activeProvider.id }),
        }));
      });
  }, []);

  // The manual/event-driven trigger: `refresh()`, a `resubscribe` firing, or
  // an interval tick. Always invoked from an event handler or an external
  // callback (never synchronously from an effect body), so flipping
  // `loading` on immediately here is lint-clean and gives instant feedback
  // for e.g. a "Refresh" button.
  const check = useCallback((): void => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setState((previous) => ({ ...previous, loading: true }));
    runCheck(generation, provider);
  }, [provider, runCheck]);

  // Mount, and every time `provider`'s identity changes. Trade-off: because
  // this calls `runCheck` (not `check`) to stay lint-clean, `loading` does
  // not flip visibly true for a provider-change re-check the way it does for
  // `refresh()` — only the *initial* mount's `loading: true` (from
  // `INITIAL_STATE`) is guaranteed. Call `refresh()` after switching
  // providers if a visible loading state matters for that transition.
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    runCheck(generation, provider);
  }, [provider, runCheck]);

  // The injectable foreground-resubscribe seam (see UseAvailabilityOptions).
  // Re-subscribes if the caller passes a new `resubscribe` function
  // reference; callers should keep it stable (define it outside the
  // component, or `useCallback` it) to avoid needless resubscription.
  useEffect(() => {
    if (resubscribe === undefined) return undefined;
    return resubscribe(check);
  }, [resubscribe, check]);

  // Lazy polling alternative.
  useEffect(() => {
    if (intervalMs === undefined) return undefined;
    const id = setInterval(check, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, check]);

  return {
    availability: state.availability,
    capabilities: state.capabilities,
    loading: state.loading,
    error: state.error,
    refresh: check,
  };
}
