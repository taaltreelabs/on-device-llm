//
//  SchemaChecks.swift
//  Runner
//
//  Phase 3 step 6, and the evidence behind DECISIONS.md D23.
//
//  The question D6 left open: does `GenerationSchema`'s `Codable` decode
//  preserve the constraints we promise callers (numeric bounds, array counts,
//  string patterns, enums), or does it drop them the way it drops `minLength`
//  and `format`? A constraint that decodes and then vanishes would be worse
//  than one we reject, so this checks the decoded schema by re-encoding it and
//  looking for the constraints in the output — and then checks the model's
//  actual output against them.
//

import Foundation
import FoundationModels

/// The normalised documents `src/apple/schema.ts` produces, written out by hand
/// so the harness fails if the two ever drift apart.
enum SchemaFixtures {
  /// Nested object, string enum, integer range, optional field and a bounded
  /// array — the whole *generation-supported* vocabulary in one document. No
  /// `pattern`: it decodes and then fails to generate (see
  /// ConstraintMatrixChecks).
  static let person = """
    {
      "type": "object",
      "title": "Person",
      "description": "A person",
      "properties": {
        "name": { "type": "string" },
        "age": { "type": "integer", "minimum": 0, "maximum": 120 },
        "favoriteColor": { "type": "string", "enum": ["red", "green", "blue"] },
        "nickname": { "type": "string" },
        "tags": {
          "type": "array",
          "items": { "type": "string" },
          "minItems": 1,
          "maxItems": 3
        },
        "address": {
          "type": "object",
          "title": "PersonAddress",
          "properties": {
            "city": { "type": "string" },
            "postalCode": { "type": "string" }
          },
          "required": ["city", "postalCode"],
          "x-order": ["city", "postalCode"],
          "additionalProperties": false
        }
      },
      "required": ["name", "age", "favoriteColor", "tags", "address"],
      "x-order": ["name", "age", "favoriteColor", "nickname", "tags", "address"],
      "additionalProperties": false
    }
    """

  /// A construct TypeScript rejects before the bridge; decoded here to prove
  /// the native backstop fails loudly rather than silently dropping it.
  static let withAllOf = """
    {
      "type": "object",
      "title": "Bad",
      "properties": { "a": { "allOf": [{ "type": "string" }] } },
      "required": ["a"],
      "x-order": ["a"],
      "additionalProperties": false
    }
    """

  /// Deliberately absurd: a large bounded array of long-ish strings. The point
  /// is that generation terminates rather than looping forever.
  static let absurd = """
    {
      "type": "object",
      "title": "Absurd",
      "properties": {
        "items": {
          "type": "array",
          "items": { "type": "string" },
          "minItems": 12,
          "maxItems": 20
        }
      },
      "required": ["items"],
      "x-order": ["items"],
      "additionalProperties": false
    }
    """

  static let weatherToolParameters = """
    {
      "type": "object",
      "title": "GetWeatherArguments",
      "properties": {
        "city": { "type": "string" }
      },
      "required": ["city"],
      "x-order": ["city"],
      "additionalProperties": false
    }
    """
}

func runSchemaChecks(_ harness: Harness) async {
  await harness.section("structured output (step 6)")

  await harness.check("a normalised document decodes into a GenerationSchema") {
    _ = try SchemaCodec.decode(SchemaFixtures.person, label: "fixture")
  }

  await harness.check("decode preserves the constraints we promise (D6 evidence)") {
    let schema = try SchemaCodec.decode(SchemaFixtures.person, label: "fixture")
    let encoded = String(data: try JSONEncoder().encode(schema), encoding: .utf8) ?? ""
    for needle in ["\"minimum\"", "\"maximum\"", "\"enum\"", "\"minItems\"", "\"maxItems\""] {
      try expect(
        encoded.contains(needle),
        "\(needle) did not survive the decode/encode round trip: \(encoded)")
    }
  }

  await harness.check("an unsupported construct is rejected as invalidRequest") {
    try await expectThrows("allOf") {
      _ = try SchemaCodec.decode(SchemaFixtures.withAllOf, label: "fixture")
    } where: { error in
      (error as? BridgeError)?.payload.code == "invalidRequest"
    }
  }

  await harness.check("generate returns an object that conforms to the schema") {
    let request = try makeRequest(
      [
        (
          .user,
          "Invent a Dutch person named Ada, 36 years old, who likes the colour green. "
            + "Give her two short tags and an address in Utrecht with postal code 3511 AB."
        )
      ],
      schemaJson: SchemaFixtures.person
    )
    let result = try await GenerationEngine.generate(request)
    guard let json = result.objectJson else {
      throw CheckFailure(message: "no objectJson on the result")
    }
    try expectEqual(result.text, json, "text should carry the same JSON as objectJson")
    try assertPersonConforms(json)
  }

  await harness.check("stream emits object snapshots and a conforming finish") {
    let log = EventLog()
    let request = try makeRequest(
      [
        (
          .user,
          "Invent a person named Bob, 44 years old, who likes blue. One tag. "
            + "Address in Delft, postal code 2611 AB."
        )
      ],
      schemaJson: SchemaFixtures.person
    )
    await GenerationEngine.stream(request, emit: log.emit)
    guard let finish = log.finish else {
      throw CheckFailure(message: "no finish event (error: \(String(describing: log.error)))")
    }
    try expect(!log.objectSnapshots.isEmpty, "no objectSnapshot events were emitted")
    try expect(log.deltas.isEmpty, "a structured stream emitted text deltas")
    try expectEqual(
      log.objectSnapshots.last, finish.objectJson, "last snapshot vs finish.objectJson")
    try assertPersonConforms(finish.objectJson ?? "")
  }

  await harness.check("an absurd constraint set still terminates") {
    let request = try makeRequest(
      [(.user, "List household objects.")],
      maxOutputTokens: 600,
      schemaJson: SchemaFixtures.absurd
    )
    // No assertion about the content: the point is that this returns at all
    // rather than looping until the context window runs out.
    _ = try? await GenerationEngine.generate(request)
  }
}

/// A conformance checker for `SchemaFixtures.person`.
///
/// Hand-written because there is no JSON Schema validator in this repo (and
/// `core` has zero runtime dependencies for the same reason). It checks exactly
/// the constraints the fixture promises.
private func assertPersonConforms(_ json: String) throws {
  guard let data = json.data(using: .utf8),
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    throw CheckFailure(message: "the result was not a JSON object: \(json)")
  }

  guard let name = object["name"] as? String, !name.isEmpty else {
    throw CheckFailure(message: "name missing or empty in \(json)")
  }
  guard let age = object["age"] as? Int else {
    throw CheckFailure(message: "age missing or not an integer in \(json)")
  }
  try expect((0...120).contains(age), "age \(age) outside 0...120")
  guard let color = object["favoriteColor"] as? String else {
    throw CheckFailure(message: "favoriteColor missing in \(json)")
  }
  try expect(["red", "green", "blue"].contains(color), "favoriteColor \(color) not in the enum")
  guard let tags = object["tags"] as? [Any] else {
    throw CheckFailure(message: "tags missing in \(json)")
  }
  try expect((1...3).contains(tags.count), "tags count \(tags.count) outside 1...3")
  try expect(tags.allSatisfy { $0 is String }, "tags contained a non-string")
  guard let address = object["address"] as? [String: Any] else {
    throw CheckFailure(message: "address missing or not an object in \(json)")
  }
  try expect(address["city"] is String, "address.city missing")
  guard let postalCode = address["postalCode"] as? String, !postalCode.isEmpty else {
    throw CheckFailure(message: "address.postalCode missing or empty")
  }
  // `additionalProperties: false` means nothing outside the schema.
  let known = Set(["name", "age", "favoriteColor", "nickname", "tags", "address"])
  let extra = Set(object.keys).subtracting(known)
  try expect(extra.isEmpty, "unexpected properties \(extra)")
}
