//
//  SchemaCodec.swift
//  OnDeviceLlm
//
//  JSON Schema (from JavaScript) <-> `GenerationSchema`, and
//  `GeneratedContent` -> JSON text.
//
//  DECISIONS.md D23: the schema arriving here has already been validated and
//  normalised in TypeScript (`src/core/schema.ts` + `src/apple/schema.ts`) into
//  the exact dialect `GenerationSchema`'s `Codable` conformance accepts —
//  every object node carrying `title`, `additionalProperties`, `required` and
//  Apple's `x-order` extension, and nothing from the unsupported set. So this
//  file is a decoder, not a translator: there is no tree-walk into
//  `DynamicGenerationSchema` here, and a decode failure means the normaliser
//  and the framework disagree, which is a bug worth reporting loudly rather
//  than papering over with a fallback that would silently drop constraints.
//

import Foundation
import FoundationModels

enum SchemaCodec {
  /// Decode a normalised JSON Schema document into a `GenerationSchema`.
  ///
  /// Every failure becomes `invalidRequest`: a schema that cannot be decoded
  /// will not decode next time either, so it must never be retried or failed
  /// over. `DecodingError`'s coding path is unwrapped into the message because
  /// "keyNotFound x-order at properties.address" is actionable and
  /// "The data couldn't be read" is not.
  static func decode(_ json: String, label: String) throws -> GenerationSchema {
    guard let data = json.data(using: .utf8) else {
      throw BridgeError.invalidRequest("\(label) is not valid UTF-8.")
    }
    do {
      return try JSONDecoder().decode(GenerationSchema.self, from: data)
    } catch let error as DecodingError {
      throw BridgeError.invalidRequest("\(label) was rejected by the model: \(describe(error))")
    } catch {
      throw BridgeError.invalidRequest(
        "\(label) was rejected by the model: \(String(describing: error))")
    }
  }

  /// `GeneratedContent` as JSON text.
  ///
  /// `jsonString` rather than a hand-written `Kind` walk: it is the
  /// framework's own serialisation, it round-trips through
  /// `GeneratedContent(json:)`, and it is defined for partially generated
  /// content too (docs/research/sdk-surface.md §7), which is what makes
  /// streaming object snapshots possible without waiting for a valid document.
  static func json(from content: GeneratedContent) -> String {
    content.jsonString
  }

  // MARK: - Diagnostics

  private static func describe(_ error: DecodingError) -> String {
    switch error {
    case let .keyNotFound(key, context):
      return "missing key \"\(key.stringValue)\"\(at(context))"
    case let .typeMismatch(type, context):
      return "expected \(type)\(at(context))"
    case let .valueNotFound(type, context):
      return "missing value of type \(type)\(at(context))"
    case let .dataCorrupted(context):
      return "\(context.debugDescription)\(at(context))"
    @unknown default:
      return String(describing: error)
    }
  }

  private static func at(_ context: DecodingError.Context) -> String {
    let path = context.codingPath.map(\.stringValue).filter { !$0.isEmpty }
    return path.isEmpty ? "" : " at \(path.joined(separator: "."))"
  }
}
