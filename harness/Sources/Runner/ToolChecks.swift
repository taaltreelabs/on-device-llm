//
//  ToolChecks.swift
//  Runner
//
//  Phase 3 step 7 — the continuation/registry/timeout/cancellation machinery,
//  against the real model.
//
//  The Swift handler below stands in for JavaScript: it does exactly what
//  `src/apple/stream-bridge.ts` does (see a `toolCall` event, run something,
//  call `resolveToolCall`), so what is under test here is the native half —
//  that a suspended `Tool.call` resumes exactly once, that a silent handler is
//  timed out rather than waited on forever, and that a cancel mid-call leaves
//  nothing suspended. The JS half is covered by the TypeScript unit tests
//  against the fake native module.
//

import Foundation
import FoundationModels

private let weatherTool: [String: String] = [
  "name": "getWeather",
  "description": "Get the current weather for a city. Always call this before answering.",
  "parametersJson": SchemaFixtures.weatherToolParameters,
]

func runToolChecks(_ harness: Harness) async {
  await harness.section("tool calling (step 7)")

  await harness.check("registry: resolve, double-resolve, late resolve") {
    let registry = ToolCallRegistry()
    let started = AsyncSemaphore()
    let task = Task {
      try await registry.awaitResult(
        callId: "c1", requestId: "r1", toolName: "t", timeoutMs: 5_000
      ) {
        started.signal()
      }
    }
    await started.wait()
    let first = await registry.resolve(callId: "c1", result: "sunny")
    try expect(first, "the first resolve was ignored")
    let second = await registry.resolve(callId: "c1", result: "rainy")
    try expect(!second, "a second resolve for the same callId was accepted")
    try expectEqual(try await task.value, "sunny", "resolved value")
    try expectEqual(await registry.pendingCount, 0, "pending calls after resolve")
    let late = await registry.resolve(callId: "never-registered", result: "x")
    try expect(!late, "an unknown callId was accepted")
  }

  await harness.check("registry: two concurrent calls resolve independently") {
    let registry = ToolCallRegistry()
    let firstStarted = AsyncSemaphore()
    let secondStarted = AsyncSemaphore()
    let a = Task {
      try await registry.awaitResult(
        callId: "a", requestId: "r", toolName: "t", timeoutMs: 5_000
      ) { firstStarted.signal() }
    }
    let b = Task {
      try await registry.awaitResult(
        callId: "b", requestId: "r", toolName: "t", timeoutMs: 5_000
      ) { secondStarted.signal() }
    }
    await firstStarted.wait()
    await secondStarted.wait()
    try expectEqual(await registry.pendingCount, 2, "pending calls")
    // Out of order on purpose: a registry keyed by requestId alone would hand
    // "second" to whichever call it happened to be holding.
    await registry.resolve(callId: "b", result: "second")
    await registry.resolve(callId: "a", result: "first")
    try expectEqual(try await a.value, "first", "call a")
    try expectEqual(try await b.value, "second", "call b")
    try expectEqual(await registry.pendingCount, 0, "pending calls afterwards")
  }

  await harness.check("registry: cancelRequest resumes every pending call") {
    let registry = ToolCallRegistry()
    let started = AsyncSemaphore()
    let task = Task {
      try await registry.awaitResult(
        callId: "c", requestId: "r", toolName: "t", timeoutMs: 60_000
      ) { started.signal() }
    }
    await started.wait()
    await registry.cancelRequest("r")
    try await expectThrows("cancelled call") { _ = try await task.value } where: { error in
      error is CancellationError
    }
    try expectEqual(await registry.pendingCount, 0, "pending calls after cancel")
    // Late replies to a cancelled call are a no-op, not a crash.
    let late = await registry.resolve(callId: "c", result: "too late")
    try expect(!late, "a resolve after cancellation was accepted")
  }

  await harness.check("a tool round-trips through a scripted handler") {
    let registry = ToolCallRegistry()
    let requestId = "harness-tool-roundtrip"
    // Stands in for the JavaScript side: answer every tool call immediately.
    let log = EventLog { event in
      guard case let .toolCall(callId, _, _) = event else { return }
      Task { await registry.resolve(callId: callId, result: "It is 21C and sunny in Utrecht.") }
    }
    let request = try makeRequest(
      [(.user, "What is the weather in Utrecht? Use the tool, then answer in one sentence.")],
      tools: [weatherTool]
    )
    await GenerationEngine.stream(
      request, requestId: requestId, toolRegistry: registry, emit: log.emit)

    guard let finish = log.finish else {
      throw CheckFailure(message: "no finish event (error: \(String(describing: log.error)))")
    }
    try expect(!log.toolCalls.isEmpty, "the model never called the tool")
    let call = log.toolCalls[0]
    try expectEqual(call.toolName, "getWeather", "tool name")
    try expect(
      call.argumentsJson.contains("city"), "arguments did not carry a city: \(call.argumentsJson)")
    try expect(
      finish.text.lowercased().contains("21") || finish.text.lowercased().contains("sunny"),
      "the answer ignored the tool result: \(finish.text)")
    try expectEqual(await registry.pendingCount, 0, "pending tool calls after finish")
  }

  await harness.check("a handler that never answers times the request out") {
    let registry = ToolCallRegistry()
    let log = EventLog()  // nobody resolves anything
    let request = try makeRequest(
      [(.user, "What is the weather in Utrecht? Use the tool.")],
      tools: [weatherTool],
      toolCallTimeoutMs: 700
    )
    let start = Date()
    await GenerationEngine.stream(
      request, requestId: "harness-tool-timeout", toolRegistry: registry, emit: log.emit)
    let elapsed = Date().timeIntervalSince(start)

    try expect(!log.toolCalls.isEmpty, "the model never called the tool")
    guard let error = log.error else {
      throw CheckFailure(message: "a timed-out tool call produced no error event")
    }
    try expectEqual(error.code, "unknown", "error code")
    try expectEqual(error.transient, true, "transient flag")
    try expect(
      error.message.contains("did not answer"), "unexpected message: \(error.message)")
    try expect(elapsed < 30, "the request took \(elapsed)s — the timeout did not fire")
    try expectEqual(await registry.pendingCount, 0, "pending tool calls after the timeout")
  }

  await harness.check("cancelling during a tool call leaves nothing suspended") {
    let registry = ToolCallRegistry()
    let requestId = "harness-tool-cancel"
    let sawToolCall = AsyncSemaphore()
    let log = EventLog { event in
      if case .toolCall = event { sawToolCall.signal() }
    }
    let request = try makeRequest(
      [(.user, "What is the weather in Utrecht? Use the tool.")],
      tools: [weatherTool],
      toolCallTimeoutMs: 30_000
    )
    let task = Task {
      await GenerationEngine.stream(
        request, requestId: requestId, toolRegistry: registry, emit: log.emit)
    }
    await sawToolCall.wait()
    // Exactly what OnDeviceLlmModule.cancel does.
    await registry.cancelRequest(requestId)
    task.cancel()
    await task.value

    try expectEqual(await registry.pendingCount, 0, "pending tool calls after cancel")
    try expect(log.finish == nil, "a cancelled request still emitted finish")
    try expectEqual(log.error?.code, "cancelled", "error code")
    // The reply JavaScript may already have been sending when the cancel
    // landed. It must be ignored, not crash.
    let late = await registry.resolve(
      callId: log.toolCalls.first?.callId ?? "none", result: "late")
    try expect(!late, "a reply after cancellation was accepted")
  }
}

/// One-shot signal, so a check can wait for something that happens inside a
/// synchronous `@Sendable` callback without polling.
final class AsyncSemaphore: @unchecked Sendable {
  private let lock = NSLock()
  private var signalled = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func signal() {
    lock.lock()
    let pending = waiters
    waiters = []
    signalled = true
    lock.unlock()
    for waiter in pending { waiter.resume() }
  }

  func wait() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.lock()
      if signalled {
        lock.unlock()
        continuation.resume()
        return
      }
      waiters.append(continuation)
      lock.unlock()
    }
  }
}
