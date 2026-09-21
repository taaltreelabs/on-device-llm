//
//  TranscriptBuilder.swift
//  OnDeviceLlm
//
//  Turns the stateless, message-based request (docs/plan.md §2) into the two
//  things FoundationModels wants: a `Transcript` of completed turns, and the
//  one prompt to respond to.
//

import Foundation
import FoundationModels

/// Everything one request needs to build a session and call it.
struct PreparedRequest: Sendable {
  /// History. Does **not** contain the message being answered — see D17 below.
  let transcript: Transcript
  /// The final user message, passed to `respond`/`streamResponse`.
  let prompt: String
  let options: GenerationOptions
}

enum TranscriptBuilder {
  /// Marker prefix the context manager puts on rolling summaries
  /// (DECISIONS.md D13). Only used to keep the instructions readable.
  static let summaryMarker = "[summary of earlier conversation]"

  /// Build the session inputs for one request.
  ///
  /// **DECISIONS.md D17 — where the last user message goes.**
  /// `LanguageModelSession(model:tools:transcript:)` seeds a session with
  /// *completed* turns; `respond(to:)` appends a new `.prompt` entry and
  /// generates a `.response` for it. So the two are not interchangeable:
  ///
  /// - Putting the final user message in *both* the transcript and the prompt
  ///   duplicates it — the model sees the question asked twice, and the turn's
  ///   `transcriptEntries` no longer match the conversation.
  /// - Putting it in the transcript only and calling `respond(to: "")` asks
  ///   the framework to generate from an empty prompt entry, which is not a
  ///   shape the API documents and produces a transcript with a stray empty
  ///   prompt.
  ///
  /// The request therefore splits: everything up to but not including the
  /// trailing user message becomes the transcript, and that trailing message
  /// is the prompt. A request that does not end in a user message has no
  /// prompt to send and is rejected as `invalidRequest` (the framework has no
  /// "continue your own last message" affordance). TypeScript performs the
  /// same check before crossing the bridge; this is the backstop.
  ///
  /// **System messages.** `Transcript.Instructions` must be the first entry
  /// and there is exactly one of it (docs/research/sdk-surface.md §6). A JS
  /// conversation can carry system messages anywhere — the Phase 2 rolling
  /// summary is a non-pinned `system` message sitting in front of the retained
  /// turns (D13). All of them are therefore concatenated, in their original
  /// order, into that single instructions entry. Relative order among system
  /// messages is preserved; their position *between* turns is not, because the
  /// transcript has no way to express it. In practice the context manager
  /// emits them at the head anyway.
  static func prepare(_ request: BridgeRequest) throws -> PreparedRequest {
    let systemMessages = request.messages.filter { $0.role == .system }
    let turnMessages = request.messages.filter { $0.role != .system }

    guard let last = turnMessages.last else {
      throw BridgeError.invalidRequest(
        "The request contains no user message to respond to.")
    }
    guard last.role == .user else {
      throw BridgeError.invalidRequest(
        "The Apple provider requires the conversation to end with a user message; "
          + "this one ends with an assistant message.")
    }

    var entries: [Transcript.Entry] = []

    let instructions = systemMessages
      .map(\.content)
      .filter { !$0.isEmpty }
      .joined(separator: "\n\n")
    if !instructions.isEmpty {
      entries.append(
        .instructions(
          Transcript.Instructions(
            segments: [.text(Transcript.TextSegment(content: instructions))],
            toolDefinitions: []
          )))
    }

    for message in turnMessages.dropLast() {
      switch message.role {
      case .user:
        entries.append(
          .prompt(
            Transcript.Prompt(segments: [.text(Transcript.TextSegment(content: message.content))])))
      case .assistant:
        entries.append(
          .response(
            Transcript.Response(
              assetIDs: [],
              segments: [.text(Transcript.TextSegment(content: message.content))]
            )))
      case .system:
        // Unreachable: filtered out above. Listed so a new role is a compile
        // error here rather than a silently dropped message.
        continue
      }
    }

    return PreparedRequest(
      transcript: Transcript(entries: entries),
      prompt: last.content,
      options: generationOptions(from: request.options)
    )
  }

  /// `BridgeGenerationOptions` -> `GenerationOptions`.
  ///
  /// `samplingMode` is left `nil` (framework default). Only the two fields the
  /// frozen `GenerateRequest` carries are mapped; the rest of the option
  /// surface is rejected in TypeScript rather than silently ignored here.
  static func generationOptions(from options: BridgeGenerationOptions) -> GenerationOptions {
    GenerationOptions(
      samplingMode: nil,
      temperature: options.temperature,
      maximumResponseTokens: options.maximumResponseTokens
    )
  }
}
