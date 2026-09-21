//
//  ErrorMapping.swift
//  OnDeviceLlm
//
//  One place where every way FoundationModels can fail becomes one of
//  `src/core`'s `LLMErrorCode`s. The router branches on those codes, so an
//  unmapped throw is not a cosmetic problem: it is a request that cannot be
//  retried, failed over, or reported.
//
//  Platform floor is iOS 27 / macOS 27 (DECISIONS.md D4), so only the iOS 27
//  taxonomy is handled: `LanguageModelError` replaced iOS 26's
//  `LanguageModelSession.GenerationError` wholesale and there is no
//  dual-taxonomy path to write.
//

import Foundation
import FoundationModels

/// Map anything thrown by the framework onto a `BridgeErrorPayload`.
///
/// Mapping table (docs/research/sdk-surface.md §5):
///
/// | thrown | code | carried through |
/// |---|---|---|
/// | `BridgeError` (ours) | as constructed | — |
/// | `CancellationError` | `cancelled` | — |
/// | `LanguageModelError.contextSizeExceeded` | `contextOverflow` | `contextSize`, `tokenCount` |
/// | `LanguageModelError.guardrailViolation` | `guardrail` | — |
/// | `LanguageModelError.refusal` | `guardrail` | — |
/// | `LanguageModelError.unsupportedLanguageOrLocale` | `unsupportedLocale` | `locale` |
/// | `LanguageModelError.rateLimited` | `rateLimited` | `resetDate` |
/// | `LanguageModelError.timeout` | `unknown` (transient) | — |
/// | `LanguageModelError.unsupportedCapability` | `invalidRequest` | — |
/// | `LanguageModelError.unsupportedGenerationGuide` | `invalidRequest` | — |
/// | `LanguageModelError.unsupportedTranscriptContent` | `invalidRequest` | — |
/// | `LanguageModelSession.Error.concurrentRequests` | `invalidRequest` | — |
/// | `LanguageModelSession.Error.transcriptMutationWhileResponding` | `invalidRequest` | — |
/// | `SystemLanguageModel.Error.assetsUnavailable` | `unavailable` | `reason: modelNotReady` |
/// | anything else (`NSError`) | `unknown` (transient) | `nativeDomain`, `nativeCode` |
///
/// Two mappings deserve their reasons in writing:
///
/// - **`refusal` -> `guardrail`.** The framework distinguishes a guardrail
///   trip from a model refusal, and `LLMErrorCode` does not yet (a dedicated
///   `refusal` code is listed as a future addition in `src/core/errors.ts`, in
///   the same spirit as D15: add a code when something branches on it). Both
///   mean "the model declined", both default to *not* falling through to the
///   cloud, so collapsing them changes no behaviour today. `Refusal` also
///   carries an `explanation` that triggers a second generation — never
///   fetched here, because a failed request must not silently cost a round
///   trip.
/// - **`timeout` -> `unknown` with `transient: true`.** `unknown` is the
///   taxonomy's transient lane (D9) and `transient` is exactly the hint the
///   Phase 4 router needs. A `timeout` code would say more, but nothing
///   consumes it yet.
func mapNativeError(_ error: Error) -> BridgeErrorPayload {
  if let bridge = error as? BridgeError {
    return bridge.payload
  }
  if error is CancellationError {
    return BridgeErrorPayload(code: "cancelled", message: "The request was cancelled")
  }

  if let toolError = error as? LanguageModelSession.ToolCallError {
    // Unwrap: the interesting error is the one our `BridgedTool.call` threw —
    // a handler failure, a timeout, or a cancellation, each already carrying
    // its taxonomy code (ios/Core/ToolBridge.swift). Mapping the wrapper
    // instead would flatten all three into one untyped `unknown`.
    var payload = mapNativeError(toolError.underlyingError)
    payload.message = "Tool \"\(toolError.tool.name)\" failed: \(payload.message)"
    return payload
  }

  if let parsingError = error as? GeneratedContent.ParsingError {
    // The model produced output that does not parse against the schema. The
    // raw text is the only evidence of what went wrong, and it is the first
    // thing anybody debugging a schema asks for — so it travels with the error
    // (docs/plan.md §4) rather than being swallowed. Transient: the next
    // sampling of the same prompt may well parse.
    var payload = BridgeErrorPayload(
      code: "unknown",
      message: "The model's structured output could not be parsed against the schema")
    payload.transient = true
    payload.rawContent = parsingError.rawContent
    payload.nativeDomain = "FoundationModels.GeneratedContent.ParsingError"
    payload.nativeDetail = parsingError.debugDescription
    return payload
  }

  if let modelError = error as? LanguageModelError {
    return map(modelError)
  }
  if let sessionError = error as? LanguageModelSession.Error {
    return map(sessionError)
  }
  if let assetError = error as? SystemLanguageModel.Error {
    return map(assetError)
  }

  return mapUntyped(error)
}

// MARK: - Typed cases

private func map(_ error: LanguageModelError) -> BridgeErrorPayload {
  switch error {
  case let .contextSizeExceeded(detail):
    var payload = BridgeErrorPayload(
      code: "contextOverflow",
      message: "The request exceeds the model's context window")
    // Both numbers, measured by the framework — the Phase 2 context manager
    // uses them to correct its estimator (D10/D11).
    payload.contextSize = detail.contextSize
    payload.tokenCount = detail.tokenCount
    payload.nativeDetail = detail.debugDescription
    return payload

  case let .rateLimited(detail):
    var payload = BridgeErrorPayload(code: "rateLimited", message: "Rate limited by the system")
    if let resetDate = detail.resetDate {
      payload.resetDate = resetDate.timeIntervalSince1970 * 1000
    }
    payload.nativeDetail = detail.debugDescription
    return payload

  case let .guardrailViolation(detail):
    var payload = BridgeErrorPayload(
      code: "guardrail", message: "Blocked by a safety guardrail")
    payload.nativeDetail = detail.debugDescription
    return payload

  case let .refusal(detail):
    // See the doc comment: a dedicated `refusal` code is deferred.
    var payload = BridgeErrorPayload(code: "guardrail", message: "The model refused the request")
    payload.nativeDetail = detail.debugDescription
    return payload

  case let .unsupportedLanguageOrLocale(detail):
    var payload = BridgeErrorPayload(
      code: "unsupportedLocale",
      message: "The model does not support this language or locale")
    payload.locale = detail.languageCode.identifier
    payload.nativeDetail = detail.debugDescription
    return payload

  case let .unsupportedCapability(detail):
    var payload = BridgeErrorPayload(
      code: "invalidRequest",
      message: "The model does not support a capability this request needs")
    payload.nativeDetail = detail.debugDescription
    return payload

  case let .unsupportedGenerationGuide(detail):
    var payload = BridgeErrorPayload(
      code: "invalidRequest",
      message: "The model does not support a constraint in the supplied schema")
    payload.nativeDetail = detail.debugDescription
    return payload

  case let .unsupportedTranscriptContent(detail):
    var payload = BridgeErrorPayload(
      code: "invalidRequest",
      message: "The conversation contains content the model cannot accept")
    payload.nativeDetail = detail.debugDescription
    return payload

  case let .timeout(detail):
    var payload = BridgeErrorPayload(code: "unknown", message: "The model timed out")
    payload.transient = true
    payload.nativeDetail = detail.debugDescription
    return payload

  @unknown default:
    // `LanguageModelError` is not frozen; a case added by a future OS must
    // land in the transient lane rather than crash the request path.
    var payload = BridgeErrorPayload(
      code: "unknown", message: "The model failed for an unrecognised reason")
    payload.transient = true
    payload.nativeDetail = String(describing: error)
    return payload
  }
}

private func map(_ error: LanguageModelSession.Error) -> BridgeErrorPayload {
  switch error {
  case .concurrentRequests:
    // Unreachable under session-per-request (docs/plan.md §2): each request
    // builds its own session, so there is never a second caller. Mapped
    // anyway, as `invalidRequest` — it is a caller-shape problem that will
    // repeat unchanged, so it must never be retried or failed over.
    return BridgeErrorPayload(
      code: "invalidRequest",
      message: "The session is already responding to another request")
  case .transcriptMutationWhileResponding:
    return BridgeErrorPayload(
      code: "invalidRequest",
      message: "The transcript was modified while the session was responding")
  @unknown default:
    var payload = BridgeErrorPayload(
      code: "unknown", message: "The session failed for an unrecognised reason")
    payload.transient = true
    payload.nativeDetail = String(describing: error)
    return payload
  }
}

private func map(_ error: SystemLanguageModel.Error) -> BridgeErrorPayload {
  switch error {
  case let .assetsUnavailable(detail):
    // `availability` reporting `.available` is not a promise that the assets
    // are actually usable (D9). `modelNotReady` is the reason a caller can act
    // on: it may resolve on its own once a download or activation completes.
    var payload = BridgeErrorPayload(
      code: "unavailable", message: "The model's assets are unavailable")
    payload.reason = "modelNotReady"
    payload.nativeDetail = detail.debugDescription
    return payload
  @unknown default:
    var payload = BridgeErrorPayload(
      code: "unknown", message: "The system model failed for an unrecognised reason")
    payload.transient = true
    payload.nativeDetail = String(describing: error)
    return payload
  }
}

// MARK: - Untyped NSError fallback (DECISIONS.md D9)

/// Not every failure surfaces as a typed enum. Observed live on a development
/// Mac while `availability == .available`: `com.apple.SensitiveContentAnalysisML
/// error 15` from `respond`, and `ModelManagerError 1013` from token counting
/// (docs/research/sdk-surface.md §12). Those arrive here as plain `NSError`s.
///
/// They map to `unknown` with `transient: true` — a system-level hiccup that a
/// retry or a failover may well survive — and the domain and code are attached
/// so the failure is reportable rather than an opaque "unknown".
private func mapUntyped(_ error: Error) -> BridgeErrorPayload {
  let nsError = error as NSError
  var payload = BridgeErrorPayload(
    code: "unknown",
    message: nsError.localizedDescription.isEmpty
      ? "The model failed for an unknown reason" : nsError.localizedDescription)
  payload.transient = true
  payload.nativeDomain = nsError.domain
  payload.nativeCode = nsError.code

  // Nested errors carry the real cause: the observed failures wrap a
  // `ModelManagerError` under `NSMultipleUnderlyingErrorsKey`.
  var details: [String] = []
  if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? Error {
    details.append(String(describing: underlying))
  }
  if let multiple = nsError.userInfo[NSMultipleUnderlyingErrorsKey] as? [Error] {
    details.append(contentsOf: multiple.map { String(describing: $0) })
  }
  if details.isEmpty {
    details.append(String(describing: error))
  }
  payload.nativeDetail = details.joined(separator: " | ")
  return payload
}
