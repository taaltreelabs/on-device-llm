//
//  GenerationEngine.swift
//  OnDeviceLlm
//
//  `generate` and `stream` over FoundationModels — Phase 3 steps 2 and 3.
//
//  A fresh `LanguageModelSession` per request (docs/plan.md §2, DECISIONS.md
//  D2). The provider interface is stateless and message-based; the context
//  manager and the router own the conversation. Rebuilding is simple and
//  correct, and it makes the framework's "one request per session at a time"
//  problem disappear rather than needing to be managed. iOS 27's mutable
//  `Transcript.history` is the later optimisation (sdk-surface.md §2), not
//  this.
//

import Foundation
import FoundationModels

enum GenerationEngine {
  // MARK: - Non-streaming

  /// One-shot generation. Throws a `BridgeError`-shaped failure only through
  /// `mapNativeError`; callers convert to a payload rather than propagating
  /// Swift errors across the bridge.
  static func generate(_ request: BridgeRequest) async throws -> BridgeResult {
    let prepared = try TranscriptBuilder.prepare(request)
    let session = LanguageModelSession(
      model: SystemLanguageModel.default,
      transcript: prepared.transcript
    )
    let response = try await session.respond(to: prepared.prompt, options: prepared.options)
    // Same reason as in `stream` below: the framework does not reliably turn a
    // cancelled task into a thrown `CancellationError`, and a cancelled
    // request must never come back looking like a successful one.
    try Task.checkCancellation()
    let usage = mapUsage(response.usage)
    return BridgeResult(
      text: response.content,
      finishReason: finishReason(usage: usage, options: request.options),
      usage: usage
    )
  }

  // MARK: - Streaming

  /// Stream one request, calling `emit` once per event.
  ///
  /// Never throws: every outcome — including cancellation and every framework
  /// failure — is delivered as a `.finish` or `.error` event. A stream that
  /// half-delivers and then rejects a promise is the shape that leaves JS
  /// consumers hanging, so the bridge does not have that shape at all.
  ///
  /// Exactly one terminal event (`.finish` or `.error`) is emitted.
  static func stream(
    _ request: BridgeRequest,
    emit: @Sendable (BridgeStreamEvent) -> Void
  ) async {
    let prepared: PreparedRequest
    do {
      prepared = try TranscriptBuilder.prepare(request)
    } catch {
      emit(.error(mapNativeError(error)))
      return
    }

    let session = LanguageModelSession(
      model: SystemLanguageModel.default,
      transcript: prepared.transcript
    )

    var differ = SnapshotDiffer()
    var usage = BridgeUsage()

    do {
      let responseStream = session.streamResponse(
        to: prepared.prompt, options: prepared.options)
      for try await snapshot in responseStream {
        // `Task.cancel()` is the only cancellation mechanism the framework
        // offers — there is no `stop()` on the session (sdk-surface.md §3).
        // The `for try await` throws `CancellationError` on its own, but
        // checking here too means a cancel that lands between snapshots stops
        // us without waiting for the next one.
        try Task.checkCancellation()
        usage = mapUsage(snapshot.usage)
        if let delta = differ.delta(for: snapshot.content) {
          emit(.delta(delta.text, reset: delta.reset))
        }
      }
      // Measured against the live model (macOS verification harness): a
      // cancelled `ResponseStream` does **not** throw `CancellationError` —
      // the sequence simply ends, and without this check the request would
      // report a perfectly ordinary `finish` for a generation the caller
      // stopped. `finishReason: 'cancelled'` would be equally wrong: the
      // provider contract says an abort surfaces as an `LLMError` with code
      // `cancelled`, not as a successful result.
      try Task.checkCancellation()
      // `differ.emitted` is the last snapshot: authoritative, and the value a
      // consumer should trust over its own concatenation (D18).
      emit(
        .finish(
          BridgeResult(
            text: differ.emitted,
            finishReason: finishReason(usage: usage, options: request.options),
            usage: usage
          )))
    } catch {
      if Task.isCancelled || error is CancellationError {
        emit(.error(BridgeErrorPayload(code: "cancelled", message: "The request was cancelled")))
      } else {
        emit(.error(mapNativeError(error)))
      }
    }
  }

  // MARK: - Mapping helpers

  static func mapUsage(_ usage: LanguageModelSession.Usage) -> BridgeUsage {
    BridgeUsage(
      inputTokens: usage.input.totalTokenCount,
      outputTokens: usage.output.totalTokenCount,
      cachedInputTokens: usage.input.cachedTokenCount,
      reasoningTokens: usage.output.reasoningTokenCount
    )
  }

  /// The framework does not report why generation stopped, so this is
  /// inferred: hitting `maximumResponseTokens` exactly is `length`, anything
  /// else is `stop`. Guardrail and refusal outcomes arrive as thrown errors,
  /// not as a finish reason, and `cancelled` is emitted from the catch above.
  static func finishReason(usage: BridgeUsage, options: BridgeGenerationOptions) -> String {
    if let limit = options.maximumResponseTokens,
      let produced = usage.outputTokens,
      produced >= limit
    {
      return "length"
    }
    return "stop"
  }
}
