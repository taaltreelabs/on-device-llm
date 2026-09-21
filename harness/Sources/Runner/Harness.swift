//
//  Harness.swift
//  Runner
//
//  A very small check runner. No XCTest: these are not unit tests, they are
//  assertions about a live model that may be unavailable, slow, or
//  nondeterministic, and the output has to be readable in a terminal and
//  pasteable into a commit message.
//

import Foundation
import FoundationModels

/// Records results and prints one line per check.
actor Harness {
  private(set) var passed = 0
  private(set) var failed = 0
  private var failures: [String] = []

  func check(_ name: String, _ body: () async throws -> Void) async {
    do {
      try await body()
      passed += 1
      print("  PASS  \(name)")
    } catch {
      failed += 1
      let reason = (error as? CheckFailure)?.message ?? String(describing: error)
      failures.append("\(name): \(reason)")
      print("  FAIL  \(name)\n        \(reason)")
    }
  }

  func section(_ name: String) {
    print("\n\(name)")
  }

  /// Prints the summary and returns the process exit code.
  func summarize() -> Int32 {
    print("\n\(passed) passed, \(failed) failed")
    for failure in failures {
      print("  - \(failure)")
    }
    return failed == 0 ? 0 : 1
  }
}

struct CheckFailure: Error {
  let message: String
}

func expect(_ condition: Bool, _ message: @autoclosure () -> String) throws {
  if !condition {
    throw CheckFailure(message: message())
  }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ label: String) throws {
  if actual != expected {
    throw CheckFailure(message: "\(label): expected \(expected), got \(actual)")
  }
}

func expectThrows(
  _ label: String,
  _ body: () async throws -> Void,
  where predicate: (Error) -> Bool = { _ in true }
) async throws {
  do {
    try await body()
  } catch {
    guard predicate(error) else {
      throw CheckFailure(message: "\(label): threw the wrong error: \(error)")
    }
    return
  }
  throw CheckFailure(message: "\(label): expected a throw, got a normal return")
}

/// Thread-safe event sink for `GenerationEngine.stream`'s `emit` closure.
///
/// A plain array behind a lock rather than an actor: `emit` is a synchronous
/// `@Sendable` closure, and hopping to an actor from inside it would reorder
/// the very sequence these checks are about.
final class EventLog: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [BridgeStreamEvent] = []
  private var onEvent: (@Sendable (BridgeStreamEvent) -> Void)?

  init(onEvent: (@Sendable (BridgeStreamEvent) -> Void)? = nil) {
    self.onEvent = onEvent
  }

  var emit: @Sendable (BridgeStreamEvent) -> Void {
    { [self] event in
      lock.lock()
      events.append(event)
      let handler = onEvent
      lock.unlock()
      handler?(event)
    }
  }

  var all: [BridgeStreamEvent] {
    lock.lock()
    defer { lock.unlock() }
    return events
  }

  var deltas: [String] {
    all.compactMap { if case let .delta(text, _) = $0 { return text } else { return nil } }
  }

  var objectSnapshots: [String] {
    all.compactMap { if case let .objectSnapshot(json) = $0 { return json } else { return nil } }
  }

  var toolCalls: [(callId: String, toolName: String, argumentsJson: String)] {
    all.compactMap {
      if case let .toolCall(callId, toolName, argumentsJson) = $0 {
        return (callId, toolName, argumentsJson)
      }
      return nil
    }
  }

  var finish: BridgeResult? {
    for event in all.reversed() {
      if case let .finish(result) = event { return result }
    }
    return nil
  }

  var error: BridgeErrorPayload? {
    for event in all.reversed() {
      if case let .error(payload) = event { return payload }
    }
    return nil
  }
}

/// A request built the way the TypeScript wrapper builds one.
func makeRequest(
  _ messages: [(BridgeRole, String)],
  temperature: Double? = 0,
  maxOutputTokens: Int? = nil,
  schemaJson: String? = nil,
  tools: [[String: String]] = [],
  toolCallTimeoutMs: Int? = nil
) throws -> BridgeRequest {
  try BridgeRequest.parse(
    messages: messages.map { ["role": $0.0.rawValue, "content": $0.1] },
    temperature: temperature,
    maximumResponseTokens: maxOutputTokens,
    schemaJson: schemaJson,
    tools: tools,
    toolCallTimeoutMs: toolCallTimeoutMs
  )
}

/// `true` when this machine can actually run the checks.
func modelIsUsable() -> Bool {
  if case .available = SystemLanguageModel.default.availability { return true }
  return false
}
