//
//  ModelInfo.swift
//  OnDeviceLlm
//
//  Availability, capabilities and locale support — Phase 3 step 1.
//
//  Platform floor iOS 26.0 / macOS 26.0 (docs/research/ios26-compat.md).
//  `availability`, `contextSize`, `supportedLanguages` and `supportsLocale`
//  are all 26.0 API; `variant` and `capabilities` are iOS 27 and are read
//  under `#available` with documented fallbacks.
//

import Foundation
import FoundationModels

@available(iOS 26.0, macOS 26.0, *)
enum ModelInfo {
  /// `SystemLanguageModel.Availability` -> `src/core`'s `Availability`.
  ///
  /// The framework has exactly three unavailable reasons and **none of them is
  /// locale-related** (DECISIONS.md D7). `unsupportedPlatform` is not this
  /// function's business: where there is no native module at all (Android,
  /// web) the TypeScript layer reports it, and on iOS older than 26 this type
  /// does not exist and `OnDeviceLlmModule`'s `#available` guard reports it
  /// instead. So this maps three cases and nothing else.
  static func availability(_ model: SystemLanguageModel = .default) -> [String: Any] {
    switch model.availability {
    case .available:
      return ["available": true]
    case let .unavailable(reason):
      switch reason {
      case .deviceNotEligible:
        return [
          "available": false, "reason": "deviceNotEligible",
          "detail": "This device cannot run Apple Intelligence.",
        ]
      case .appleIntelligenceNotEnabled:
        return [
          "available": false, "reason": "notEnabled",
          "detail": "Apple Intelligence is not enabled in Settings.",
        ]
      case .modelNotReady:
        return [
          "available": false, "reason": "modelNotReady",
          "detail": "The model is still downloading or otherwise not ready yet.",
        ]
      @unknown default:
        // `UnavailableReason` is not frozen. An unrecognised reason is
        // reported as `modelNotReady`: of the three codes we have it is the
        // only recoverable one, so a caller re-checks later instead of
        // permanently writing the device off.
        return [
          "available": false, "reason": "modelNotReady",
          "detail": "Unavailable for a reason this version does not recognise: \(reason).",
        ]
      }
    }
  }

  /// Capability discovery.
  ///
  /// - `contextWindow`: `SystemLanguageModel.contextSize`, which is a combined
  ///   input+output budget. Guarded at `<= 0` and reported as `0`, which the
  ///   TypeScript side turns into `UNKNOWN` via `normalizeContextWindow`
  ///   (D9/D11) — it really has been observed returning `0` on a machine whose
  ///   model assets were wedged, and an unknown window is a typed state, not a
  ///   number to guess. `contextSize` is `@backDeployed(before: 26.4)`
  ///   (sdk-surface.md §1, "Context size"): below 26.4 the back-deployed
  ///   thunk returns a literal `4096`, the documented iOS 26 window; from 26.4
  ///   the OS's own implementation answers. Either way it is reported as-is.
  /// - `locales`: `Locale.Language.minimalIdentifier` (`"nl"`, `"en-GB"`,
  ///   `"es-419"`), i.e. plain BCP-47 as a JS caller would write it. Note the
  ///   discrepancy with docs/research/sdk-surface.md §1, which lists the
  ///   *maximal* identifiers (`"nl-Latn-NL"`); both come from the same set,
  ///   the minimal form is what `Intl`/`navigator.language` produce, and exact
  ///   matching should go through `supportsLocale` anyway.
  /// - `modelLabel`: `variant.displayName` on iOS 27 — measured
  ///   `"AFM 3 Core Advanced"` on the development Mac, `"AFM 3 Core"` on the
  ///   machine used for the Phase 0 recon. It explains context-size and
  ///   quality differences between devices, so it is worth reporting.
  ///   `SystemLanguageModel.Variant` does not exist on iOS 26, and there is
  ///   exactly one on-device model there, so the fallback is the generic
  ///   `"Apple Foundation Model"` rather than a guessed variant name.
  /// - The four `supports*` flags: `LanguageModelCapabilities` as-is on iOS 27
  ///   (sdk-surface.md §1, "Capabilities"). On iOS 26 there is no
  ///   `capabilities` property (the `LanguageModel` protocol is 27), so they
  ///   are what the framework shipped with in 26.0: guided generation and tool
  ///   calling yes — `GenerationSchema` and `Tool` are 26.0 API — vision and
  ///   reasoning no (image input and `Transcript.Reasoning` arrived in 27).
  /// - `tokenCounting`: `"exact"` on iOS/macOS 26.4+, where
  ///   `SystemLanguageModel.tokenCount(for:)` exists, else `"estimated"` —
  ///   the TypeScript side then measures with its own estimator and never
  ///   calls `countTokens` (which throws `invalidRequest` below 26.4). "Exact"
  ///   describes the API, not this machine: D9's wedged-assets state makes it
  ///   throw even where it exists, and the context manager already handles
  ///   that per call.
  /// - `usageReporting`: `true` on iOS/macOS 27+, where `Response.usage` /
  ///   `Snapshot.usage` exist. When `false`, results carry no `usage`, and
  ///   `finishReason` cannot be `length` (see `GenerationEngine.finishReason`).
  static func capabilities(_ model: SystemLanguageModel = .default) -> [String: Any] {
    let contextSize = model.contextSize
    let locales = model.supportedLanguages
      .map(\.minimalIdentifier)
      .sorted()

    var info: [String: Any] = [
      "contextWindow": contextSize > 0 ? contextSize : 0,
      "locales": locales,
    ]

    if #available(iOS 27.0, macOS 27.0, *) {
      info["modelLabel"] = model.variant.displayName
      info["supportsVision"] = model.capabilities.contains(.vision)
      info["supportsGuidedGeneration"] = model.capabilities.contains(.guidedGeneration)
      info["supportsToolCalling"] = model.capabilities.contains(.toolCalling)
      info["supportsReasoning"] = model.capabilities.contains(.reasoning)
      info["usageReporting"] = true
    } else {
      info["modelLabel"] = "Apple Foundation Model"
      info["supportsVision"] = false
      info["supportsGuidedGeneration"] = true
      info["supportsToolCalling"] = true
      info["supportsReasoning"] = false
      info["usageReporting"] = false
    }

    if #available(iOS 26.4, macOS 26.4, *) {
      info["tokenCounting"] = "exact"
    } else {
      info["tokenCounting"] = "estimated"
    }

    return info
  }

  /// Exact locale support, per D7's availability pre-check.
  ///
  /// Delegates to `SystemLanguageModel.supportsLocale`, so the answer is the
  /// framework's own rather than a string match against the `locales` list.
  /// Accepts a BCP-47 tag (`"nl-NL"`) or a bare language code (`"nl"`).
  static func supportsLocale(_ tag: String, model: SystemLanguageModel = .default) -> Bool {
    model.supportsLocale(Locale(identifier: Locale.identifier(.icu, from: tag)))
  }
}
