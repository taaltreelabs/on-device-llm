/**
 * `useGenerate` — a one-shot (non-streaming) generation call, wired to React
 * state.
 *
 * Isolation: `react` only (see `useAvailability.ts`'s module doc).
 *
 * Unlike `useChat`, this hook does not own a conversation or run
 * `fitContext` — it is a thin, stateful wrapper around
 * `LLMProvider.generate()` for schema/tool calls that stand alone (the JSON
 * demo and tool demo in the example app are exactly this shape). Callers
 * that want context-window trimming should run `fitContext` themselves
 * before calling {@link UseGenerateResult.generate}, the same way `useChat`
 * does internally.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  GenerateRequest,
  GenerateResult,
  LLMError,
  LLMProvider,
  RequestOptions,
} from '../core';
import { toLLMError } from '../core';

/** Result of {@link useGenerate}. */
export interface UseGenerateResult {
  /**
   * Run one generation. **Superseded-safe**: if a second call starts before
   * the first resolves, the first call's resolution still updates its own
   * caller's promise, but is *not* applied to `result`/`object`/`loading`/
   * `error` — only the most recently started call's outcome ever reaches
   * hook state, so a fast-then-slow race can't have the slow call's stale
   * result clobber the fast one's.
   *
   * `opts.signal`, if given, is chained into the internal
   * `AbortController` used by {@link abort} — aborting either one aborts the
   * call.
   */
  readonly generate: (request: GenerateRequest, opts?: RequestOptions) => Promise<GenerateResult>;
  /** The most recent call's result, once applied (see the supersede note above). `undefined` until the first call resolves. */
  readonly result: GenerateResult | undefined;
  /** Shorthand for `result?.object`. */
  readonly object: unknown;
  /** `true` while the most recently started call is in flight. */
  readonly loading: boolean;
  /** The most recent call's failure, once applied. Cleared at the start of the next call. */
  readonly error: LLMError | undefined;
  /** Abort the in-flight call, if any (whichever call started most recently). A no-op otherwise. */
  readonly abort: () => void;
}

/** One-shot `generate()` calls against `provider`, with loading/result/error state and abort support. */
export function useGenerate(provider: LLMProvider): UseGenerateResult {
  const [result, setResult] = useState<GenerateResult | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LLMError | undefined>(undefined);

  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    },
    []
  );

  const abort = useCallback((): void => {
    controllerRef.current?.abort();
  }, []);

  const generate = useCallback(
    async (request: GenerateRequest, opts?: RequestOptions): Promise<GenerateResult> => {
      generationRef.current += 1;
      const generation = generationRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;

      const externalSignal = opts?.signal;
      if (externalSignal !== undefined) {
        if (externalSignal.aborted) {
          controller.abort(externalSignal.reason);
        } else {
          externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), {
            once: true,
          });
        }
      }

      const isCurrent = (): boolean => mountedRef.current && generation === generationRef.current;

      if (isCurrent()) {
        setLoading(true);
        setError(undefined);
      }

      try {
        const outcome = await provider.generate(request, {
          ...opts,
          signal: controller.signal,
        });
        if (isCurrent()) {
          setResult(outcome);
          setLoading(false);
        }
        return outcome;
      } catch (thrown) {
        const llmError = toLLMError(thrown, { providerId: provider.id });
        if (isCurrent()) {
          setError(llmError);
          setLoading(false);
        }
        throw llmError;
      } finally {
        if (controllerRef.current === controller) controllerRef.current = undefined;
      }
    },
    [provider]
  );

  return { generate, result, object: result?.object, loading, error, abort };
}
