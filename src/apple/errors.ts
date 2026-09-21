/**
 * Native error payload -> `LLMError`.
 *
 * The heavy lifting happened in Swift (`ios/Core/ErrorMapping.swift`), which
 * knows the framework's error types; this file only rebuilds the typed
 * `LLMErrorDetails` union from the flat wire payload and attaches the
 * diagnostics. Keeping the two halves separate means adding a native error
 * case touches one Swift file, and adding a taxonomy code touches one
 * TypeScript file.
 */

import { LLMError, type LLMErrorDetails, type UnavailableReason } from '../core';
import type { NativeErrorPayload } from './native/types';

const UNAVAILABLE_REASONS: readonly UnavailableReason[] = [
  'deviceNotEligible',
  'notEnabled',
  'modelNotReady',
  'unsupportedPlatform',
];

/**
 * Validate a reason string coming across the bridge.
 *
 * An unrecognised reason becomes `modelNotReady`: of the codes we have, it is
 * the only recoverable one, so a caller re-checks later instead of writing
 * the device off permanently on the strength of a string it did not
 * understand.
 */
export function toUnavailableReason(value: string | undefined): UnavailableReason {
  return UNAVAILABLE_REASONS.includes(value as UnavailableReason)
    ? (value as UnavailableReason)
    : 'modelNotReady';
}

/**
 * The `cause` attached to every bridged error: the native diagnostics, kept
 * verbatim so a failure stays reportable (DECISIONS.md D9 — we have seen
 * `com.apple.SensitiveContentAnalysisML error 15` arrive with no typed case
 * at all, and without domain/code there is nothing to file a radar about).
 *
 * Deliberately not an `Error`: it is data, and making it an `Error` would
 * invite it being thrown somewhere as if it were already classified.
 */
export interface NativeErrorCause {
  readonly nativeCode: string;
  readonly nativeMessage: string;
  readonly nativeDomain?: string;
  readonly nativeErrorCode?: number;
  readonly nativeDetail?: string;
}

function buildCause(payload: NativeErrorPayload): NativeErrorCause {
  return {
    nativeCode: payload.code,
    nativeMessage: payload.message,
    ...(payload.nativeDomain !== undefined ? { nativeDomain: payload.nativeDomain } : {}),
    ...(payload.nativeCode !== undefined ? { nativeErrorCode: payload.nativeCode } : {}),
    ...(payload.nativeDetail !== undefined ? { nativeDetail: payload.nativeDetail } : {}),
  };
}

function buildDetails(payload: NativeErrorPayload): LLMErrorDetails {
  switch (payload.code) {
    case 'unavailable':
      return { code: 'unavailable', reason: toUnavailableReason(payload.reason) };
    case 'contextOverflow':
      return {
        code: 'contextOverflow',
        ...(typeof payload.contextSize === 'number' ? { contextSize: payload.contextSize } : {}),
        ...(typeof payload.tokenCount === 'number' ? { tokenCount: payload.tokenCount } : {}),
      };
    case 'guardrail':
      return { code: 'guardrail' };
    case 'unsupportedLocale':
      return {
        code: 'unsupportedLocale',
        ...(payload.locale !== undefined ? { locale: payload.locale } : {}),
      };
    case 'rateLimited':
      return {
        code: 'rateLimited',
        ...(typeof payload.resetDate === 'number'
          ? { resetDate: new Date(payload.resetDate) }
          : {}),
      };
    case 'cancelled':
      return { code: 'cancelled' };
    case 'network':
      return { code: 'network' };
    case 'invalidRequest':
      return { code: 'invalidRequest' };
    case 'unknown':
      return {
        code: 'unknown',
        ...(typeof payload.transient === 'boolean' ? { transient: payload.transient } : {}),
      };
    default:
      // A code this version of the JavaScript does not know — a native module
      // newer than the JS half, which npm makes entirely possible. Transient
      // is left unset: we genuinely do not know, and `undefined` says so
      // (see `UnknownErrorDetails.transient`).
      return { code: 'unknown' };
  }
}

/** Rebuild a typed `LLMError` from what the Swift side sent. */
export function toLLMErrorFromNative(payload: NativeErrorPayload, providerId: string): LLMError {
  return new LLMError(buildDetails(payload), {
    message: payload.message,
    providerId,
    cause: buildCause(payload),
  });
}
