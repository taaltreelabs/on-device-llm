//
//  ConstraintMatrixChecks.swift
//  Runner
//
//  Which JSON Schema constraints the on-device model accepts **at generation
//  time** — a different and stricter question than which ones
//  `GenerationSchema` decodes, and the finding that shaped DECISIONS.md D23.
//
//  docs/research/sdk-surface.md §7 built each construct and confirmed the
//  schema was accepted. That is where the surprise lives: `pattern` builds, and
//  decodes, and then `respond(schema:)` throws
//  `LanguageModelError.unsupportedGenerationGuide` ("UnsupportedGuide") on this
//  model. Anything this file shows as rejected is rejected by
//  `src/apple/schema.ts` before it ever crosses the bridge, so a developer
//  finds out at the call site instead of one generation later.
//
//  Keep this running: it is the regression test for a future OS quietly
//  widening — or narrowing — the supported set.
//

import Foundation
import FoundationModels

private func probeDocument(_ propertyJson: String) -> String {
  """
  {
    "type": "object",
    "title": "Probe",
    "properties": { "value": \(propertyJson) },
    "required": ["value"],
    "x-order": ["value"],
    "additionalProperties": false
  }
  """
}

private func generateWithProbe(_ propertyJson: String) async throws {
  _ = try await GenerationEngine.generate(
    try makeRequest(
      [(.user, "Produce a small example value.")],
      maxOutputTokens: 200,
      schemaJson: probeDocument(propertyJson)
    ))
}

func runConstraintMatrixChecks(_ harness: Harness) async {
  await harness.section("constraint matrix (step 6 evidence)")

  let supported: [(String, String)] = [
    ("string", #"{ "type": "string" }"#),
    ("string enum", #"{ "type": "string", "enum": ["red", "green", "blue"] }"#),
    ("string const", #"{ "type": "string", "const": "fixed" }"#),
    ("integer", #"{ "type": "integer" }"#),
    ("integer minimum/maximum", #"{ "type": "integer", "minimum": 0, "maximum": 120 }"#),
    ("number minimum/maximum", #"{ "type": "number", "minimum": 0, "maximum": 1 }"#),
    ("boolean", #"{ "type": "boolean" }"#),
    ("array", #"{ "type": "array", "items": { "type": "string" } }"#),
    (
      "array minItems/maxItems",
      #"{ "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 3 }"#
    ),
    (
      "nested object",
      """
      { "type": "object", "title": "Inner",
        "properties": { "city": { "type": "string" } },
        "required": ["city"], "x-order": ["city"], "additionalProperties": false }
      """
    ),
  ]

  for (label, property) in supported {
    await harness.check("supported: \(label)") {
      try await generateWithProbe(property)
    }
  }

  await harness.check("supported: optional property (present in x-order, absent from required)") {
    _ = try await GenerationEngine.generate(
      try makeRequest(
        [(.user, "Produce a small example value.")],
        maxOutputTokens: 200,
        schemaJson: """
          {
            "type": "object",
            "title": "Probe",
            "properties": { "a": { "type": "string" }, "b": { "type": "string" } },
            "required": ["a"],
            "x-order": ["a", "b"],
            "additionalProperties": false
          }
          """
      ))
  }

  await harness.check("NOT supported: string pattern (decodes, then fails to generate)") {
    // Decoding succeeds — this is exactly why the rejection has to live in
    // TypeScript rather than relying on the decoder to catch it.
    _ = try SchemaCodec.decode(
      probeDocument(#"{ "type": "string", "pattern": "[0-9]{4}" }"#), label: "probe")
    try await expectThrows("pattern at generation time") {
      try await generateWithProbe(#"{ "type": "string", "pattern": "[0-9]{4} [A-Z]{2}" }"#)
    } where: { error in
      guard let modelError = error as? LanguageModelError else { return false }
      if case .unsupportedGenerationGuide = modelError { return true }
      return false
    }
  }
}
