//
//  ToolBridge.swift
//  OnDeviceLlm
//
//  Tool calling across the bridge — Phase 3 step 7, the hardest piece
//  (docs/plan.md §4: "the native model calls a Swift `Tool`, which has to
//  invoke a JS function and await its result").
//
//  The protocol, in full (DECISIONS.md D24):
//
//    model -> BridgedTool.call(arguments:)
//          -> registry registers a continuation under a fresh callId
//          -> `toolCall` event to JavaScript (callId, toolName, argumentsJson)
//          -> JavaScript runs the app's handler
//          -> `resolveToolCall(callId, resultJson | errorMessage)`
//          -> the continuation resumes, `call` returns text to the model
//          -> generation continues to completion
//
//  Three things every prior-art bridge we surveyed gets wrong (DECISIONS.md
//  D2) and this file exists to get right:
//
//  1. **Timeout.** A handler that never answers must not pin the neural engine
//     forever. Each call arms a timer; when it fires the continuation is
//     resumed with an error and the request fails with a clear reason.
//  2. **Cancellation mid-call.** `cancel(requestId)` resumes every pending
//     continuation for that request with `CancellationError` *and* cancels the
//     generation task, so nothing is left suspended.
//  3. **Late and duplicate replies.** A `resolveToolCall` arriving after a
//     timeout, after a cancel, or twice for one callId is a no-op returning
//     `false` — resuming a continuation twice is a crash, and the race is
//     entirely normal (JS cannot know the timer fired).
//
//  Keyed by callId, not by requestId: the model may have two tool calls in
//  flight at once, and a registry that assumed one would deliver the first
//  answer to the second call.
//

import Foundation
import FoundationModels

/// Concurrency-safe map of in-flight tool calls.
///
/// An `actor` for the same reason as `RequestRegistry`: registration happens on
/// the generation task, resolution on whatever task the bridge call lands on,
/// and the timeout on a third. Serialising them is what makes "resume exactly
/// once" a structural property instead of a lock discipline.
actor ToolCallRegistry {
  private struct Pending {
    let continuation: CheckedContinuation<String, Error>
    let requestId: String
    let toolName: String
  }

  private var pending: [String: Pending] = [:]
  private var callsByRequest: [String: Set<String>] = [:]
  private var timeouts: [String: Task<Void, Never>] = [:]
  /// Requests whose cancellation arrived before (or during) a registration.
  /// Without this, a tool call registered a moment after `cancel` would wait
  /// for its full timeout with nobody left to answer it.
  private var cancelledRequests: Set<String> = []

  init() {}

  /// Number of suspended tool calls. The harness asserts this returns to zero
  /// after a cancellation — a leaked continuation is a leaked generation.
  var pendingCount: Int { pending.count }

  func pendingCount(forRequest requestId: String) -> Int {
    callsByRequest[requestId]?.count ?? 0
  }

  /// Suspend until JavaScript answers `callId`, or the budget runs out.
  ///
  /// `onRegistered` is called *after* the continuation is stored and before
  /// this function suspends. The `toolCall` event is emitted from there on
  /// purpose: emitting first would open a window in which a very fast
  /// JavaScript handler resolves a callId the registry has never heard of,
  /// which the late-reply rule would then correctly — and fatally — ignore.
  func awaitResult(
    callId: String,
    requestId: String,
    toolName: String,
    timeoutMs: Int,
    onRegistered: @Sendable () -> Void
  ) async throws -> String {
    if cancelledRequests.contains(requestId) {
      throw CancellationError()
    }
    try Task.checkCancellation()

    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<String, Error>) in
        pending[callId] = Pending(
          continuation: continuation, requestId: requestId, toolName: toolName)
        callsByRequest[requestId, default: []].insert(callId)
        timeouts[callId] = Task { [weak self] in
          try? await Task.sleep(for: .milliseconds(timeoutMs))
          if Task.isCancelled { return }
          await self?.timeOut(callId: callId, timeoutMs: timeoutMs)
        }
        onRegistered()
      }
    } onCancel: {
      Task { [weak self] in await self?.cancel(callId: callId) }
    }
  }

  /// JavaScript answered. Returns `false` for a callId that is no longer
  /// waiting (timed out, cancelled, or already answered) — a normal race, not
  /// an error.
  @discardableResult
  func resolve(callId: String, result: String) -> Bool {
    guard let entry = remove(callId) else { return false }
    entry.continuation.resume(returning: result)
    return true
  }

  /// The JavaScript handler threw. Same late-reply rule as `resolve`.
  @discardableResult
  func fail(callId: String, message: String) -> Bool {
    guard let entry = remove(callId) else { return false }
    entry.continuation.resume(
      throwing: BridgeError.toolHandlerFailed(
        tool: entry.toolName, callId: callId, message: message))
    return true
  }

  /// Abandon every tool call belonging to `requestId`.
  ///
  /// Called from `cancel(requestId)` alongside the generation task's own
  /// cancellation: cancelling the task alone would leave `Tool.call` suspended
  /// on a continuation nobody is going to resume, because the framework has no
  /// way to interrupt our `await`.
  func cancelRequest(_ requestId: String) {
    cancelledRequests.insert(requestId)
    for callId in callsByRequest[requestId] ?? [] {
      if let entry = remove(callId) {
        entry.continuation.resume(throwing: CancellationError())
      }
    }
    callsByRequest[requestId] = nil
  }

  /// Drop a finished request's bookkeeping. Any call still pending here is a
  /// bug — generation cannot finish while a tool is suspended — so it is
  /// resumed with a cancellation rather than left to leak.
  func finishRequest(_ requestId: String) {
    for callId in callsByRequest[requestId] ?? [] {
      if let entry = remove(callId) {
        entry.continuation.resume(throwing: CancellationError())
      }
    }
    callsByRequest[requestId] = nil
    cancelledRequests.remove(requestId)
  }

  // MARK: - Private

  private func cancel(callId: String) {
    guard let entry = remove(callId) else { return }
    entry.continuation.resume(throwing: CancellationError())
  }

  private func timeOut(callId: String, timeoutMs: Int) {
    guard let entry = remove(callId) else { return }
    entry.continuation.resume(
      throwing: BridgeError.toolCallTimedOut(
        tool: entry.toolName, callId: callId, timeoutMs: timeoutMs))
  }

  /// Take a pending call out of the registry, cancelling its timer. Returning
  /// `nil` is how every "resume exactly once" guarantee in this file is
  /// enforced: whoever gets the entry owns the resume.
  private func remove(_ callId: String) -> Pending? {
    timeouts.removeValue(forKey: callId)?.cancel()
    guard let entry = pending.removeValue(forKey: callId) else { return nil }
    callsByRequest[entry.requestId]?.remove(callId)
    if callsByRequest[entry.requestId]?.isEmpty == true {
      callsByRequest[entry.requestId] = nil
    }
    return entry
  }
}

/// The one `Tool` type this module ever constructs.
///
/// `Arguments == GeneratedContent` and `Output == String` are the two choices
/// the protocol actually allows for a runtime-defined tool
/// (docs/research/sdk-surface.md §8): every scalar `Arguments` witness is
/// explicitly `@available(*, unavailable)`, and `GeneratedContent` is
/// `Generable`, so it is both a legal `Arguments` and trivially convertible to
/// the JSON text JavaScript wants. `call` being `async throws` is what makes
/// the JS round trip possible at all — no polling, no semaphores.
struct BridgedTool: Tool {
  typealias Arguments = GeneratedContent
  typealias Output = String

  let name: String
  let description: String
  let parameters: GenerationSchema
  var includesSchemaInInstructions: Bool { true }

  let requestId: String
  let timeoutMs: Int
  let registry: ToolCallRegistry
  let emit: @Sendable (BridgeStreamEvent) -> Void

  func call(arguments: GeneratedContent) async throws -> String {
    let callId = Self.makeCallId(requestId: requestId)
    let argumentsJson = SchemaCodec.json(from: arguments)
    return try await registry.awaitResult(
      callId: callId,
      requestId: requestId,
      toolName: name,
      timeoutMs: timeoutMs
    ) {
      emit(.toolCall(callId: callId, toolName: name, argumentsJson: argumentsJson))
    }
  }

  /// Unique across the process, and readable in a log next to its request.
  static func makeCallId(requestId: String) -> String {
    "\(requestId)::\(UUID().uuidString.prefix(8))"
  }

  /// Build the tools for one request. Throws `invalidRequest` if a tool's
  /// parameter schema does not decode — better here, before a token is
  /// generated, than as a mid-generation surprise.
  static func build(
    from definitions: [BridgeToolDefinition],
    requestId: String,
    timeoutMs: Int,
    registry: ToolCallRegistry,
    emit: @escaping @Sendable (BridgeStreamEvent) -> Void
  ) throws -> [any Tool] {
    try definitions.map { definition in
      BridgedTool(
        name: definition.name,
        description: definition.description,
        parameters: try SchemaCodec.decode(
          definition.parametersJson, label: "The parameter schema for tool \"\(definition.name)\""),
        requestId: requestId,
        timeoutMs: timeoutMs,
        registry: registry,
        emit: emit
      )
    }
  }
}
