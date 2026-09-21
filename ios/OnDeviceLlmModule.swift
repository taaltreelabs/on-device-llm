//
//  OnDeviceLlmModule.swift
//  OnDeviceLlm
//
//  The only file in this module that imports ExpoModulesCore. Everything it
//  calls lives in `ios/Core`, is Expo-free, and is compiled unchanged by the
//  macOS verification harness against the real on-device model.
//
//  DECISIONS.md D16 records why this uses the classic definition DSL rather
//  than the macro-based Modules API 2.0.
//
//  Shape of the bridge:
//
//  - `availability()`  -> { available, reason?, detail? }
//  - `capabilities()`  -> { contextWindow, locales, modelLabel, supports* }
//  - `supportsLocale(tag)` -> Bool
//  - `prewarm(messages?)` -> Bool
//  - `countTokens(messages)` -> { ok: true, count } | { ok: false, error }
//  - `generate(requestId, messages, temperature?, maxOutputTokens?, schemaJson?)`
//        -> { ok: true, result } | { ok: false, error }
//  - `startStream(requestId, messages, temperature?, maxOutputTokens?,
//                 schemaJson?, tools, toolCallTimeoutMs?)` -> Void
//        every outcome arrives as an `onStreamEvent` event carrying `requestId`
//  - `resolveToolCall(callId, resultJson?, errorMessage?)` -> Bool
//        `false` means the call was no longer waiting (timed out, cancelled or
//        already answered) — a normal race, never an error
//  - `cancel(requestId)` -> Bool
//
//  Failures are *returned*, not thrown. Expo's exception channel carries a
//  code and a message; our taxonomy also carries `contextSize`/`tokenCount`,
//  `resetDate`, `locale` and the native domain/code (DECISIONS.md D9), and
//  losing those to fit the exception shape would defeat the whole point of
//  mapping errors natively. One result shape for both paths also means the
//  TypeScript side has exactly one error decoder.
//

import ExpoModulesCore
import FoundationModels

/// Name of the single event every streaming request multiplexes over.
/// Each payload carries its `requestId`, so concurrent streams never
/// interleave into the wrong consumer.
private let streamEventName = "onStreamEvent"

public class OnDeviceLlmModule: Module {
  private let registry = RequestRegistry()
  private let toolRegistry = ToolCallRegistry()

  public func definition() -> ModuleDefinition {
    Name("OnDeviceLlm")

    Events(streamEventName)

    // MARK: Step 1 — availability, capabilities, locales

    AsyncFunction("availability") { () -> [String: Any] in
      ModelInfo.availability()
    }

    AsyncFunction("capabilities") { () -> [String: Any] in
      ModelInfo.capabilities()
    }

    AsyncFunction("supportsLocale") { (tag: String) -> Bool in
      ModelInfo.supportsLocale(tag)
    }

    // MARK: Step 2 — generate (step 6 adds `schemaJson`)

    AsyncFunction("generate") {
      (
        requestId: String,
        messages: [[String: String]],
        temperature: Double?,
        maxOutputTokens: Int?,
        schemaJson: String?
      ) async -> [String: Any] in
      await self.runGenerate(
        requestId: requestId,
        messages: messages,
        temperature: temperature,
        maxOutputTokens: maxOutputTokens,
        schemaJson: schemaJson
      )
    }

    // MARK: Step 3 — stream + cancellation (steps 6 and 7 add schema and tools)

    AsyncFunction("startStream") {
      (
        requestId: String,
        messages: [[String: String]],
        temperature: Double?,
        maxOutputTokens: Int?,
        schemaJson: String?,
        tools: [[String: String]],
        toolCallTimeoutMs: Int?
      ) async in
      await self.startStream(
        requestId: requestId,
        messages: messages,
        temperature: temperature,
        maxOutputTokens: maxOutputTokens,
        schemaJson: schemaJson,
        tools: tools,
        toolCallTimeoutMs: toolCallTimeoutMs
      )
    }

    AsyncFunction("cancel") { (requestId: String) async -> Bool in
      // Both registries: cancelling the generation task alone would leave a
      // `BridgedTool.call` suspended on a continuation nobody will resume
      // (DECISIONS.md D25).
      await self.toolRegistry.cancelRequest(requestId)
      return await self.registry.cancel(requestId)
    }

    // MARK: Step 4 — prewarming

    AsyncFunction("prewarm") { (messages: [[String: String]]?) async -> Bool in
      do {
        let request =
          try messages.map {
            try BridgeRequest.parse(messages: $0, temperature: nil, maximumResponseTokens: nil)
          }
        try GenerationEngine.prewarm(request)
        return true
      } catch {
        // A hint that could not be delivered is not a failure worth throwing:
        // the caller has nothing to do about it and the next real request will
        // report the same problem properly.
        return false
      }
    }

    // MARK: Step 5 — token counting

    AsyncFunction("countTokens") { (messages: [[String: String]]) async -> [String: Any] in
      do {
        let request = try BridgeRequest.parse(
          messages: messages, temperature: nil, maximumResponseTokens: nil)
        let count = try await GenerationEngine.countTokens(request)
        return ["ok": true, "count": count]
      } catch {
        return ["ok": false, "error": mapNativeError(error).toDictionary()]
      }
    }

    // MARK: Step 7 — tool-call replies

    AsyncFunction("resolveToolCall") {
      (callId: String, resultJson: String?, errorMessage: String?) async -> Bool in
      if let errorMessage {
        return await self.toolRegistry.fail(callId: callId, message: errorMessage)
      }
      return await self.toolRegistry.resolve(callId: callId, result: resultJson ?? "")
    }

    OnDestroy {
      // A JS reload tears the module down while generations may still be
      // running. Nothing is listening for their events any more, so stop them
      // rather than leave the neural engine busy.
      let registry = self.registry
      Task { await registry.cancelAll() }
    }
  }

  // MARK: - Implementation

  private func runGenerate(
    requestId: String,
    messages: [[String: String]],
    temperature: Double?,
    maxOutputTokens: Int?,
    schemaJson: String?
  ) async -> [String: Any] {
    let request: BridgeRequest
    do {
      request = try BridgeRequest.parse(
        messages: messages,
        temperature: temperature,
        maximumResponseTokens: maxOutputTokens,
        schemaJson: schemaJson
      )
    } catch {
      return ["ok": false, "error": mapNativeError(error).toDictionary()]
    }

    // Registered before the first suspension point inside the task so a
    // `cancel()` arriving immediately after this call still finds a handle.
    let task = Task { try await GenerationEngine.generate(request) }
    await registry.register(requestId) { task.cancel() }
    defer { Task { [registry] in await registry.finish(requestId) } }

    do {
      let result = try await task.value
      return ["ok": true, "result": result.toDictionary()]
    } catch {
      if task.isCancelled || error is CancellationError {
        return [
          "ok": false,
          "error": BridgeErrorPayload(code: "cancelled", message: "The request was cancelled")
            .toDictionary(),
        ]
      }
      return ["ok": false, "error": mapNativeError(error).toDictionary()]
    }
  }

  private func startStream(
    requestId: String,
    messages: [[String: String]],
    temperature: Double?,
    maxOutputTokens: Int?,
    schemaJson: String?,
    tools: [[String: String]],
    toolCallTimeoutMs: Int?
  ) async {
    let request: BridgeRequest
    do {
      request = try BridgeRequest.parse(
        messages: messages,
        temperature: temperature,
        maximumResponseTokens: maxOutputTokens,
        schemaJson: schemaJson,
        tools: tools,
        toolCallTimeoutMs: toolCallTimeoutMs
      )
    } catch {
      // Emitted, not thrown: the TypeScript generator has subscribed by now
      // and has exactly one place that turns an event into an `LLMError`.
      send(.error(mapNativeError(error)), requestId: requestId)
      return
    }

    let emit: @Sendable (BridgeStreamEvent) -> Void = { [weak self] event in
      self?.send(event, requestId: requestId)
    }

    let task = Task { [toolRegistry] in
      await GenerationEngine.stream(
        request, requestId: requestId, toolRegistry: toolRegistry, emit: emit)
    }
    await registry.register(requestId) { [toolRegistry] in
      task.cancel()
      // A tool call in flight is suspended on a continuation, and cancelling
      // the task does not resume it (DECISIONS.md D25).
      Task { await toolRegistry.cancelRequest(requestId) }
    }

    // `startStream` deliberately does not await the task: it resolves as soon
    // as the request is registered, so JavaScript can start consuming events
    // (and can cancel) while generation is still running.
    Task { [registry, toolRegistry] in
      _ = await task.result
      await registry.finish(requestId)
      await toolRegistry.finishRequest(requestId)
    }
  }

  private func send(_ event: BridgeStreamEvent, requestId: String) {
    sendEvent(streamEventName, event.toDictionary(requestId: requestId))
  }
}
