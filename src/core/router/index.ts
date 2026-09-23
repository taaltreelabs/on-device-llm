/**
 * The router (docs/plan.md §5 Phase 4).
 *
 * `createRouter({ providers })` returns an `LLMProvider` that tries providers
 * in order, falls back on the failures you say are worth falling back on, and
 * reports what it did through `onRoute` without ever handling prompt or
 * response content.
 *
 * Start with {@link createRouter}. Read `fallback.ts` before changing the
 * default trigger set and `policy.ts` before adding a routing rule.
 */

export { DEFAULT_FALLBACK_TRIGGERS, type FallbackTriggers } from './fallback';
export { DEFAULT_ROUTE_CACHE_TTL_MS } from './introspect';
export {
  type RouteCandidate,
  type RouteEligibility,
  type RoutePlan,
  type RoutePolicy,
  type RoutePolicyContext,
  type RoutePolicyFunction,
  type RoutePolicyRules,
  type RoutePredicate,
  type RouteReason,
  type RouteRequirements,
  type RouteSkipReason,
  type RouteTagRule,
  type RouteTokenSource,
} from './policy';
export {
  createRouter,
  type OnRoute,
  type RouteAttempt,
  type RouteOutcome,
  type RouteReport,
  type RouterConfig,
} from './router';
