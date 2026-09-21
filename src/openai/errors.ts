/**
 * HTTP and API error mapping onto `core`'s error taxonomy.
 *
 * Both failure shapes a Chat Completions-compatible endpoint can hand us —
 * a non-2xx HTTP response, and an in-band `event: error` frame on an
 * otherwise-200 SSE stream (observed live against `fm serve`,
 * DECISIONS.md D8) — funnel through {@link buildApiError} so the mapping
 * table lives in exactly one place.
 */

import { LLMError, type LLMErrorOptions } from '../core';

/** The (loosely-specified, widely-copied) OpenAI error envelope shape. */
export interface ApiErrorPayload {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: string | number | null;
  };
}

/**
 * Matches server error messages describing a too-long request. Checked
 * before the generic 400/422 mapping so an over-length prompt becomes
 * `contextOverflow` (recoverable by trimming) rather than `invalidRequest`
 * (never retried, per the taxonomy's own contract in `core/errors.ts`).
 */
const CONTEXT_LENGTH_PATTERN = /context.length|maximum context|too many tokens/i;

/**
 * Resolve an HTTP `Retry-After` header to an absolute time.
 *
 * The header is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3);
 * both forms are in use in the wild, so both are tried.
 */
export function parseRetryAfter(value: string | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? undefined : asDate;
}

/** Best-effort extraction of a human-readable message from a JSON or plain-text error body. */
export function extractErrorMessage(rawBody: string): string | undefined {
  const trimmed = rawBody.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = JSON.parse(trimmed) as ApiErrorPayload;
    return parsed.error?.message ?? trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Map one API failure onto an `LLMError`.
 *
 * `status` is `undefined` for an SSE `event: error` frame, which carries no
 * HTTP status of its own — those map through the status-less branches only
 * (context-length detection, then a `network` fallback, since something
 * clearly went wrong mid-stream and retrying the connection is the
 * reasonable default).
 *
 * Never includes prompt or response content: `message` here is the
 * server's own diagnostic text about the *request shape* (token limits,
 * auth, rate limits), never an echo of the conversation.
 */
export function buildApiError(params: {
  readonly status?: number;
  readonly message?: string;
  readonly retryAfter?: string | null;
  readonly providerId: string;
  readonly cause?: unknown;
}): LLMError {
  const { status, message, retryAfter, providerId, cause } = params;
  const options: LLMErrorOptions = {
    providerId,
    cause,
    ...(message !== undefined ? { message } : {}),
  };
  const isContextOverflow = message !== undefined && CONTEXT_LENGTH_PATTERN.test(message);

  if (status === 429) {
    return new LLMError({ code: 'rateLimited', resetDate: parseRetryAfter(retryAfter) }, options);
  }
  if (status === 400 || status === 422) {
    return isContextOverflow
      ? new LLMError({ code: 'contextOverflow' }, options)
      : new LLMError({ code: 'invalidRequest' }, options);
  }
  if (status === 401 || status === 403) {
    // Auth misconfiguration is a caller mistake (bad/missing `apiKey`), not
    // a transient condition, so it maps to `invalidRequest` rather than
    // `network` even though it arrives as an HTTP error.
    return new LLMError({ code: 'invalidRequest' }, options);
  }
  if (status !== undefined && status >= 500) {
    return new LLMError({ code: 'network', status }, options);
  }
  if (isContextOverflow) {
    return new LLMError({ code: 'contextOverflow' }, options);
  }
  // Any other status (or none, for an SSE error frame) — transport-shaped
  // failure with no more specific home in the taxonomy.
  return new LLMError({ code: 'network', ...(status !== undefined ? { status } : {}) }, options);
}
