//
//  BridgeTypes.swift
//  OnDeviceLlm
//
//  The value types that cross the JS <-> Swift boundary, expressed as plain
//  Swift. Nothing in `ios/Core` imports ExpoModulesCore: the FoundationModels
//  logic (transcript construction, snapshot diffing, error mapping) is
//  compiled unchanged by the macOS verification harness in the scratchpad,
//  which runs it against the real on-device model. `OnDeviceLlmModule.swift`
//  is the only file that knows about Expo, and it is thin glue by design.
//
//  See DECISIONS.md D16 (Modules API choice) and D17 (transcript/prompt split).
//

import Foundation

// MARK: - Request

/// The message roles `src/core`'s `Message` can carry.
/// Mirrors `MessageRole` in `src/core/messages.ts`.
enum BridgeRole: String, Sendable, CaseIterable {
  case system
  case user
  case assistant
}

/// One message from the JS conversation list.
struct BridgeMessage: Sendable, Equatable {
  let role: BridgeRole
  let content: String
}

/// The sampling options this provider supports.
///
/// Deliberately only the two `GenerationOptions` fields that `GenerateRequest`
/// exposes (`temperature`, `maxOutputTokens`). The framework's complete option
/// list is four fields (docs/research/sdk-surface.md §4); `samplingMode` and
/// `toolCallingMode` have no counterpart in the frozen `core` request type yet,
/// so they are not plumbed. Anything else a caller passes is rejected in
/// TypeScript as `invalidRequest` before it reaches this layer.
struct BridgeGenerationOptions: Sendable, Equatable {
  var temperature: Double?
  var maximumResponseTokens: Int?

  static let none = BridgeGenerationOptions()
}

/// A complete generation request as it arrives from JavaScript.
struct BridgeRequest: Sendable, Equatable {
  let messages: [BridgeMessage]
  let options: BridgeGenerationOptions

  /// Parse the wire form (`[["role": "user", "content": "…"], …]`).
  ///
  /// The TypeScript wrapper validates roles before calling, so an unknown role
  /// here means a bridge bug or a hand-rolled caller; either way it is an
  /// `invalidRequest`, not something to silently coerce to `user`.
  static func parse(
    messages: [[String: String]],
    temperature: Double?,
    maximumResponseTokens: Int?
  ) throws -> BridgeRequest {
    var parsed: [BridgeMessage] = []
    parsed.reserveCapacity(messages.count)
    for (index, raw) in messages.enumerated() {
      guard let rawRole = raw["role"] else {
        throw BridgeError.invalidRequest("messages[\(index)] has no \"role\"")
      }
      guard let role = BridgeRole(rawValue: rawRole) else {
        throw BridgeError.invalidRequest(
          "messages[\(index)] has an unsupported role \"\(rawRole)\"")
      }
      guard let content = raw["content"] else {
        throw BridgeError.invalidRequest("messages[\(index)] has no \"content\"")
      }
      parsed.append(BridgeMessage(role: role, content: content))
    }
    return BridgeRequest(
      messages: parsed,
      options: BridgeGenerationOptions(
        temperature: temperature,
        maximumResponseTokens: maximumResponseTokens
      )
    )
  }
}

// MARK: - Result

/// Token usage, shaped like `src/core`'s `TokenUsage`.
struct BridgeUsage: Sendable, Equatable {
  var inputTokens: Int?
  var outputTokens: Int?
  var cachedInputTokens: Int?
  var reasoningTokens: Int?

  var isEmpty: Bool {
    inputTokens == nil && outputTokens == nil && cachedInputTokens == nil && reasoningTokens == nil
  }

  func toDictionary() -> [String: Any] {
    var dict: [String: Any] = [:]
    if let inputTokens { dict["inputTokens"] = inputTokens }
    if let outputTokens { dict["outputTokens"] = outputTokens }
    if let cachedInputTokens { dict["cachedInputTokens"] = cachedInputTokens }
    if let reasoningTokens { dict["reasoningTokens"] = reasoningTokens }
    return dict
  }
}

/// A finished generation, shaped like `src/core`'s `GenerateResult` minus
/// `providerId` (which only the TypeScript side knows).
struct BridgeResult: Sendable, Equatable {
  let text: String
  /// One of `src/core`'s `FinishReason` strings.
  let finishReason: String
  let usage: BridgeUsage

  func toDictionary() -> [String: Any] {
    var dict: [String: Any] = ["text": text, "finishReason": finishReason]
    if !usage.isEmpty { dict["usage"] = usage.toDictionary() }
    return dict
  }
}

// MARK: - Errors

/// A failure already mapped onto `src/core`'s `LLMErrorCode` taxonomy.
///
/// Every field beyond `code`/`message` is optional and corresponds to a field
/// of one `LLMErrorDetails` variant, so the TypeScript side can rebuild a
/// properly-typed `LLMError` without a second mapping table. Modelled as a
/// flat `Sendable` struct rather than `[String: Any]` so it can cross actor
/// boundaries and be compared in tests.
struct BridgeErrorPayload: Sendable, Equatable {
  /// An `LLMErrorCode` value: `unavailable`, `contextOverflow`, `guardrail`,
  /// `unsupportedLocale`, `rateLimited`, `cancelled`, `network`,
  /// `invalidRequest`, `unknown`.
  var code: String
  /// Human-readable, never containing prompt or response content.
  var message: String

  // `unavailable`
  var reason: String?
  // `contextOverflow`
  var contextSize: Int?
  var tokenCount: Int?
  // `unsupportedLocale`
  var locale: String?
  // `rateLimited` — milliseconds since the epoch, so JS can `new Date(n)`.
  var resetDate: Double?
  // `unknown`
  var transient: Bool?

  // Diagnostics, attached to every payload we can attach them to. DECISIONS.md
  // D9: untyped `NSError`s do escape this framework, and losing the domain and
  // code is what makes them unreportable.
  var nativeDomain: String?
  var nativeCode: Int?
  /// The framework's own `debugDescription`, when the error carried one.
  var nativeDetail: String?

  init(code: String, message: String) {
    self.code = code
    self.message = message
  }

  func toDictionary() -> [String: Any] {
    var dict: [String: Any] = ["code": code, "message": message]
    if let reason { dict["reason"] = reason }
    if let contextSize { dict["contextSize"] = contextSize }
    if let tokenCount { dict["tokenCount"] = tokenCount }
    if let locale { dict["locale"] = locale }
    if let resetDate { dict["resetDate"] = resetDate }
    if let transient { dict["transient"] = transient }
    if let nativeDomain { dict["nativeDomain"] = nativeDomain }
    if let nativeCode { dict["nativeCode"] = nativeCode }
    if let nativeDetail { dict["nativeDetail"] = nativeDetail }
    return dict
  }
}

/// Errors this bridge raises itself, as opposed to ones the framework throws.
/// Carried through `mapNativeError` unchanged.
struct BridgeError: Error, Sendable, Equatable {
  let payload: BridgeErrorPayload

  static func invalidRequest(_ message: String) -> BridgeError {
    BridgeError(payload: BridgeErrorPayload(code: "invalidRequest", message: message))
  }

  static func unavailable(_ reason: String, _ message: String) -> BridgeError {
    var payload = BridgeErrorPayload(code: "unavailable", message: message)
    payload.reason = reason
    return BridgeError(payload: payload)
  }
}

// MARK: - Stream events

/// What `GenerationEngine.stream` hands back, one per native event sent to JS.
enum BridgeStreamEvent: Sendable, Equatable {
  /// Text produced since the previous delta. `reset` marks the snapshot-diff
  /// fallback described in DECISIONS.md D18.
  case delta(String, reset: Bool)
  case finish(BridgeResult)
  case error(BridgeErrorPayload)

  /// The `type` discriminant JavaScript switches on.
  var type: String {
    switch self {
    case .delta: return "delta"
    case .finish: return "finish"
    case .error: return "error"
    }
  }

  func toDictionary(requestId: String) -> [String: Any] {
    var dict: [String: Any] = ["requestId": requestId, "type": type]
    switch self {
    case let .delta(text, reset):
      dict["delta"] = text
      dict["reset"] = reset
    case let .finish(result):
      dict["result"] = result.toDictionary()
    case let .error(payload):
      dict["error"] = payload.toDictionary()
    }
    return dict
  }
}
