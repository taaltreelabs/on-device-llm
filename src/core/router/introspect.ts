/**
 * Asking providers what they are, without asking them too often.
 *
 * `availability()` is documented as cheap enough to call on app start and on
 * foreground — not cheap enough to call twice per provider on every keystroke
 * that turns into a request. On the Apple provider each call is a bridge hop
 * plus a `SystemLanguageModel` query; behind a router of three providers, an
 * uncached routing decision is six native round trips before a single token is
 * generated.
 *
 * So the routing path reads through a short-TTL cache. The public
 * `availability()` / `capabilities()` on the router deliberately do **not** —
 * they are the explicit "check now" calls (and the way to invalidate the
 * cache). Staleness semantics are spelled out on {@link FactsCache}.
 */

import type { Availability } from '../availability';
import { UNKNOWN, type Capabilities } from '../capabilities';
import type { LLMProvider } from '../provider';

/** One provider's self-description, as of {@link ProviderFacts.fetchedAt}. */
export interface ProviderFacts {
  readonly availability: Availability;
  readonly capabilities: Capabilities;
  /** `Date.now()` when the lookup started. */
  readonly fetchedAt: number;
}

/**
 * What we assume about a provider whose `capabilities()` rejected.
 *
 * Conservative on purpose: a provider that cannot describe itself should not
 * be handed a request that depends on a capability it claimed. It stays
 * routable — nothing here disqualifies it on its own — but a `require` block
 * will pass it over, which is the right outcome for something that is not
 * answering questions about itself.
 */
const OPAQUE_CAPABILITIES: Capabilities = {
  contextWindow: UNKNOWN,
  streaming: false,
  structuredOutput: false,
  tools: false,
  tokenCounting: 'none',
  locales: UNKNOWN,
};

/**
 * The default routing-cache TTL, in milliseconds.
 *
 * Five seconds: long enough that a burst of requests (a chat screen, a retry,
 * a `useChat` render loop) introspects once, short enough that a model finishing
 * its download or Apple Intelligence being switched on is picked up within a
 * turn or two without anyone calling anything.
 */
export const DEFAULT_ROUTE_CACHE_TTL_MS = 5_000;

/**
 * Per-provider cache of `availability()` + `capabilities()`.
 *
 * **Staleness semantics**, which are the whole reason this is safe:
 *
 * - A stale **`available: true`** costs nothing that a fresh one would not.
 *   DECISIONS.md D9 is explicit that `available` never meant "the next request
 *   will succeed": the request can fail anyway, and the failure is exactly
 *   what the fallback chain is built to absorb. Freshness buys no guarantee
 *   here, so it is not worth a bridge hop.
 * - A stale **`available: false`** is the direction that can cost something —
 *   a provider that just became usable is passed over for up to the TTL. That
 *   is bounded, it self-corrects, and the alternative (the fallback chain
 *   still reaches it) only ever *adds* a failed request.
 * - A stale **capability** cannot change between app launches for any provider
 *   we ship (window, streaming, tools, tokenizer); `capabilities()` is already
 *   documented as cacheable for the life of a process.
 *
 * Concurrent lookups share one in-flight promise, so ten requests fired at once
 * introspect once. Lookups never reject: a rejecting `availability()` is
 * recorded as unavailable (`unsupportedPlatform`), which is how a provider that
 * throws on a platform it does not support ends up routed around instead of
 * taking the whole request down.
 */
export class FactsCache {
  private readonly entries = new Map<
    string,
    { expiresAt: number; facts: Promise<ProviderFacts> }
  >();

  constructor(private readonly ttlMs: number) {}

  /** Cached facts, refetching only once the TTL has passed. */
  get(provider: LLMProvider): Promise<ProviderFacts> {
    const now = Date.now();
    const hit = this.entries.get(provider.id);
    if (hit !== undefined && hit.expiresAt > now) return hit.facts;
    return this.refresh(provider);
  }

  /** Fetch now and reprime the cache. Used by the router's public `availability()`/`capabilities()`. */
  refresh(provider: LLMProvider): Promise<ProviderFacts> {
    const now = Date.now();
    const facts = load(provider, now);
    this.entries.set(provider.id, { expiresAt: now + this.ttlMs, facts });
    return facts;
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear();
  }
}

async function load(provider: LLMProvider, fetchedAt: number): Promise<ProviderFacts> {
  const [availability, capabilities] = await Promise.all([
    provider.availability().catch((): Availability => ({
      available: false,
      reason: 'unsupportedPlatform',
      detail: `${provider.id}: availability() failed`,
    })),
    provider.capabilities().catch(() => OPAQUE_CAPABILITIES),
  ]);
  return { availability, capabilities, fetchedAt };
}
