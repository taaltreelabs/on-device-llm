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
//  - `generate(requestId, messages, temperature?, maxOutputTokens?)`
//        -> { ok: true, result } | { ok: false, error }
//  - `startStream(requestId, messages, temperature?, maxOutputTokens?)` -> Void
//        every outcome arrives as an `onStreamEvent` event carrying `requestId`
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

    // MARK: Step 2 — generate

    AsyncFunction("generate") {
      (
        requestId: String,
        messages: [[String: String]],
        temperature: Double?,
        maxOutputTokens: Int?
      ) async -> [String: Any] in
      await self.runGenerate(
        requestId: requestId,
        messages: messages,
        temperature: temperature,
        maxOutputTokens: maxOutputTokens
      )
    }

    // MARK: Step 3 — stream + cancellation

    AsyncFunction("startStream") {
      (
        requestId: String,
        messages: [[String: String]],
        temperature: Double?,
        maxOutputTokens: Int?
      ) async in
      await self.startStream(
        requestId: requestId,
        messages: messages,
        temperature: temperature,
        maxOutputTokens: maxOutputTokens
      )
    }

    AsyncFunction("cancel") { (requestId: String) async -> Bool in
      await self.registry.cancel(requestId)
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
    maxOutputTokens: Int?
  ) async -> [String: Any] {
    let request: BridgeRequest
    do {
      request = try BridgeRequest.parse(
        messages: messages,
        temperature: temperature,
        maximumResponseTokens: maxOutputTokens
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
    maxOutputTokens: Int?
  ) async {
    let request: BridgeRequest
    do {
      request = try BridgeRequest.parse(
        messages: messages,
        temperature: temperature,
        maximumResponseTokens: maxOutputTokens
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

    let task = Task {
      await GenerationEngine.stream(request, emit: emit)
    }
    await registry.register(requestId) { task.cancel() }

    // `startStream` deliberately does not await the task: it resolves as soon
    // as the request is registered, so JavaScript can start consuming events
    // (and can cancel) while generation is still running.
    Task { [registry] in
      _ = await task.result
      await registry.finish(requestId)
    }
  }

  private func send(_ event: BridgeStreamEvent, requestId: String) {
    sendEvent(streamEventName, event.toDictionary(requestId: requestId))
  }
}
