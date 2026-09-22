/**
 * Routing policy: how the router picks the **first** provider to try.
 *
 * The shape is *data plus an escape hatch* (DECISIONS.md D28). The declarative
 * form covers what apps actually ask for — "prefer on-device, but send
 * reasoning work to the cloud", "never send a request needing tools to a
 * provider that has none" — and stays inspectable, serializable, and testable
 * without running it. The function form ({@link RoutePolicyFunction}) exists
 * because no fixed vocabulary survives contact with a real app, and the
 * alternative to an escape hatch is a config language that grows one field per
 * user.
 *
 * Everything in here is a pure decision over facts the router has already
 * gathered ({@link RouteCandidate}). Fetching those facts, caching them, and
 * acting on the choice live in `router.ts`.
 */

import type { Availability } from '../availability';
import { isUnknown, type Capabilities, type TokenCounting } from '../capabilities';
import type { GenerateRequest } from '../generation';
import type { LLMProvider } from '../provider';

/**
 * Why a provider was passed over without being asked to generate.
 *
 * Surfaced in `onRoute` as `skipped:<reason>` so telemetry can tell "the
 * on-device model was busy" from "the on-device model could never have served
 * this request".
 */
export type RouteSkipReason =
  /** `availability()` said no — or rejected, which is treated the same way. */
  | 'unavailable'
  /** The request certainly does not fit this provider's *known* context window. */
  | 'contextWindow'
  /** A `require` capability constraint (streaming, tools, structured output, token counting) failed. */
  | 'capability'
  /** `require.locale` is not in this provider's enumerated `capabilities().locales`. */
  | 'locale'
  /** A `where` predicate returned `false`. */
  | 'policy';

/** How the token number used for the context-window check was obtained. */
export type RouteTokenSource =
  /** The provider's own `countTokens()`. */
  | 'provider'
  /** `estimateTokens` — the provider has no counter, its counter threw, or its window is `UNKNOWN`. */
  | 'estimate';

/**
 * Everything the router knows about one provider for one request.
 *
 * Handed to policy predicates so an app can decide on the same facts the
 * router uses, rather than re-deriving them (and paying for the native calls
 * again).
 */
export interface RouteCandidate {
  /** The provider itself, so a predicate can reach provider-specific extras. */
  readonly provider: LLMProvider;
  /** `provider.id`, hoisted for convenience. */
  readonly id: string;
  /** Position in the configured `providers` array; `0` is the most preferred. */
  readonly index: number;
  /** What `availability()` reported (cached — see `cacheTtlMs`). */
  readonly availability: Availability;
  /**
   * What `capabilities()` reported (cached). A provider whose `capabilities()`
   * rejected is described conservatively: everything `false`/`UNKNOWN`.
   */
  readonly capabilities: Capabilities;
  /**
   * Tokens this request costs, as measured for *this* provider.
   *
   * The provider's own `countTokens()` when it has one **and** a known context
   * window (the only case where an exact number can change the decision);
   * `estimateTokens` otherwise. See {@link tokenSource}.
   */
  readonly tokens: number;
  /** Where {@link tokens} came from. */
  readonly tokenSource: RouteTokenSource;
  /**
   * Does the request fit this provider's context window?
   *
   * `'unknown'` when `capabilities().contextWindow` is `UNKNOWN`, which is
   * **not** treated as a failure: per DECISIONS.md D11 every cloud endpoint is
   * in that state, and a provider that cannot describe its window still
   * reports a real `contextOverflow` (with real numbers) if the request is
   * genuinely too big.
   */
  readonly fitsContextWindow: boolean | 'unknown';
}

/** Facts about the request, shared by every candidate. */
export interface RoutePolicyContext {
  /** The request being routed. Prompt content is present here and must never be logged by a policy. */
  readonly request: GenerateRequest;
  /** `request.taskTag`, hoisted. */
  readonly taskTag?: string;
  /** `estimateTokens(request.messages)` — the provider-independent baseline. */
  readonly estimatedTokens: number;
  /** Every configured provider, in configured order, already introspected. */
  readonly candidates: readonly RouteCandidate[];
}

/** Predicate form of a constraint: `true` keeps the candidate. */
export type RoutePredicate = (candidate: RouteCandidate, context: RoutePolicyContext) => boolean;

/**
 * Function form of a policy: return the `id` of the provider to try first, or
 * `undefined` to let the declarative rules decide.
 *
 * The escape hatch is deliberately *narrow*: it chooses a starting point, not
 * an execution plan. Fallback order after that stays the configured order, so
 * a policy function cannot accidentally reinvent the fallback machinery (or
 * silently disable it).
 *
 * A chosen id that failed the `require` filters is still honoured — an explicit
 * choice beats a declarative filter, and the facts needed to check
 * (availability, capabilities, tokens) were all in the context. An id that
 * names no configured provider is ignored.
 */
export type RoutePolicyFunction = (context: RoutePolicyContext) => string | undefined;

/**
 * Hard constraints. A candidate failing any of these is skipped, never tried.
 *
 * Only ever *narrows* the field: constraints cannot promote a provider, so a
 * `require` block can make the router run out of providers (which throws —
 * see `createRouter`) but can never make it send a request somewhere it would
 * not otherwise have sent one.
 */
export interface RouteRequirements {
  /** Require `capabilities().streaming === true`. */
  readonly streaming?: boolean;
  /** Require `capabilities().structuredOutput === true`. */
  readonly structuredOutput?: boolean;
  /** Require `capabilities().tools === true`. */
  readonly tools?: boolean;
  /** Require `capabilities().tokenCounting` to be one of these. */
  readonly tokenCounting?: readonly TokenCounting[];
  /**
   * Require this BCP-47 tag to appear in `capabilities().locales`.
   *
   * Matched on the language subtag (`'nl-BE'` is satisfied by `'nl'`), and
   * `UNKNOWN` locales never fail the check — DECISIONS.md D7: most cloud
   * endpoints cannot enumerate what they speak, and refusing them all for not
   * answering a question they cannot answer is worse than trying.
   */
  readonly locale?: string;
  /** Require a *known* `contextWindow` of at least this many tokens. `UNKNOWN` fails this one. */
  readonly minContextWindow?: number;
  /**
   * Skip providers whose known context window cannot hold this request.
   * Defaults to `true`; an `UNKNOWN` window never fails it.
   */
  readonly fitsContextWindow?: boolean;
  /**
   * Skip providers that report `available: false`. Defaults to `true`.
   *
   * Turning it off is meaningful, not perverse: DECISIONS.md D9 records
   * availability being wrong in the *optimistic* direction, and an app that has
   * seen it wrong in the pessimistic direction can force the attempt and let
   * the `unavailable` fallback trigger sort it out.
   */
  readonly available?: boolean;
}

/** The per-tag half of {@link RoutePolicyRules}. Same fields, minus recursion. */
export interface RouteTagRule {
  /** Provider `id` to try first for this tag. */
  readonly preferred?: string;
  /** Constraints for this tag, shallow-merged over the base `require`. */
  readonly require?: RouteRequirements;
  /** Extra predicate for this tag. Runs *in addition to* the base `where`, not instead of it. */
  readonly where?: RoutePredicate;
}

/**
 * Declarative policy.
 *
 * ```ts
 * policy: {
 *   preferred: 'apple',
 *   require: { fitsContextWindow: true },
 *   tags: {
 *     reasoning: { preferred: 'openai' },
 *     translate: { require: { locale: 'nl' } },
 *   },
 *   where: (candidate) => candidate.id !== 'openai' || navigator.onLine,
 * }
 * ```
 */
export interface RoutePolicyRules {
  /**
   * Provider `id` to try first when it is eligible. Falls back to configured
   * order when it is not — a preference, not a requirement (use `require` for
   * requirements).
   */
  readonly preferred?: string;
  /** Constraints every candidate must satisfy. */
  readonly require?: RouteRequirements;
  /**
   * Per-task-tag overrides, keyed by `GenerateRequest.taskTag`. A tag with no
   * entry here routes exactly like an untagged request.
   */
  readonly tags?: Readonly<Record<string, RouteTagRule>>;
  /** Arbitrary extra constraint. */
  readonly where?: RoutePredicate;
  /** Escape hatch. See {@link RoutePolicyFunction}. */
  readonly select?: RoutePolicyFunction;
}

/**
 * A policy is either the declarative object or, as shorthand for
 * `{ select: fn }`, the function alone.
 */
export type RoutePolicy = RoutePolicyRules | RoutePolicyFunction;

/** Why the router chose the provider it started with. */
export type RouteReason =
  /** First eligible provider in configured order. */
  | 'order'
  /** `policy.preferred` named it and it was eligible. */
  | 'preferred'
  /** A `policy.tags[tag].preferred` rule named it. */
  | 'tag'
  /** `policy.select` returned it. */
  | 'policy'
  /** An earlier provider failed and this one picked the request up. */
  | 'fallback'
  /** Nobody answered: every provider was skipped or failed. */
  | 'exhausted';

/** One candidate's eligibility verdict. */
export interface RouteEligibility {
  readonly candidate: RouteCandidate;
  readonly skip?: RouteSkipReason;
}

/** The outcome of applying a policy: who to try first, in what order, and why. */
export interface RoutePlan {
  /** Every provider, in the order the router will consider it (ineligible ones included). */
  readonly order: readonly RouteEligibility[];
  /** `id` of the provider to try first, or `undefined` when none is eligible. */
  readonly firstChoice?: string;
  /** Why {@link firstChoice} was chosen. */
  readonly reason: RouteReason;
}

function normalizePolicy(policy: RoutePolicy | undefined): RoutePolicyRules {
  if (policy === undefined) return {};
  return typeof policy === 'function' ? { select: policy } : policy;
}

function localeMatches(supported: readonly string[], wanted: string): boolean {
  const wantedLanguage = wanted.toLowerCase().split('-')[0];
  return supported.some((tag) => {
    const lower = tag.toLowerCase();
    return lower === wanted.toLowerCase() || lower.split('-')[0] === wantedLanguage;
  });
}

/**
 * Apply the requirements to one candidate.
 *
 * Order matters only for the reported skip reason: availability first (the
 * most actionable), then the window (the most common), then capabilities.
 */
function checkRequirements(
  candidate: RouteCandidate,
  require: RouteRequirements
): RouteSkipReason | undefined {
  if (require.available !== false && !candidate.availability.available) return 'unavailable';

  if (require.fitsContextWindow !== false && candidate.fitsContextWindow === false) {
    return 'contextWindow';
  }
  if (require.minContextWindow !== undefined) {
    const window = candidate.capabilities.contextWindow;
    if (isUnknown(window) || window < require.minContextWindow) return 'contextWindow';
  }

  if (require.streaming === true && !candidate.capabilities.streaming) return 'capability';
  if (require.structuredOutput === true && !candidate.capabilities.structuredOutput) {
    return 'capability';
  }
  if (require.tools === true && !candidate.capabilities.tools) return 'capability';
  if (
    require.tokenCounting !== undefined &&
    !require.tokenCounting.includes(candidate.capabilities.tokenCounting)
  ) {
    return 'capability';
  }

  if (require.locale !== undefined) {
    const { locales } = candidate.capabilities;
    if (!isUnknown(locales) && !localeMatches(locales, require.locale)) return 'locale';
  }

  return undefined;
}

/**
 * Turn a policy plus a set of introspected candidates into a plan.
 *
 * Pure and synchronous: every fact it needs was gathered before it was called,
 * which is what makes routing decisions reproducible in a test from a plain
 * object literal.
 */
export function planRoute(policy: RoutePolicy | undefined, context: RoutePolicyContext): RoutePlan {
  const rules = normalizePolicy(policy);
  const tagRule = context.taskTag !== undefined ? rules.tags?.[context.taskTag] : undefined;

  // Shallow merge, so a tag rule can tighten one constraint without restating
  // the rest. A tag that wants to *drop* a base constraint sets it explicitly.
  const require: RouteRequirements = { ...rules.require, ...tagRule?.require };

  const order: RouteEligibility[] = context.candidates.map((candidate) => {
    const skip = checkRequirements(candidate, require);
    if (skip !== undefined) return { candidate, skip };
    if (rules.where !== undefined && !rules.where(candidate, context)) {
      return { candidate, skip: 'policy' };
    }
    if (tagRule?.where !== undefined && !tagRule.where(candidate, context)) {
      return { candidate, skip: 'policy' };
    }
    return { candidate };
  });

  const eligible = order.filter((entry) => entry.skip === undefined);
  const byId = (id: string): RouteEligibility | undefined =>
    order.find((entry) => entry.candidate.id === id);

  let chosen: RouteEligibility | undefined;
  let reason: RouteReason = 'order';

  const selected = rules.select?.(context);
  if (selected !== undefined) {
    // An explicit choice outranks the declarative filters (see
    // RoutePolicyFunction), so this looks in `order`, not in `eligible`.
    const entry = byId(selected);
    if (entry !== undefined) {
      chosen = entry;
      reason = 'policy';
    }
  }

  if (chosen === undefined && tagRule?.preferred !== undefined) {
    const entry = eligible.find((candidate) => candidate.candidate.id === tagRule.preferred);
    if (entry !== undefined) {
      chosen = entry;
      reason = 'tag';
    }
  }

  if (chosen === undefined && rules.preferred !== undefined) {
    const entry = eligible.find((candidate) => candidate.candidate.id === rules.preferred);
    if (entry !== undefined) {
      chosen = entry;
      reason = 'preferred';
    }
  }

  if (chosen === undefined) {
    chosen = eligible[0];
    reason = chosen === undefined ? 'exhausted' : 'order';
  }

  const chosenId = chosen?.candidate.id;
  const walk =
    chosen === undefined
      ? order
      : [chosen, ...order.filter((entry) => entry.candidate.id !== chosenId)];

  return {
    order: walk,
    ...(chosenId !== undefined ? { firstChoice: chosenId } : {}),
    reason,
  };
}
