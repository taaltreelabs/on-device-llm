/**
 * Which failures are worth trying somewhere else.
 *
 * The taxonomy (`errors.ts`) exists so exactly this decision can be made on a
 * code rather than on a string match, and the defaults below are the plan's
 * (docs/plan.md §4/§5) plus two calls this package had to make itself
 * (DECISIONS.md D30).
 */

import { isLLMError, type LLMError } from '../errors';

/**
 * Per-code fallback switches.
 *
 * Note what is **absent**: `cancelled` and `invalidRequest` are not fields.
 * The plan says "never retry" on those, and a boolean nobody may set to `true`
 * is a boolean that will eventually be set to `true` by accident — so the
 * prohibition is expressed in the type, where `{ fallback: { cancelled: true } }`
 * does not compile. `cancelled` means the caller asked to stop, and continuing
 * to spend money and battery on a second provider is the one thing they
 * definitely did not want; `invalidRequest` means the request is wrong and
 * will be just as wrong at the next provider (DECISIONS.md D6: an unsupported
 * schema construct, a conversation that does not end with a user message).
 */
export interface FallbackTriggers {
  /** The provider reports it cannot serve requests at all. Default `true`. */
  readonly unavailable?: boolean;
  /**
   * The request did not fit the context window. Default `true` — this is the
   * canonical reason to move a long conversation from a 4K on-device window to
   * a cloud model (docs/plan.md §4), and DECISIONS.md D15 makes the context
   * manager's own overflow arrive by the same route.
   */
  readonly contextOverflow?: boolean;
  /** Transport failure. Default `true`: always transient, and the on-device provider does not need the network. */
  readonly network?: boolean;
  /**
   * Too many requests. Default `true`.
   *
   * Failing over is not the same as retrying: `resetDate` may be minutes away,
   * the limit belongs to *that* provider, and a second provider is precisely
   * the thing that makes the limit survivable. Same-provider retry stays an
   * app concern (see `createRouter`).
   */
  readonly rateLimited?: boolean;
  /**
   * A safety guardrail blocked it. Default **`false`** (docs/plan.md §4).
   *
   * Off because a guardrail is a decision, not a malfunction: routing around
   * it sends content one model refused to another, usually off-device, which
   * is a policy choice an app must make deliberately rather than inherit.
   */
  readonly guardrail?: boolean;
  /**
   * The model does not support the request's language. Default `true`.
   *
   * This is a capability gap, not a failure: Apple enumerates 24 locales
   * (DECISIONS.md D7) and a cloud model usually handles the rest, so falling
   * back is the behaviour a Polish-speaking user wants and the alternative is
   * an error for something another configured provider can do. It is
   * switchable because it does mean the prompt leaves the device.
   */
  readonly unsupportedLocale?: boolean;
  /**
   * `unknown` carrying `details.transient === true`. Default `true`.
   *
   * DECISIONS.md D9's lane: availability said yes and the native layer then
   * threw `ModelManagerError 1013` / `SensitiveContentAnalysisML error 15`.
   * The provider is telling us "this may work elsewhere or later", and that is
   * exactly the signal a router exists to act on (D25 sets it for a tool-call
   * timeout too).
   */
  readonly unknownTransient?: boolean;
  /**
   * `unknown` with `transient === false` or `transient` absent. Default
   * **`false`**.
   *
   * `false` is a provider saying "this will fail again" (D25: a tool handler
   * that threw — app code, deterministic). `undefined` is a provider that does
   * not know, and treating "don't know" as retryable makes every mystery
   * failure cost two generations and two bills. Opt in if your providers are
   * unrelated enough that the guess pays off.
   */
  readonly unknown?: boolean;
}

/** The defaults, exported so an app can see (and diff) what it is overriding. */
export const DEFAULT_FALLBACK_TRIGGERS: Required<FallbackTriggers> = {
  unavailable: true,
  contextOverflow: true,
  network: true,
  rateLimited: true,
  guardrail: false,
  unsupportedLocale: true,
  unknownTransient: true,
  unknown: false,
};

/**
 * Should this failure be handed to the next provider?
 *
 * `cancelled` and `invalidRequest` always answer `false`, and nothing in
 * `triggers` can change that.
 */
export function shouldFallBack(error: LLMError, triggers: Required<FallbackTriggers>): boolean {
  switch (error.code) {
    case 'cancelled':
    case 'invalidRequest':
      return false;
    case 'unavailable':
      return triggers.unavailable;
    case 'contextOverflow':
      return triggers.contextOverflow;
    case 'network':
      return triggers.network;
    case 'rateLimited':
      return triggers.rateLimited;
    case 'guardrail':
      return triggers.guardrail;
    case 'unsupportedLocale':
      return triggers.unsupportedLocale;
    case 'unknown':
      return isLLMError(error, 'unknown') && error.details.transient === true
        ? triggers.unknownTransient
        : triggers.unknown;
    default:
      // A code added to the taxonomy later (`timeout`, `refusal`, `parseError`
      // are the candidates errors.ts names) is not silently treated as
      // retryable: an unrecognised failure propagates until someone decides
      // what it means.
      return false;
  }
}

/** Fill in the defaults for the switches an app did not set. */
export function resolveTriggers(
  triggers: FallbackTriggers | undefined
): Required<FallbackTriggers> {
  return { ...DEFAULT_FALLBACK_TRIGGERS, ...triggers };
}
