//
//  BaselineChecks.swift
//  Runner
//
//  Phase 3 steps 1-3, which are already verified on a physical device. They run
//  here as a regression guard: steps 4-7 change `TranscriptBuilder`,
//  `GenerationEngine` and the event enum, and this is what notices if one of
//  them quietly breaks plain text generation.
//

import Foundation
import FoundationModels

func runBaselineChecks(_ harness: Harness) async {
  await harness.section("baseline (steps 1-3)")

  await harness.check("availability reports available") {
    let info = ModelInfo.availability()
    try expect(info["available"] as? Bool == true, "availability() said \(info)")
  }

  await harness.check("capabilities report a context window and locales") {
    let caps = ModelInfo.capabilities()
    let window = caps["contextWindow"] as? Int ?? 0
    let locales = caps["locales"] as? [String] ?? []
    try expect(window > 0, "contextWindow was \(window)")
    try expect(!locales.isEmpty, "locales was empty")
    try expect(caps["supportsToolCalling"] as? Bool == true, "the model reports no tool calling")
    try expect(
      caps["supportsGuidedGeneration"] as? Bool == true, "the model reports no guided generation")
  }

  await harness.check("generate answers a one-turn request") {
    let request = try makeRequest([(.user, "Reply with exactly: OK")])
    let result = try await GenerationEngine.generate(request)
    try expect(!result.text.isEmpty, "the model returned no text")
    try expectEqual(result.finishReason, "stop", "finishReason")
  }

  await harness.check("stream deltas concatenate to the final text") {
    let log = EventLog()
    let request = try makeRequest([(.user, "List three colours, one per line.")])
    await GenerationEngine.stream(request, emit: log.emit)
    guard let finish = log.finish else {
      throw CheckFailure(message: "no finish event (error: \(String(describing: log.error)))")
    }
    let concatenated = log.deltas.joined()
    try expectEqual(concatenated, finish.text, "concatenated deltas vs finish.text")
    let resets = log.all.filter { if case .delta(_, true) = $0 { return true } else { return false } }
    try expect(resets.isEmpty, "\(resets.count) snapshot resets (D18 fallback fired)")
  }

  await harness.check("cancelling a stream reports cancelled, not finish") {
    let log = EventLog()
    let request = try makeRequest([(.user, "Write a 500 word essay about the sea.")])
    let task = Task { await GenerationEngine.stream(request, emit: log.emit) }
    // Long enough that generation is really under way, short enough that it
    // cannot have finished.
    try await Task.sleep(for: .milliseconds(400))
    task.cancel()
    await task.value
    try expect(log.finish == nil, "a cancelled stream still emitted finish")
    try expectEqual(log.error?.code, "cancelled", "error code")
  }
}
