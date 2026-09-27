//
//  OnDeviceLlmModule.swift
//  OnDeviceLlm
//
//  The only file in this module that imports ExpoModulesCore. Everything it
//  calls lives in `ios/Core`, is Expo-free, and is compiled unchanged by the
//  macOS verification harness against the real on-device model.
//
//  This uses the classic definition DSL rather
//  than the macro-based Modules API 2.0.
//
//  Shape of the bridge:
//
//  - `availability()`  -> { available, reason?, detail? }
//  - `capabilities()`  -> { contextWindow, locales, modelLabel, supports*,
//                           tokenCounting: "exact" | "estimated",
//                           usageReporting: Bool }
//        every key is present on every OS; the iOS 27-only ones fall back to
//        fixed values on iOS 26 (ios/Core/ModelInfo.swift)
//  - `supportsLocale(tag)` -> Bool
//  - `prewarm(messages?)` -> Bool
//  - `countTokens(messages)` -> { ok: true, count } | { ok: false, error }
//        `error.code == "invalidRequest"` below iOS 26.4, where the framework
//        has no token counter (`capabilities().tokenCounting == "estimated"`)
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
//  `resetDate`, `locale` and the native domain/code, and
//  losing those to fit the exception shape would defeat the whole point of
//  mapping errors natively. One result shape for both paths also means the
//  TypeScript side has exactly one error decoder.
//
//  Platform floor: iOS 16.4, ExpoModulesCore's own (ios/OnDeviceLlm.podspec),
//  so that autolinking does not silently drop this module from an app that
//  still supports iOS older than 26. FoundationModels is
//  iOS 26.0 and weak-linked. This class is the one declaration that cannot be
//  `@available(iOS 26.0, *)`, because Expo instantiates it on every OS, so
//  every `AsyncFunction` body starts with `guard #available(iOS 26.0, *)` and
//  answers from `UnsupportedPlatform` below it, in the same shapes as above:
//  `availability()` reports `unavailable` / `unsupportedPlatform`, the result
//  functions return that as an `unavailable` error, and the Bool functions
//  return `false`. Nothing below the guard runs on older iOS, so no
//  FoundationModels symbol is ever touched there. Everything in `ios/Core`
//  that names a FoundationModels type is `@available(iOS 26.0, *)` and gates
//  its newer API (26.4 token counting, iOS 27 usage/variant/capabilities and
//  error types) internally. See docs/research/ios26-compat.md.
//

import ExpoModulesCore
import FoundationModels

/// Name of the single event every streaming request multiplexes over.
/// Each payload carries its `requestId`, so concurrent streams never
/// interleave into the wrong consumer.
private let streamEventName = "onStreamEvent"

/// Every answer this module gives on iOS older than 26, where FoundationModels
/// does not exist. Same shapes as the real answers, so the TypeScript side
/// needs no second decoder: `src/apple/errors.ts` already accepts
/// `unsupportedPlatform` as an unavailable reason, and the router falls
/// through past it to the next provider exactly as it does on Android.
private enum UnsupportedPlatform {
  static let detail =
    "Apple FoundationModels needs iOS 26 or later; this device runs an older iOS."

  // Computed rather than stored: `[String: Any]` is not `Sendable`, so a
  // stored static would not pass Swift 6's global-state checks.
  static var availability: [String: Any] {
    ["available": false, "reason": "unsupportedPlatform", "detail": detail]
  }

  /// Every key `ModelInfo.capabilities` reports, with inert values. A
  /// `contextWindow` of `0` is the documented "unknown", and nothing
  /// here claims a feature the device cannot run.
  static var capabilities: [String: Any] {
    [
      "contextWindow": 0,
      "locales": [String](),
      "modelLabel": "Apple Foundation Model",
      "supportsVision": false,
      "supportsGuidedGeneration": false,
      "supportsToolCalling": false,
      "supportsReasoning": false,
      "tokenCounting": "estimated",
      "usageReporting": false,
    ]
  }

  static var error: BridgeErrorPayload {
    var payload = BridgeErrorPayload(code: "unavailable", message: detail)
    payload.reason = "unsupportedPlatform"
    return payload
  }

  /// The `{ ok: false, error }` result of `countTokens` and `generate`.
  static var failure: [String: Any] {
    ["ok": false, "error": error.toDictionary()]
  }
}

public class OnDeviceLlmModule: Module {
  // Neither registry names a FoundationModels type, so both are safe to
  // create on any iOS; below 26 they simply stay empty.
  private let registry = RequestRegistry()
  private let toolRegistry = ToolCallRegistry()

  public func definition() -> ModuleDefinition {
    Name("OnDeviceLlm")

    Events(streamEventName)

    // MARK: Step 1 — availability, capabilities, locales

    // Every body below opens with the same `guard #available`. It cannot be
    // folded into a shared wrapper: availability refinement is lexical, so a
    // closure passed to a helper would still be compiled for iOS 16.4 and
    // could not name `ios/Core`. The fallback values live in one place,
    // `UnsupportedPlatform`.

    AsyncFunction("availability") { () -> [String: Any] in
      guard #available(iOS 26.0, *) else { return UnsupportedPlatform.availability }
      return ModelInfo.availability()
    }

    AsyncFunction("capabilities") { () -> [String: Any] in
      guard #available(iOS 26.0, *) else { return UnsupportedPlatform.capabilities }
      return ModelInfo.capabilities()
    }

    AsyncFunction("supportsLocale") { (tag: String) -> Bool in
      guard #available(iOS 26.0, *) else { return false }
      return ModelInfo.supportsLocale(tag)
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
      guard #available(iOS 26.0, *) else { return UnsupportedPlatform.failure }
      return await self.runGenerate(
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
      guard #available(iOS 26.0, *) else {
        // Emitted, like every other stream outcome: the TypeScript generator
        // has subscribed by now and turns this into the same `LLMError` a
        // parse failure would produce.
        self.send(.error(UnsupportedPlatform.error), requestId: requestId)
        return
      }
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
      // Nothing is ever registered below iOS 26, so this is the answer the
      // registries would give anyway; the guard keeps every entry point alike.
      guard #available(iOS 26.0, *) else { return false }
      // Both registries: cancelling the generation task alone would leave a
      // `BridgedTool.call` suspended on a continuation nobody will resume.
      await self.toolRegistry.cancelRequest(requestId)
      return await self.registry.cancel(requestId)
    }

    // MARK: Step 4 — prewarming

    AsyncFunction("prewarm") { (messages: [[String: String]]?) async -> Bool in
      guard #available(iOS 26.0, *) else { return false }
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
      guard #available(iOS 26.0, *) else { return UnsupportedPlatform.failure }
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
      guard #available(iOS 26.0, *) else { return false }
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

  @available(iOS 26.0, *)
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

  @available(iOS 26.0, *)
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
      // the task does not resume it.
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
