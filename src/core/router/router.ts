/**
 * `createRouter` — several providers behind one `LLMProvider`.
 *
 * The router is itself a provider (`provider.ts`, contract point 4), so
 * routers compose and nothing downstream — the context manager, the hooks, an
 * app's own code — can tell whether it holds one model or five.
 *
 * Three rules shape everything below.
 *
 * 1. **Pick before failing, but expect to fail anyway.** Policy uses
 *    availability, capabilities and token counts to avoid doomed requests, and
 *    DECISIONS.md D9 says none of that is a guarantee, so the fallback chain is
 *    the real mechanism and the policy is an optimisation over it.
 * 2. **One shot per provider.** A provider is tried at most once per request.
 *    Same-provider retry is an app concern: it needs backoff, jitter, and a
 *    budget, all of which belong to the caller who knows whether this is a
 *    background summarisation or a user staring at a spinner. A router that
 *    retried internally would also make `attempts` a poor telemetry signal.
 * 3. **Never say more than we know.** `onRoute` carries ids, codes and
 *    durations — never a prompt, never a response, never an error message that
 *    might quote one (docs/plan.md §5).
 */

import type { Availability, UnavailableReason } from '../availability';
import { isUnknown, UNKNOWN, type Capabilities } from '../capabilities';
import { LLMError, toLLMError, type LLMErrorCode } from '../errors';
import { estimateTokens, type EstimateTokensOptions } from '../estimate-tokens';
import type { GenerateRequest, GenerateResult } from '../generation';
import type { Message } from '../messages';
import type { LLMProvider, RequestOptions } from '../provider';
import type { StreamEvent } from '../stream';
import { resolveTriggers, shouldFallBack, type FallbackTriggers } from './fallback';
import { FactsCache, DEFAULT_ROUTE_CACHE_TTL_MS, type ProviderFacts } from './introspect';
import {
  planRoute,
  type RouteCandidate,
  type RouteEligibility,
  type RoutePolicy,
  type RoutePolicyContext,
  type RoutePolicyRules,
  type RouteReason,
  type RouteSkipReason,
} from './policy';

/**
 * What happened at one provider.
 *
 * `'ok'` — it answered. An {@link LLMErrorCode} — it threw that. `'skipped:…'`
 * — the policy passed it over without asking (see {@link RouteSkipReason}).
 */
export type RouteOutcome = 'ok' | LLMErrorCode | `skipped:${RouteSkipReason}`;

/** One entry in the chain, in the order the router considered providers. */
export interface RouteAttempt {
  /** The provider's `id` — for a nested router, the *inner router's* id, not the provider inside it. */
  readonly providerId: string;
  readonly outcome: RouteOutcome;
  /**
   * Wall-clock milliseconds spent at this provider. `0` for a skip (the
   * introspection it rests on is shared and cached, so charging it to one
   * provider would be a lie).
   */
  readonly durationMs: number;
}

/**
 * The routing decision for one request, handed to `onRoute` exactly once.
 *
 * **Content-free by construction.** Every field is an id, an enum, a boolean,
 * or a number. There is deliberately no `request`, no `messages`, no `error`
 * and no message string: a telemetry hook is the single most likely place for
 * prompt text to leak into a log aggregator, and the only reliable way to
 * prevent that is not to hand it over.
 */
export interface RouteReport {
  /** Unique per request, so a stream's report can be tied to other telemetry. */
  readonly requestId: string;
  /**
   * The provider whose outcome the caller received: the one that answered, or
   * the one whose error was thrown. `undefined` only when no provider was
   * asked at all (every one was skipped), which is also the only case where
   * `why` is `'exhausted'`.
   */
  readonly providerId?: string;
  /** Why that provider was the one asked. */
  readonly why: RouteReason;
  /** Every provider considered, in order. */
  readonly attempts: readonly RouteAttempt[];
  /** Did an earlier provider fail and hand the request on? */
  readonly fellBack: boolean;
}

/** Telemetry hook. Must not throw; if it does, the router swallows it. */
export type OnRoute = (report: RouteReport) => void;

/** Everything `createRouter` takes. */
export interface RouterConfig {
  /**
   * The providers, **in order of preference**. The order is the fallback
   * order, and it is what a policy without a `preferred` or `select` follows.
   * Must be non-empty, and ids must be unique (they are the only handle a
   * policy, a report, or a test has on a provider).
   */
  readonly providers: readonly LLMProvider[];
  /** The router's own `id`. Defaults to `'router'`; give nested routers distinct ids. */
  readonly id?: string;
  /** How to pick the first provider to try. See {@link RoutePolicy}. */
  readonly policy?: RoutePolicy;
  /** Which failures move to the next provider. See {@link FallbackTriggers}. */
  readonly fallback?: FallbackTriggers;
  /** Telemetry. Called once per `generate()` and once per `stream()`. */
  readonly onRoute?: OnRoute;
  /**
   * How long `availability()`/`capabilities()` results are reused on the
   * routing path, in milliseconds. Defaults to
   * {@link DEFAULT_ROUTE_CACHE_TTL_MS}; `0` disables caching. The router's own
   * `availability()`/`capabilities()` always refresh, whatever this says.
   */
  readonly cacheTtlMs?: number;
  /** Tuning for the `estimateTokens` fallback used by the context-window check. */
  readonly estimate?: EstimateTokensOptions;
}

/**
 * Unreachable in practice (a router always has at least one provider), but
 * `capabilities()` may not throw, so the type system gets a total expression
 * instead of a non-null assertion.
 */
const OPAQUE_ROUTER_CAPABILITIES: Capabilities = {
  contextWindow: UNKNOWN,
  streaming: false,
  structuredOutput: false,
  tools: false,
  tokenCounting: 'none',
  locales: UNKNOWN,
};

/** The providers the plan is willing to ask, in the order it will ask them. */
function eligible(order: readonly RouteEligibility[]): readonly RouteEligibility[] {
  return order.filter((entry) => entry.skip === undefined);
}

function invalid(message: string): LLMError {
  return new LLMError({ code: 'invalidRequest' }, { message });
}

/**
 * Coarsest-to-finest ordering for aggregating several providers' unavailability
 * into one reason. Most *hopeful* first: "the model is still downloading"
 * tells a user something to do, "this platform has no such thing" does not.
 */
const REASON_PRECEDENCE: readonly UnavailableReason[] = [
  'modelNotReady',
  'notEnabled',
  'deviceNotEligible',
  'unsupportedPlatform',
];

function aggregateUnavailable(
  entries: readonly { readonly id: string; readonly availability: Availability }[]
): { reason: UnavailableReason; detail: string } {
  const reasons = entries.flatMap((entry) =>
    entry.availability.available ? [] : [entry.availability.reason]
  );
  const reason =
    REASON_PRECEDENCE.find((candidate) => reasons.includes(candidate)) ?? 'unsupportedPlatform';
  const detail = entries
    .map((entry) =>
      entry.availability.available
        ? `${entry.id}: available`
        : `${entry.id}: ${entry.availability.reason}`
    )
    .join('; ');
  return { reason, detail };
}

/**
 * Build one router.
 *
 * ```ts
 * const llm = createRouter({
 *   providers: [apple, openai],
 *   policy: { preferred: 'apple', tags: { reasoning: { preferred: 'openai' } } },
 *   fallback: { guardrail: false },
 *   onRoute: (report) => analytics.track('llm_route', report),
 * });
 * ```
 *
 * @throws LLMError `invalidRequest` — synchronously, at construction — for an
 * empty provider list, duplicate provider ids, or a negative `cacheTtlMs`. A
 * misconfigured router is a programming error and should fail where it is
 * built, not on the first request in front of a user.
 */
export function createRouter(config: RouterConfig): LLMProvider {
  const providers = [...config.providers];
  if (providers.length === 0) {
    throw invalid('createRouter: `providers` must contain at least one provider');
  }
  const ids = providers.map((provider) => provider.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw invalid(
      `createRouter: provider ids must be unique within a router, but "${duplicate}" appears twice`
    );
  }
  const ttlMs = config.cacheTtlMs ?? DEFAULT_ROUTE_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw invalid(`createRouter: cacheTtlMs must be a non-negative finite number, got ${ttlMs}`);
  }

  const id = config.id ?? 'router';
  const triggers = resolveTriggers(config.fallback);
  const cache = new FactsCache(ttlMs);
  const rules: RoutePolicyRules =
    typeof config.policy === 'function' ? { select: config.policy } : (config.policy ?? {});

  let requestCounter = 0;
  const nextRequestId = (): string =>
    `${id}-${++requestCounter}-${Math.random().toString(36).slice(2, 8)}`;

  const report = (payload: RouteReport): void => {
    if (config.onRoute === undefined) return;
    try {
      config.onRoute(payload);
    } catch {
      // Telemetry must never fail a generation. A throwing callback is the
      // app's bug and its own `try` is the place to see it; ours is not.
    }
  };

  const throwIfAborted = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted === true) {
      throw new LLMError({ code: 'cancelled' }, { providerId: id, cause: signal.reason });
    }
  };

  /** Tokens for one candidate, spending a `countTokens()` call only when it can change the answer. */
  async function tokensFor(
    provider: LLMProvider,
    capabilities: Capabilities,
    request: GenerateRequest,
    baseline: number
  ): Promise<Pick<RouteCandidate, 'tokens' | 'tokenSource'>> {
    if (isUnknown(capabilities.contextWindow) || provider.countTokens === undefined) {
      return { tokens: baseline, tokenSource: 'estimate' };
    }
    try {
      const counted = await provider.countTokens(request.messages);
      if (typeof counted === 'number' && Number.isFinite(counted) && counted >= 0) {
        return { tokens: Math.ceil(counted), tokenSource: 'provider' };
      }
    } catch {
      // DECISIONS.md D9: a counter that throws is a bad day, not a verdict on
      // the request. Estimate and carry on — the estimate is pessimistic, so
      // the worst case is one unnecessary hop to the next provider.
    }
    return { tokens: baseline, tokenSource: 'estimate' };
  }

  async function buildContext(request: GenerateRequest): Promise<RoutePolicyContext> {
    const baseline = estimateTokens(request.messages, config.estimate);
    const candidates = await Promise.all(
      providers.map(async (provider, index): Promise<RouteCandidate> => {
        const facts = await cache.get(provider);
        const { tokens, tokenSource } = await tokensFor(
          provider,
          facts.capabilities,
          request,
          baseline
        );
        const window = facts.capabilities.contextWindow;
        const needed = tokens + (request.maxOutputTokens ?? 0);
        return {
          provider,
          id: provider.id,
          index,
          availability: facts.availability,
          capabilities: facts.capabilities,
          tokens,
          tokenSource,
          fitsContextWindow: isUnknown(window) ? 'unknown' : needed <= window,
        };
      })
    );
    return {
      request,
      ...(request.taskTag !== undefined ? { taskTag: request.taskTag } : {}),
      estimatedTokens: baseline,
      candidates,
    };
  }

  /**
   * The error to throw when the policy left nothing to try.
   *
   * Synthesised only in this one case — when a provider *was* tried, its own
   * error is rethrown verbatim (see the chain runners), because a
   * `RouterExhaustedError` would add a class to a taxonomy whose whole point is
   * that there is exactly one (DECISIONS.md D31).
   */
  function nothingToTry(order: readonly RouteEligibility[]): LLMError {
    const skipped = order.filter(
      (entry): entry is RouteEligibility & { skip: RouteSkipReason } => entry.skip !== undefined
    );
    if (skipped.every((entry) => entry.skip === 'unavailable')) {
      const { reason, detail } = aggregateUnavailable(
        skipped.map((entry) => ({
          id: entry.candidate.id,
          availability: entry.candidate.availability,
        }))
      );
      return new LLMError(
        { code: 'unavailable', reason },
        { providerId: id, message: `No provider is available (${detail})` }
      );
    }
    const overflowed = skipped.find((entry) => entry.skip === 'contextWindow');
    if (overflowed !== undefined) {
      const window = overflowed.candidate.capabilities.contextWindow;
      return new LLMError(
        {
          code: 'contextOverflow',
          ...(isUnknown(window) ? {} : { contextSize: window }),
          tokenCount: overflowed.candidate.tokens,
        },
        { providerId: id }
      );
    }
    const detail = skipped.map((entry) => `${entry.candidate.id}: ${entry.skip}`).join('; ');
    return new LLMError(
      { code: 'invalidRequest' },
      { providerId: id, message: `No provider satisfied the routing policy (${detail})` }
    );
  }

  /** Bookkeeping shared by `generate` and `stream`. */
  class Chain {
    readonly requestId = nextRequestId();
    readonly attempts: RouteAttempt[] = [];
    fellBack = false;
    why: RouteReason;
    private attempted = false;
    private reported = false;
    private chosen: string | undefined;

    constructor(why: RouteReason) {
      this.why = why;
    }

    /**
     * Record every provider the policy passed over, before anything is tried.
     *
     * Up front rather than as the chain walks past them, because the walk
     * stops at the first provider that answers — and "the on-device model was
     * skipped because the conversation outgrew its window" is *exactly* the
     * telemetry an app wants on the requests that then succeeded in the cloud.
     * So `attempts` reads: everything passed over (in configured order), then
     * everything asked (in the order it was asked).
     */
    recordSkips(order: readonly RouteEligibility[]): void {
      for (const entry of order) {
        if (entry.skip === undefined) continue;
        this.attempts.push({
          providerId: entry.candidate.id,
          outcome: `skipped:${entry.skip}`,
          durationMs: 0,
        });
      }
    }

    /** Call immediately before asking a provider. Returns the start timestamp. */
    begin(providerId: string): number {
      if (this.attempted) {
        this.fellBack = true;
        this.why = 'fallback';
      }
      this.attempted = true;
      this.chosen = providerId;
      return Date.now();
    }

    finish(providerId: string, outcome: RouteOutcome, startedAt: number): void {
      this.attempts.push({ providerId, outcome, durationMs: Date.now() - startedAt });
    }

    /** Fire `onRoute`. Idempotent, so a `finally` can call it without checking. */
    emit(): void {
      if (this.reported) return;
      this.reported = true;
      report({
        requestId: this.requestId,
        ...(this.chosen !== undefined ? { providerId: this.chosen } : {}),
        why: this.chosen === undefined ? 'exhausted' : this.why,
        attempts: [...this.attempts],
        fellBack: this.fellBack,
      });
    }
  }

  async function generate(
    request: GenerateRequest,
    options?: RequestOptions
  ): Promise<GenerateResult> {
    throwIfAborted(options?.signal);
    const context = await buildContext(request);
    const plan = planRoute(config.policy, context);
    const chain = new Chain(plan.reason);
    let lastError: LLMError | undefined;

    try {
      chain.recordSkips(plan.order);
      for (const entry of eligible(plan.order)) {
        throwIfAborted(options?.signal);
        const startedAt = chain.begin(entry.candidate.id);
        try {
          const result = await entry.candidate.provider.generate(request, options);
          chain.finish(entry.candidate.id, 'ok', startedAt);
          return result;
        } catch (thrown) {
          const error = toLLMError(thrown, { providerId: entry.candidate.id });
          chain.finish(entry.candidate.id, error.code, startedAt);
          lastError = error;
          if (!shouldFallBack(error, triggers)) throw error;
        }
      }
      throw lastError ?? nothingToTry(plan.order);
    } finally {
      chain.emit();
    }
  }

  /**
   * The streaming chain.
   *
   * The fallback window closes on the **first event handed to the consumer**,
   * not on the first event received from the provider: a router that buffered a
   * stream to widen its own window would turn every stream into a
   * non-stream, which is the thing streaming exists to avoid. So events are
   * forwarded as they arrive, and the moment one is, a later failure
   * propagates (docs/plan.md §4: "a response that switches models halfway
   * through is worse than an error"). `toolCall` counts — by the time a
   * consumer sees one, a tool the app wrote has already run, and a second
   * provider would run it again.
   */
  async function* stream(
    request: GenerateRequest,
    options?: RequestOptions
  ): AsyncGenerator<StreamEvent, void, undefined> {
    throwIfAborted(options?.signal);
    const context = await buildContext(request);
    const plan = planRoute(config.policy, context);
    const chain = new Chain(plan.reason);
    let lastError: LLMError | undefined;
    let inFlight: { providerId: string; startedAt: number } | undefined;

    try {
      chain.recordSkips(plan.order);
      for (const entry of eligible(plan.order)) {
        throwIfAborted(options?.signal);
        const startedAt = chain.begin(entry.candidate.id);
        inFlight = { providerId: entry.candidate.id, startedAt };
        let yielded = false;
        try {
          for await (const event of entry.candidate.provider.stream(request, options)) {
            yielded = true;
            yield event;
          }
          inFlight = undefined;
          chain.finish(entry.candidate.id, 'ok', startedAt);
          return;
        } catch (thrown) {
          inFlight = undefined;
          const error = toLLMError(thrown, { providerId: entry.candidate.id });
          chain.finish(entry.candidate.id, error.code, startedAt);
          lastError = error;
          if (yielded || !shouldFallBack(error, triggers)) throw error;
        }
      }
      throw lastError ?? nothingToTry(plan.order);
    } finally {
      // A consumer that `break`s out of its `for await` closes this generator
      // here, with a provider still mid-response. That is a cancellation by
      // the consumer, and it is recorded as one rather than as a success.
      if (inFlight !== undefined) {
        chain.finish(inFlight.providerId, 'cancelled', inFlight.startedAt);
      }
      chain.emit();
    }
  }

  /** Every provider's current facts, freshly fetched. */
  async function refreshAll(): Promise<readonly { provider: LLMProvider; facts: ProviderFacts }[]> {
    return Promise.all(
      providers.map(async (provider) => ({ provider, facts: await cache.refresh(provider) }))
    );
  }

  /**
   * The available provider a request with no other information would reach:
   * `policy.preferred` when it qualifies, otherwise the first in configured
   * order. Used by `capabilities`, `countTokens` and `prewarm`.
   */
  function pickPreferred<T extends { provider: LLMProvider; facts: ProviderFacts }>(
    entries: readonly T[],
    extra: (entry: T) => boolean = () => true
  ): T | undefined {
    const usable = entries.filter((entry) => entry.facts.availability.available && extra(entry));
    return usable.find((entry) => entry.provider.id === rules.preferred) ?? usable[0] ?? undefined;
  }

  /** Cached facts for every provider, for the delegating surface methods. */
  async function cachedAll(): Promise<readonly { provider: LLMProvider; facts: ProviderFacts }[]> {
    return Promise.all(
      providers.map(async (provider) => ({ provider, facts: await cache.get(provider) }))
    );
  }

  /**
   * Available iff **any** provider is. A router's job is to find a working
   * provider, so it is usable exactly when one of them is; reporting the
   * preferred provider's answer would make a perfectly functional router claim
   * to be broken because the on-device model is still downloading.
   *
   * When none is available the reason is the most hopeful one reported (a
   * download in progress beats an ineligible device), and `detail` lists every
   * provider's verdict — ids and reason codes only.
   */
  async function availability(): Promise<Availability> {
    const entries = await refreshAll();
    if (entries.some((entry) => entry.facts.availability.available)) return { available: true };
    const { reason, detail } = aggregateUnavailable(
      entries.map((entry) => ({ id: entry.provider.id, availability: entry.facts.availability }))
    );
    return { available: false, reason, detail };
  }

  /**
   * The **preferred available provider's** capabilities, verbatim — never a
   * merge.
   *
   * A merged answer is a lie in both directions. Union the booleans and the
   * router claims tool calling that the provider actually chosen cannot do;
   * intersect them and it denies structured output that the provider it is
   * about to use supports perfectly well, so callers stop asking for it. Take
   * the largest `contextWindow` and the context manager budgets 128K for a
   * request that is about to go to a 4K on-device model. One provider's honest
   * answer beats a synthetic one nobody can act on, and the request that
   * follows will most likely go to that same provider.
   *
   * Refreshed per call (the routing cache is bypassed) so that a provider
   * becoming available changes the answer immediately. With nothing available
   * at all, the first configured provider answers — the contract forbids
   * throwing here, and `availability()` is where the bad news belongs.
   */
  async function capabilities(): Promise<Capabilities> {
    const entries = await refreshAll();
    // `providers` is validated non-empty, so `entries[0]` exists; the fallback
    // keeps the expression total for the type system.
    const picked = pickPreferred(entries) ?? entries[0];
    return picked === undefined ? OPAQUE_ROUTER_CAPABILITIES : picked.facts.capabilities;
  }

  /**
   * Delegates to the preferred available provider that has a counter. When no
   * available provider can count it **throws** rather than estimating:
   * `createMeasure` catches exactly this and records
   * `estimatorAfterCounterFailure`, which widens the safety margin from 64 to
   * 256 tokens (DECISIONS.md D10). A silent estimate here would keep the narrow
   * margin under an exact-looking number — the documented way to overflow a
   * "measured" budget.
   */
  async function countTokens(messages: readonly Message[]): Promise<number> {
    const entries = await cachedAll();
    const picked = pickPreferred(entries, (entry) => entry.provider.countTokens !== undefined);
    const counter = picked?.provider.countTokens;
    if (counter === undefined) {
      const { reason, detail } = aggregateUnavailable(
        entries.map((entry) => ({ id: entry.provider.id, availability: entry.facts.availability }))
      );
      throw new LLMError(
        { code: 'unavailable', reason },
        { providerId: id, message: `No available provider can count tokens (${detail})` }
      );
    }
    return counter.call(picked?.provider, messages);
  }

  /**
   * Forwards to the preferred available provider that has `prewarm`, and
   * answers `false` when there is nothing to forward to. Never throws — a hint
   * that failed is still only a hint (DECISIONS.md D26).
   */
  async function prewarm(messages?: readonly Message[]): Promise<boolean> {
    try {
      const entries = await cachedAll();
      const picked = pickPreferred(entries, (entry) => entry.provider.prewarm !== undefined);
      const hint = picked?.provider.prewarm;
      if (hint === undefined) return false;
      return await hint.call(picked?.provider, messages);
    } catch {
      return false;
    }
  }

  const router: LLMProvider = { id, availability, capabilities, generate, stream };

  // `countTokens` and `prewarm` are optional *per instance*, so their presence
  // is decided once, here: a method cannot appear later because a provider
  // came back, and a caller that captured `router.countTokens` once must not
  // find it gone. Present iff **some** configured provider has it — which
  // provider serves the call is decided per call.
  if (providers.some((provider) => provider.countTokens !== undefined)) {
    router.countTokens = countTokens;
  }
  if (providers.some((provider) => provider.prewarm !== undefined)) {
    router.prewarm = prewarm;
  }

  return router;
}
