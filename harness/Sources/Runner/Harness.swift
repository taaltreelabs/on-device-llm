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

  /// Run one check under a hard deadline.
  ///
  /// The deadline is not belt-and-braces: the failures this harness exists to
  /// catch — a tool-call continuation nobody resumes, a stream that never
  /// terminates — are exactly the ones that would otherwise hang the runner
  /// forever with no output. A check that blows its deadline is reported as a
  /// failure and *abandoned* (its task is cancelled but not awaited, so a truly
  /// stuck task cannot take the summary down with it).
  func check(
    _ name: String,
    timeout: Duration = .seconds(90),
    _ body: @escaping @Sendable () async throws -> Void
  ) async {
    log("  ....  \(name)")
    do {
      try await withDeadline(timeout, name: name, body)
      passed += 1
      log("  PASS  \(name)")
    } catch {
      failed += 1
      let reason = (error as? CheckFailure)?.message ?? String(describing: error)
      failures.append("\(name): \(reason)")
      log("  FAIL  \(name)\n        \(reason)")
    }
  }

  func section(_ name: String) {
    log("\n\(name)")
  }

  /// Unbuffered: a harness that stalls must still have shown what it stalled
  /// on, and stdout to a pipe is block-buffered by default.
  private func log(_ line: String) {
    print(line)
    fflush(stdout)
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

/// Race `body` against a deadline, resuming whichever finishes first.
///
/// Deliberately *not* a `withThrowingTaskGroup`: a task group awaits its
/// children when the scope exits, so a child that ignores cancellation — which
/// is precisely what a leaked continuation does — would hang the runner even
/// though the deadline fired. An unstructured task plus a resume-once box lets
/// the runner walk away from it.
func withDeadline(
  _ duration: Duration,
  name: String,
  _ body: @escaping @Sendable () async throws -> Void
) async throws {
  let box = ResumeOnce()
  let work = Task { @Sendable in
    do {
      try await body()
      box.finish(.success(()))
    } catch {
      box.finish(.failure(error))
    }
  }
  let timer = Task { @Sendable in
    try? await Task.sleep(for: duration)
    if Task.isCancelled { return }
    work.cancel()
    box.finish(
      .failure(
        CheckFailure(
          message:
            "timed out after \(duration) — the check was abandoned, something is not resuming")))
  }
  defer { timer.cancel() }
  try await box.value
}

/// A `Result` that can be delivered from either of two racing tasks, exactly
/// once, to one awaiting caller.
final class ResumeOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Result<Void, Error>?
  private var continuation: CheckedContinuation<Void, Error>?

  func finish(_ value: Result<Void, Error>) {
    lock.lock()
    guard result == nil else {
      lock.unlock()
      return
    }
    result = value
    let waiter = continuation
    continuation = nil
    lock.unlock()
    waiter?.resume(with: value)
  }

  var value: Void {
    get async throws {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, Error>) in
        lock.lock()
        if let result {
          lock.unlock()
          continuation.resume(with: result)
          return
        }
        self.continuation = continuation
        lock.unlock()
      }
    }
  }
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
