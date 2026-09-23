/**
 * The error taxonomy.
 *
 * Every provider maps its failures onto this one set of codes, because the
 * Phase 4 router branches on them (docs/plan.md §2, "Normalized errors").
 * One class, not a class hierarchy: `catch (e) { if (isLLMError(e)) … }` is
 * the whole story, there is no `instanceof` ladder to get wrong, and adding
 * a code later is not a new exported class.
 *
 * Per-code payloads are modelled as a discriminated union (`details`) rather
 * than as optional fields flattened onto the class. The alternative —
 * `err.contextSize` present only sometimes — makes every payload access
 * `number | undefined` regardless of the code, which is exactly the
 * information the code discriminant already gave us. With the union,
 * `if (err.details.code === 'contextOverflow') err.details.tokenCount`
 * narrows properly; `err.code` stays available as a convenience for logging
 * and for `switch` statements that do not need the payload.
 */

import type { UnavailableReason } from './availability';

/**
 * Failure categories. Matches docs/plan.md §2 with one amendment from
 * DECISIONS.md D7: `unsupportedLocale` is a top-level code raised at
 * generation time, not an availability reason.
 *
 * Sizing note: codes worth adding once something consumes them are
 * `timeout`, `refusal` (Apple distinguishes it from `guardrail`), and
 * `parseError` (Apple's `GeneratedContent.ParsingError` carries the raw
 * malformed output) — see docs/research/sdk-surface.md §5. They are not here
 * yet because in Phase 1 nothing branches on them, and the honest mapping
 * for each today is `unknown`/`guardrail`/`invalidRequest`. Adding a code is
 * a semver-minor change for callers that use `switch` with a `default`,
 * which is the documented way to consume this union.
 */
export type LLMErrorCode =
  | 'unavailable'
  | 'contextOverflow'
  | 'guardrail'
  | 'unsupportedLocale'
  | 'rateLimited'
  | 'cancelled'
  | 'network'
  | 'invalidRequest'
  | 'unknown';

/** The provider cannot serve requests at all. Carries the same reason `availability()` would report. */
export interface UnavailableErrorDetails {
  readonly code: 'unavailable';
  /** Why the provider is unusable. */
  readonly reason: UnavailableReason;
}

/**
 * The request did not fit the context window.
 *
 * Both numbers are optional because only some providers report them — but
 * Apple's iOS 27 `LanguageModelError.ContextSizeExceeded` carries
 * `contextSize` *and* `tokenCount` (docs/research/sdk-surface.md §5), which
 * is exactly what the Phase 2 context manager needs to correct a bad
 * estimate: the true budget and the true overage, measured.
 */
export interface ContextOverflowErrorDetails {
  readonly code: 'contextOverflow';
  /** The provider's real total budget in tokens, when reported. */
  readonly contextSize?: number;
  /** How many tokens the request actually needed, when reported. */
  readonly tokenCount?: number;
}

/**
 * A safety guardrail blocked the request or response.
 *
 * Whether this falls through to a cloud provider is app policy, and the
 * Phase 4 default is **not** to fall through (docs/plan.md §4).
 */
export interface GuardrailErrorDetails {
  readonly code: 'guardrail';
}

/**
 * The model does not support the language of the request.
 *
 * DECISIONS.md D7: a generation-time failure (Apple's
 * `unsupportedLanguageOrLocale`), never an availability reason. Predictable
 * in advance from `capabilities().locales`.
 */
export interface UnsupportedLocaleErrorDetails {
  readonly code: 'unsupportedLocale';
  /** BCP-47 tag or bare language code the provider rejected, when reported. */
  readonly locale?: string;
}

/** Too many requests. */
export interface RateLimitedErrorDetails {
  readonly code: 'rateLimited';
  /**
   * When the caller may retry, when reported (Apple's `RateLimited.resetDate`,
   * or an HTTP `Retry-After` resolved to an absolute time).
   */
  readonly resetDate?: Date;
}

/**
 * An `AbortSignal` fired. Never a fallback trigger — the caller asked for
 * this. Providers must surface *every* abort path as this code, including
 * the `DOMException`/`AbortError` that `fetch` and `AbortSignal.throwIfAborted()`
 * raise; {@link toLLMError} does that conversion.
 */
export interface CancelledErrorDetails {
  readonly code: 'cancelled';
}

/** Transport failure talking to a remote provider. Always transient. */
export interface NetworkErrorDetails {
  readonly code: 'network';
  /** HTTP status, when the failure came back with one. */
  readonly status?: number;
}

/**
 * The request itself is wrong and will fail again unchanged — an
 * unsupported schema construct (DECISIONS.md D6), an unrecognised message
 * role, a sampling option the provider has no equivalent for. Never retried,
 * never failed over.
 */
export interface InvalidRequestErrorDetails {
  readonly code: 'invalidRequest';
}

/**
 * Unclassified failure. Always constructed with the original error as
 * `cause` (docs/plan.md §2: "always with the original error attached").
 *
 * This is the lane DECISIONS.md D9 requires: the native layer has been
 * observed throwing untyped `NSError`s (`ModelManagerError 1013`,
 * `SensitiveContentAnalysisML error 15`) while reporting itself available.
 * Those must not crash the request path and must not masquerade as a
 * permanent condition.
 */
export interface UnknownErrorDetails {
  readonly code: 'unknown';
  /**
   * Hint for the Phase 4 router: `true` means "retrying or failing over may
   * work" (a system-level hiccup), `false` means "this will fail again",
   * `undefined` means the provider genuinely does not know. Advisory only —
   * policy lives in the router, not here.
   */
  readonly transient?: boolean;
}

/** Union of every per-code payload. Discriminated on `code`. */
export type LLMErrorDetails =
  | UnavailableErrorDetails
  | ContextOverflowErrorDetails
  | GuardrailErrorDetails
  | UnsupportedLocaleErrorDetails
  | RateLimitedErrorDetails
  | CancelledErrorDetails
  | NetworkErrorDetails
  | InvalidRequestErrorDetails
  | UnknownErrorDetails;

/** The payload type belonging to one code. */
export type LLMErrorDetailsFor<TCode extends LLMErrorCode> = Extract<
  LLMErrorDetails,
  { code: TCode }
>;

/** Shorthand for an `LLMError` known to carry a particular code. */
export type LLMErrorOf<TCode extends LLMErrorCode> = LLMError<LLMErrorDetailsFor<TCode>>;

/** Non-payload construction options, shared by every code. */
export interface LLMErrorOptions {
  /** Overrides the generated default message. Must not contain prompt or response content. */
  readonly message?: string;
  /** `id` of the provider that failed, when known. */
  readonly providerId?: string;
  /** The underlying error, preserved verbatim. Required in spirit for `unknown`. */
  readonly cause?: unknown;
}

const DEFAULT_MESSAGES: { readonly [TCode in LLMErrorCode]: string } = {
  unavailable: 'The provider is unavailable',
  contextOverflow: 'The request exceeds the context window',
  guardrail: 'Blocked by a safety guardrail',
  unsupportedLocale: 'The model does not support this language or locale',
  rateLimited: 'Rate limited',
  cancelled: 'The request was cancelled',
  network: 'Network request failed',
  invalidRequest: 'Invalid request',
  unknown: 'The provider failed for an unknown reason',
};

/**
 * Brand property, so {@link isLLMError} keeps working when `instanceof`
 * cannot: two copies of this package in one dependency tree, an error
 * crossing a bundle boundary, or a consumer that down-levels classes.
 * Non-enumerable, so it never shows up in logs or JSON.
 */
const BRAND = '__taaltreeLLMError__';

function buildMessage(details: LLMErrorDetails, options: LLMErrorOptions): string {
  if (options.message !== undefined) return options.message;
  const base = DEFAULT_MESSAGES[details.code];
  if (details.code === 'unavailable') return `${base}: ${details.reason}`;
  if (details.code === 'contextOverflow' && details.tokenCount !== undefined) {
    const size = details.contextSize !== undefined ? ` of ${details.contextSize}` : '';
    return `${base} (${details.tokenCount} tokens${size})`;
  }
  return base;
}

/**
 * The single error type this package throws.
 *
 * ```ts
 * throw new LLMError(
 *   { code: 'contextOverflow', contextSize: 4096, tokenCount: 5200 },
 *   { providerId: 'apple', cause: nativeError }
 * );
 * ```
 *
 * @typeParam TDetails - inferred from the payload, so
 * `new LLMError({ code: 'cancelled' })` is an `LLMErrorOf<'cancelled'>` and
 * assignable wherever a plain `LLMError` is expected.
 */
export class LLMError<TDetails extends LLMErrorDetails = LLMErrorDetails> extends Error {
  /** Always `'LLMError'`, so stack traces and logs identify it correctly. */
  override readonly name = 'LLMError';

  /** The failure category. Convenience mirror of `details.code`. */
  readonly code: TDetails['code'];

  /** Code-specific payload. Narrow on `details.code` to read it. */
  readonly details: TDetails;

  /** `id` of the provider that failed, when known. */
  readonly providerId?: string;

  constructor(details: TDetails, options: LLMErrorOptions = {}) {
    super(
      buildMessage(details, options),
      options.cause !== undefined ? { cause: options.cause } : undefined
    );
    this.code = details.code;
    this.details = details;
    if (options.providerId !== undefined) {
      this.providerId = options.providerId;
    }
    // Belt and braces: some engines (older Hermes among them) ignore the
    // `Error` options bag, which would silently drop `cause` — the one thing
    // docs/plan.md §2 insists is never lost.
    if (options.cause !== undefined && this.cause === undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        writable: true,
        configurable: true,
      });
    }
    Object.defineProperty(this, BRAND, { value: true, enumerable: false });
  }
}

/**
 * Is this an `LLMError`? Optionally, is it one carrying a specific code?
 *
 * ```ts
 * if (isLLMError(err, 'contextOverflow')) {
 *   trim(err.details.tokenCount); // narrowed, no cast
 * }
 * ```
 */
export function isLLMError(value: unknown): value is LLMError;
export function isLLMError<TCode extends LLMErrorCode>(
  value: unknown,
  code: TCode
): value is LLMErrorOf<TCode>;
export function isLLMError(value: unknown, code?: LLMErrorCode): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { [BRAND]?: unknown; code?: unknown };
  const branded = value instanceof LLMError || candidate[BRAND] === true;
  if (!branded) return false;
  return code === undefined || candidate.code === code;
}

/**
 * Is this the abort rejection produced by a web-standard API?
 *
 * `fetch`, `AbortSignal.throwIfAborted()`, and Node's stream helpers all
 * reject with a `DOMException` (or plain `Error`) named `AbortError`; some
 * runtimes use `TimeoutError` for `AbortSignal.timeout`. Detection is by
 * `name`, because `DOMException` is not reliably a global everywhere this
 * package runs.
 */
export function isAbortError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const name = (value as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Normalize anything thrown into an `LLMError`, preserving the original as
 * `cause`.
 *
 * Every provider's `catch` should end here, so that (a) an abort is always
 * `cancelled` no matter which layer raised it, and (b) nothing unmapped ever
 * escapes as a bare `Error` — the router can only branch on codes.
 *
 * ```ts
 * try { … } catch (err) { throw toLLMError(err, { providerId: this.id }); }
 * ```
 *
 * @param options.transient - default for the `unknown` fallback's router
 * hint (DECISIONS.md D9). An already-classified `LLMError` passes through
 * untouched.
 */
export function toLLMError(
  value: unknown,
  options: { readonly providerId?: string; readonly transient?: boolean } = {}
): LLMError {
  if (isLLMError(value)) return value;
  if (isAbortError(value)) {
    return new LLMError({ code: 'cancelled' }, { providerId: options.providerId, cause: value });
  }
  const message = value instanceof Error ? value.message : undefined;
  return new LLMError(
    {
      code: 'unknown',
      ...(options.transient !== undefined ? { transient: options.transient } : {}),
    },
    { message, providerId: options.providerId, cause: value }
  );
}
