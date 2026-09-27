//
//  CompatChecks.swift
//  Runner
//
//  The iOS 26.0 floor (docs/research/ios26-compat.md), checked from a macOS 27
//  machine.
//
//  This Mac takes the iOS 27 paths at runtime, so the iOS 26 branches of
//  `ios/Core` are otherwise proven only by compilation (the harness package is
//  deliberately `.macOS("26.0")`). Two of them can nonetheless be *run* here:
//
//  - **The iOS 26 error taxonomy.** `LanguageModelSession.GenerationError` is
//    deprecated in 27 but still present, and its `Context` and `Refusal` have
//    public initialisers, so every case can be constructed and pushed through
//    the real `mapNativeError`. That verifies the mapping table itself, which
//    is the part most likely to be wrong; what it cannot verify is that iOS 26
//    really throws these (it is documented to — sdk-surface.md §5).
//  - **The `capabilities()` contract.** Every key the TypeScript side reads
//    must be present on every OS, with the value this OS implies.
//
//  Referencing the deprecated enum here is warning-free because the harness
//  targets macOS 26.0, below the 27.0 deprecation.
//

import Foundation
import FoundationModels

func runCompatChecks(_ harness: Harness) async {
  await harness.section("iOS 26 floor (compat)")

  await harness.check("capabilities() carries every contract key for this OS") {
    let caps = ModelInfo.capabilities()
    try expect(caps["contextWindow"] is Int, "contextWindow: \(String(describing: caps["contextWindow"]))")
    try expect(caps["locales"] is [String], "locales missing")
    try expect(
      (caps["modelLabel"] as? String)?.isEmpty == false,
      "modelLabel: \(String(describing: caps["modelLabel"]))")
    for key in ["supportsVision", "supportsGuidedGeneration", "supportsToolCalling", "supportsReasoning"] {
      try expect(caps[key] is Bool, "\(key): \(String(describing: caps[key]))")
    }

    let expectedCounting: String
    if #available(macOS 26.4, *) { expectedCounting = "exact" } else { expectedCounting = "estimated" }
    try expectEqual(caps["tokenCounting"] as? String, expectedCounting, "tokenCounting")

    let expectedUsage: Bool
    if #available(macOS 27.0, *) { expectedUsage = true } else { expectedUsage = false }
    try expectEqual(caps["usageReporting"] as? Bool, expectedUsage, "usageReporting")
  }

  await harness.check("usageReporting matches whether a result carries usage") {
    let caps = ModelInfo.capabilities()
    let result = try await GenerationEngine.generate(
      try makeRequest([(.user, "Reply with exactly: OK")]))
    try expectEqual(
      !result.usage.isEmpty, caps["usageReporting"] as? Bool ?? false,
      "usage present vs usageReporting")
  }

  await harness.check("the iOS 26 GenerationError taxonomy maps per sdk-surface.md §5") {
    typealias GenerationError = LanguageModelSession.GenerationError
    func context(_ tag: String) -> GenerationError.Context {
      GenerationError.Context(debugDescription: "harness: \(tag)")
    }

    // (error, code, reason, transient)
    let table: [(GenerationError, String, String?, Bool?, String)] = [
      (.exceededContextWindowSize(context("ctx")), "contextOverflow", nil, nil, "ctx"),
      (.assetsUnavailable(context("assets")), "unavailable", "modelNotReady", nil, "assets"),
      (.guardrailViolation(context("guard")), "guardrail", nil, nil, "guard"),
      (.unsupportedGuide(context("guide")), "invalidRequest", nil, nil, "guide"),
      (.unsupportedLanguageOrLocale(context("locale")), "unsupportedLocale", nil, nil, "locale"),
      (.decodingFailure(context("decode")), "unknown", nil, true, "decode"),
      (.rateLimited(context("rate")), "rateLimited", nil, nil, "rate"),
      (.concurrentRequests(context("concurrent")), "invalidRequest", nil, nil, "concurrent"),
      (
        .refusal(GenerationError.Refusal(transcriptEntries: []), context("refusal")),
        "guardrail", nil, nil, "refusal"
      ),
    ]

    for (error, code, reason, transient, tag) in table {
      let payload = mapNativeError(error)
      try expectEqual(payload.code, code, "\(tag) code")
      try expectEqual(payload.reason, reason, "\(tag) reason")
      try expectEqual(payload.transient, transient, "\(tag) transient")
      try expectEqual(payload.nativeDetail, "harness: \(tag)", "\(tag) nativeDetail")
      // The fields only the iOS 27 payloads carry must be absent, not invented.
      try expect(payload.contextSize == nil && payload.tokenCount == nil, "\(tag) invented a size")
      try expect(payload.rawContent == nil, "\(tag) invented rawContent")
      try expect(payload.locale == nil, "\(tag) invented a locale")
      try expect(payload.resetDate == nil, "\(tag) invented a resetDate")
    }
  }

  await harness.check("a legacy error wrapped in ToolCallError still maps through") {
    // Tool failures arrive wrapped (sdk-surface.md §5); the unwrap must feed
    // the iOS 26 path too, not only the 27 one.
    struct Dummy: Tool {
      let name = "dummy"
      let description = "unused"
      func call(arguments: GeneratedContent) async throws -> String { "" }
      var parameters: GenerationSchema {
        try! SchemaCodec.decode(
          #"{"type":"object","title":"Dummy","properties":{},"required":[],"x-order":[],"additionalProperties":false}"#,
          label: "dummy")
      }
    }
    let wrapped = LanguageModelSession.ToolCallError(
      tool: Dummy(),
      underlyingError: LanguageModelSession.GenerationError.rateLimited(
        .init(debugDescription: "harness: wrapped")))
    let payload = mapNativeError(wrapped)
    try expectEqual(payload.code, "rateLimited", "code")
    try expect(payload.message.hasPrefix("Tool \"dummy\" failed:"), "message: \(payload.message)")
  }
}
