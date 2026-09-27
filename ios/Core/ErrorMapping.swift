//
//  ErrorMapping.swift
//  OnDeviceLlm
//
//  One place where every way FoundationModels can fail becomes one of
//  `src/core`'s `LLMErrorCode`s. The router branches on those codes, so an
//  unmapped throw is not a cosmetic problem: it is a request that cannot be
//  retried, failed over, or reported.
//
//  Two taxonomies, because the platform floor is iOS 26.0 / macOS 26.0 — the
//  release that shipped FoundationModels (docs/research/ios26-compat.md; this
//  supersedes the iOS 27 floor of DECISIONS.md D4). iOS 27 replaced iOS 26's
//  `LanguageModelSession.GenerationError` wholesale with `LanguageModelError`,
//  `LanguageModelSession.Error`, `SystemLanguageModel.Error` and
//  `GeneratedContent.ParsingError` (docs/research/sdk-surface.md §5), and all
//  four of those are `@available(iOS 27.0, macOS 27.0, *)`. So the mapper is
//  dual-path: the iOS 27 types under `#available`, then the deprecated iOS 26
//  enum, then the untyped `NSError` fallback. Both typed paths land on the
//  same bridge codes, so TypeScript never learns which OS threw.
//

import Foundation
import FoundationModels

/// Map anything thrown by the framework onto a `BridgeErrorPayload`.
///
/// Mapping table (docs/research/sdk-surface.md §5). The iOS 27 rows are tried
/// only under `#available(iOS 27.0, macOS 27.0, *)`; the iOS 26 rows after
/// them, on every OS (the comment in the body says why).
///
/// | thrown | code | carried through |
/// |---|---|---|
/// | `BridgeError` (ours) | as constructed | — |
/// | `CancellationError` | `cancelled` | — |
/// | `LanguageModelSession.ToolCallError` (26+) | the wrapped error's | message prefixed with the tool |
/// | **iOS 27 taxonomy** | | |
/// | `GeneratedContent.ParsingError` | `unknown` (transient) | `rawContent` |
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
/// | **iOS 26 taxonomy** (`LanguageModelSession.GenerationError`, deprecated in 27) | | |
/// | `.exceededContextWindowSize` | `contextOverflow` | — (no `contextSize`/`tokenCount`: the 26 payload has neither) |
/// | `.assetsUnavailable` | `unavailable` | `reason: modelNotReady` |
/// | `.guardrailViolation` | `guardrail` | — |
/// | `.refusal` | `guardrail` | — |
/// | `.unsupportedGuide` | `invalidRequest` | — |
/// | `.unsupportedLanguageOrLocale` | `unsupportedLocale` | — (the 26 payload does not name the locale) |
/// | `.decodingFailure` | `unknown` (transient) | — (no `rawContent`: the 26 payload has none) |
/// | `.rateLimited` | `rateLimited` | — (no `resetDate`) |
/// | `.concurrentRequests` | `invalidRequest` | — |
/// | **either** | | |
/// | anything else (`NSError`) | `unknown` (transient) | `nativeDomain`, `nativeCode` |
///
/// Every iOS 26 row carries `GenerationError.Context.debugDescription` as
/// `nativeDetail` — on iOS 26 it is the only diagnostic the framework gives.
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
@available(iOS 26.0, macOS 26.0, *)
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

  if #available(iOS 27.0, macOS 27.0, *) {
    if let payload = mapModernError(error) {
      return payload
    }
  }

  // Tried on iOS 27 too, not only in an `else`: the deprecated enum still
  // exists there, and if any code path of the framework still throws it, a
  // typed mapping beats the untyped fallback. On iOS 26 it is the only typed
  // taxonomy there is.
  let legacyMapper: any GenerationErrorMapping = LegacyGenerationErrorMapper()
  if let payload = legacyMapper.map(error) {
    return payload
  }

  return mapUntyped(error)
}

// MARK: - iOS 27 taxonomy

/// The four iOS 27 error types, or `nil` when `error` is none of them.
@available(iOS 27.0, macOS 27.0, *)
private func mapModernError(_ error: Error) -> BridgeErrorPayload? {
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
  return nil
}

@available(iOS 27.0, macOS 27.0, *)
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

@available(iOS 27.0, macOS 27.0, *)
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

@available(iOS 27.0, macOS 27.0, *)
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

// MARK: - iOS 26 taxonomy (deprecated in 27)

/// The non-deprecated face of the iOS 26 mapper.
///
/// `LanguageModelSession.GenerationError` and every one of its cases are
/// `deprecated: 27.0`. Naming them is unavoidable — this is the only typed
/// error iOS 26 throws — but a build with a 27.0 deployment target (a consumer
/// app whose Podfile raises every pod's target, say) would otherwise emit nine
/// deprecation warnings from this file, and a warning nobody can act on
/// teaches people to ignore the ones they can. So the silencing is local and
/// deliberate rather than a repo-wide flag:
///
/// 1. `LegacyGenerationErrorMapper.map` is itself `deprecated: 27.0`, which
///    makes the references *inside* it legal without a diagnostic (a
///    deprecated context may use deprecated API).
/// 2. It is called through this protocol requirement, which is not
///    deprecated, so the call site in `mapNativeError` is silent too.
///
/// Verified with `swiftc -typecheck` at both a 26.0 and a 27.0 target: zero
/// warnings either way. Calling the static method directly instead brings one
/// warning back at 27.0.
private protocol GenerationErrorMapping {
  func map(_ error: Error) -> BridgeErrorPayload?
}

@available(iOS 26.0, macOS 26.0, *)
private struct LegacyGenerationErrorMapper: GenerationErrorMapping {
  /// `LanguageModelSession.GenerationError` -> payload, or `nil` when `error`
  /// is not one. Mapped to the same codes as the iOS 27 rows it was replaced
  /// by (sdk-surface.md §5's replacement column), minus the fields the iOS 26
  /// payload never had: a bare `Context` with a `debugDescription` is all any
  /// case carries.
  @available(iOS, deprecated: 27.0, message: "Maps the iOS 26 taxonomy; see GenerationErrorMapping")
  @available(macOS, deprecated: 27.0, message: "Maps the iOS 26 taxonomy; see GenerationErrorMapping")
  func map(_ error: Error) -> BridgeErrorPayload? {
    guard let generationError = error as? LanguageModelSession.GenerationError else {
      return nil
    }
    var payload: BridgeErrorPayload
    let context: LanguageModelSession.GenerationError.Context

    switch generationError {
    case let .exceededContextWindowSize(detail):
      // No `contextSize`/`tokenCount`: iOS 26 does not say by how much. The
      // context manager then corrects nothing and keeps its estimate (D10/D11)
      // — worse than on 27, but not wrong.
      payload = BridgeErrorPayload(
        code: "contextOverflow",
        message: "The request exceeds the model's context window")
      context = detail

    case let .assetsUnavailable(detail):
      // Same reasoning as the iOS 27 `SystemLanguageModel.Error` row (D9).
      payload = BridgeErrorPayload(
        code: "unavailable", message: "The model's assets are unavailable")
      payload.reason = "modelNotReady"
      context = detail

    case let .guardrailViolation(detail):
      payload = BridgeErrorPayload(code: "guardrail", message: "Blocked by a safety guardrail")
      context = detail

    case let .refusal(_, detail):
      // As on 27: collapsed onto `guardrail`, and the `Refusal`'s
      // `explanation` (a second generation) is never fetched.
      payload = BridgeErrorPayload(code: "guardrail", message: "The model refused the request")
      context = detail

    case let .unsupportedGuide(detail):
      payload = BridgeErrorPayload(
        code: "invalidRequest",
        message: "The model does not support a constraint in the supplied schema")
      context = detail

    case let .unsupportedLanguageOrLocale(detail):
      // No `locale`: the 26 payload does not say which one. `LLMError`'s
      // `locale` detail is optional for exactly this kind of case.
      payload = BridgeErrorPayload(
        code: "unsupportedLocale",
        message: "The model does not support this language or locale")
      context = detail

    case let .decodingFailure(detail):
      // The iOS 26 ancestor of `GeneratedContent.ParsingError`, and mapped the
      // same way — `unknown`, transient — but without `rawContent`, which only
      // the 27 type carries.
      payload = BridgeErrorPayload(
        code: "unknown",
        message: "The model's structured output could not be parsed against the schema")
      payload.transient = true
      payload.nativeDomain = "FoundationModels.LanguageModelSession.GenerationError"
      context = detail

    case let .rateLimited(detail):
      // No `resetDate` on 26; the router falls back on its own backoff.
      payload = BridgeErrorPayload(code: "rateLimited", message: "Rate limited by the system")
      context = detail

    case let .concurrentRequests(detail):
      // Unreachable under session-per-request, as on 27; `invalidRequest` so
      // it is never retried.
      payload = BridgeErrorPayload(
        code: "invalidRequest",
        message: "The session is already responding to another request")
      context = detail

    @unknown default:
      var unknown = BridgeErrorPayload(
        code: "unknown", message: "The model failed for an unrecognised reason")
      unknown.transient = true
      unknown.nativeDetail = String(describing: generationError)
      return unknown
    }

    payload.nativeDetail = context.debugDescription
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
