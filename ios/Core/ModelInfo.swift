//
//  ModelInfo.swift
//  OnDeviceLlm
//
//  Availability, capabilities and locale support — Phase 3 step 1.
//

import Foundation
import FoundationModels

enum ModelInfo {
  /// `SystemLanguageModel.Availability` -> `src/core`'s `Availability`.
  ///
  /// The framework has exactly three unavailable reasons and **none of them is
  /// locale-related** (DECISIONS.md D7); `unsupportedPlatform` is the
  /// TypeScript layer's business, because by definition Swift does not run to
  /// report it. So this maps three cases and nothing else.
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
  ///   number to guess.
  /// - `locales`: `Locale.Language.minimalIdentifier` (`"nl"`, `"en-GB"`,
  ///   `"es-419"`), i.e. plain BCP-47 as a JS caller would write it. Note the
  ///   discrepancy with docs/research/sdk-surface.md §1, which lists the
  ///   *maximal* identifiers (`"nl-Latn-NL"`); both come from the same set,
  ///   the minimal form is what `Intl`/`navigator.language` produce, and exact
  ///   matching should go through `supportsLocale` anyway.
  /// - `modelLabel`: `variant.displayName` — measured `"AFM 3 Core Advanced"`
  ///   on the development Mac, `"AFM 3 Core"` on the machine used for the
  ///   Phase 0 recon. It explains context-size and quality differences between
  ///   devices, so it is worth reporting.
  /// - The four `LanguageModelCapabilities` flags are reported as-is. Steps
  ///   4-7 of Phase 3 will consume them; today the TypeScript side still
  ///   reports `structuredOutput: false` / `tools: false` because the bridge
  ///   has not implemented them, not because the model cannot.
  static func capabilities(_ model: SystemLanguageModel = .default) -> [String: Any] {
    let contextSize = model.contextSize
    let locales = model.supportedLanguages
      .map(\.minimalIdentifier)
      .sorted()

    return [
      "contextWindow": contextSize > 0 ? contextSize : 0,
      "locales": locales,
      "modelLabel": model.variant.displayName,
      "supportsVision": model.capabilities.contains(.vision),
      "supportsGuidedGeneration": model.capabilities.contains(.guidedGeneration),
      "supportsToolCalling": model.capabilities.contains(.toolCalling),
      "supportsReasoning": model.capabilities.contains(.reasoning),
    ]
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
