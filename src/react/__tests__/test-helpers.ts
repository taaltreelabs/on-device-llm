/**
 * Shared test helpers for `src/react`'s hook tests.
 *
 * Not itself a test file (no `.test.ts` suffix, so `vitest.config.mts`'s
 * `include` glob skips it) and not subject to the `.../react` isolation
 * override in `eslint.config.cjs` scope-wise it is, but it only imports
 * `../../core`, so it stays compliant regardless.
 */

import {
  UNKNOWN,
  type Availability,
  type Capabilities,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type RequestOptions,
  type StreamEvent,
} from '../../core';

/** A promise plus its resolve/reject, for controlling exactly when an async call settles. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

export function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DEFAULT_CAPABILITIES: Capabilities = {
  contextWindow: UNKNOWN,
  streaming: true,
  structuredOutput: false,
  tools: false,
  tokenCounting: 'none',
  locales: UNKNOWN,
};

/**
 * A minimal `LLMProvider` whose `availability()` calls can be controlled one
 * at a time from a test, via {@link ControllableProvider.queueCheck}.
 *
 * `MockProvider` (src/core/mock-provider.ts) scripts `generate`/`stream`
 * turns, not `availability()`/`capabilities()` timing, so it can't exercise
 * "two checks in flight, resolved out of order" — this stands in just for
 * that case. Any call beyond what was queued resolves immediately to
 * `{ available: true }`, so mount effects in tests that don't care about
 * timing don't need to queue anything.
 */
export class ControllableProvider implements LLMProvider {
  readonly id: string;
  private readonly queue: Deferred<Availability>[] = [];
  calls = 0;

  constructor(id = 'controllable') {
    this.id = id;
  }

  /** Queue the result of the next `availability()` call. Resolve/reject it whenever the test wants. */
  queueCheck(): Deferred<Availability> {
    const deferred = makeDeferred<Availability>();
    this.queue.push(deferred);
    return deferred;
  }

  async availability(): Promise<Availability> {
    this.calls += 1;
    const deferred = this.queue.shift();
    if (deferred === undefined) return { available: true };
    return deferred.promise;
  }

  async capabilities(): Promise<Capabilities> {
    return DEFAULT_CAPABILITIES;
  }

  async generate(_request: GenerateRequest, _options?: RequestOptions): Promise<GenerateResult> {
    throw new Error(
      'ControllableProvider.generate is not implemented — this provider is for useAvailability tests only.'
    );
  }

  async *stream(
    _request: GenerateRequest,
    _options?: RequestOptions
  ): AsyncGenerator<StreamEvent, void, undefined> {
    throw new Error(
      'ControllableProvider.stream is not implemented — this provider is for useAvailability tests only.'
    );
  }
}
