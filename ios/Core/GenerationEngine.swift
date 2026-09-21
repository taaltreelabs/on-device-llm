//
//  GenerationEngine.swift
//  OnDeviceLlm
//
//  `generate`, `stream`, `prewarm` and `countTokens` over FoundationModels —
//  Phase 3 steps 2-7.
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
    guard request.tools.isEmpty else {
      // Tool calling needs an event channel to reach JavaScript mid-generation,
      // and `generate` has none — it is one promise. The TypeScript provider
      // therefore routes a request carrying tools through `stream` and
      // collapses the events into a `GenerateResult` (DECISIONS.md D24). This
      // is the backstop for a hand-rolled caller.
      throw BridgeError.invalidRequest(
        "Tool calling requires the streaming path; call startStream instead of generate.")
    }
    let prepared = try TranscriptBuilder.prepare(request)
    let session = LanguageModelSession(
      model: SystemLanguageModel.default,
      transcript: prepared.transcript
    )

    if let schemaJson = request.schemaJson {
      let schema = try SchemaCodec.decode(schemaJson, label: "The response schema")
      let response = try await session.respond(
        to: prepared.prompt, schema: schema, includeSchemaInPrompt: true,
        options: prepared.options)
      try Task.checkCancellation()
      let usage = mapUsage(response.usage)
      let json = SchemaCodec.json(from: response.content)
      // `text` carries the same JSON as `objectJson`. A structured response has
      // no prose half, and leaving `text` empty would make every consumer that
      // renders `result.text` show nothing at all.
      return BridgeResult(
        text: json,
        finishReason: finishReason(usage: usage, options: request.options),
        usage: usage,
        objectJson: json
      )
    }

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

  // MARK: - Prewarming (step 4)

  /// Ask the framework to load what it needs before a request arrives.
  ///
  /// A **hint, not a contract** (docs/plan.md §5): `prewarm(promptPrefix:)`
  /// returns immediately, reports nothing, and the framework is free to ignore
  /// it. Apple's own guidance is to call it only when at least a second will
  /// pass before `respond`. We expose it because the asset load it triggers is
  /// the expensive part of a first request, and because a caller that knows a
  /// question is coming (a chat screen opening) has information the framework
  /// does not.
  ///
  /// `messages` is optional and tolerant: unlike a real request it does not
  /// have to end with a user message, since prewarming a conversation that is
  /// still being typed is exactly the case this is for.
  static func prewarm(_ request: BridgeRequest?) throws {
    guard let request else {
      LanguageModelSession(model: SystemLanguageModel.default).prewarm()
      return
    }
    let prepared = try TranscriptBuilder.prepare(request, requirePrompt: false)
    let session = LanguageModelSession(
      model: SystemLanguageModel.default,
      transcript: prepared.transcript
    )
    if prepared.prompt.isEmpty {
      session.prewarm()
    } else {
      session.prewarm(promptPrefix: Prompt(prepared.prompt))
    }
  }

  // MARK: - Token counting (step 5)

  /// Exact token count for the request these messages would produce.
  ///
  /// Counts the *same* transcript and prompt the request would send
  /// (DECISIONS.md D17's split), so the number lines up with what the model
  /// will actually see rather than with a serialisation of the message list.
  /// `tokenCount(for:)` is iOS/macOS 26.4+, comfortably inside the iOS 27 floor
  /// (D4), and it lives on `SystemLanguageModel`, not on the session — so no
  /// session is built here at all.
  ///
  /// Throws rather than guessing (D9: these overloads have been observed
  /// throwing `ModelManagerError 1013` on a live, "available" machine). The
  /// context manager's `createMeasure` falls back to the estimator and widens
  /// its safety margin when that happens; a silent guess here would take that
  /// choice away from it.
  static func countTokens(_ request: BridgeRequest) async throws -> Int {
    let prepared = try TranscriptBuilder.prepare(request, requirePrompt: false)
    let model = SystemLanguageModel.default

    var total = 0
    let entries = Array(prepared.transcript)
    if !entries.isEmpty {
      total += try await model.tokenCount(for: entries)
    }
    if !prepared.prompt.isEmpty {
      total += try await model.tokenCount(for: Prompt(prepared.prompt))
    }
    if let schemaJson = request.schemaJson {
      total += try await model.tokenCount(
        for: try SchemaCodec.decode(schemaJson, label: "The response schema"))
    }
    if !request.tools.isEmpty {
      // Tool declarations are prompt text too, and a caller budgeting a
      // request with tools wants them in the number.
      let tools = try BridgedTool.build(
        from: request.tools,
        requestId: "token-count",
        timeoutMs: request.toolCallTimeoutMs,
        registry: ToolCallRegistry(),
        emit: { _ in }
      )
      total += try await model.tokenCount(for: tools)
    }
    return total
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
    requestId: String = "",
    toolRegistry: ToolCallRegistry? = nil,
    emit: @escaping @Sendable (BridgeStreamEvent) -> Void
  ) async {
    let prepared: PreparedRequest
    let session: LanguageModelSession
    do {
      prepared = try TranscriptBuilder.prepare(request)
      let tools: [any Tool] =
        request.tools.isEmpty
        ? []
        : try BridgedTool.build(
          from: request.tools,
          requestId: requestId,
          timeoutMs: request.toolCallTimeoutMs,
          registry: toolRegistry ?? ToolCallRegistry(),
          emit: emit
        )
      session = LanguageModelSession(
        model: SystemLanguageModel.default,
        tools: tools,
        transcript: prepared.transcript
      )
    } catch {
      emit(.error(mapNativeError(error)))
      return
    }

    if let schemaJson = request.schemaJson {
      await streamStructured(
        request, schemaJson: schemaJson, session: session, prepared: prepared, emit: emit)
      return
    }

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

  /// The structured half of `stream`: `ResponseStream<GeneratedContent>`.
  ///
  /// Object snapshots rather than text deltas, for the reason `ObjectSnapshot`
  /// gives in `src/core/stream.ts`: an object firms up by having fields filled
  /// in, so there is no well-defined delta to send. Each snapshot is forwarded
  /// as JSON text — `GeneratedContent`'s `jsonString` is defined for partial
  /// content, so JavaScript can render a half-built object without waiting for
  /// a parseable document (docs/research/sdk-surface.md §7).
  private static func streamStructured(
    _ request: BridgeRequest,
    schemaJson: String,
    session: LanguageModelSession,
    prepared: PreparedRequest,
    emit: @Sendable (BridgeStreamEvent) -> Void
  ) async {
    let schema: GenerationSchema
    do {
      schema = try SchemaCodec.decode(schemaJson, label: "The response schema")
    } catch {
      emit(.error(mapNativeError(error)))
      return
    }

    var usage = BridgeUsage()
    var latestJson = ""

    do {
      let responseStream = session.streamResponse(
        to: prepared.prompt, schema: schema, includeSchemaInPrompt: true,
        options: prepared.options)
      for try await snapshot in responseStream {
        try Task.checkCancellation()
        usage = mapUsage(snapshot.usage)
        let json = SchemaCodec.json(from: snapshot.rawContent)
        // Identical snapshots are common while a long string field fills in;
        // forwarding them would cost a bridge hop and a re-render for no new
        // information.
        if json != latestJson {
          latestJson = json
          emit(.objectSnapshot(json))
        }
      }
      // D21 again: a cancelled `ResponseStream` ends rather than throwing.
      try Task.checkCancellation()
      emit(
        .finish(
          BridgeResult(
            text: latestJson,
            finishReason: finishReason(usage: usage, options: request.options),
            usage: usage,
            objectJson: latestJson
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
