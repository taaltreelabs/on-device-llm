//
//  PrewarmAndTokenChecks.swift
//  Runner
//
//  Phase 3 steps 4 and 5.
//
//  What is *not* checked here, deliberately: that prewarming makes anything
//  faster. `prewarm` returns immediately, reports nothing, and the framework is
//  free to ignore it; a timing assertion against a shared machine would be a
//  flaky test dressed up as evidence. What can be checked is that prewarming is
//  harmless and that a prewarmed conversation still generates — which is the
//  contract we actually make.
//

import Foundation
import FoundationModels

func runPrewarmChecks(_ harness: Harness) async {
  await harness.section("prewarm (step 4)")

  await harness.check("prewarm with no messages, then generate") {
    try GenerationEngine.prewarm(nil)
    let result = try await GenerationEngine.generate(
      try makeRequest([(.user, "Reply with exactly: OK")]))
    try expect(!result.text.isEmpty, "the model returned no text after prewarming")
  }

  await harness.check("prewarm with a conversation prefix, then generate it") {
    let messages: [(BridgeRole, String)] = [
      (.system, "You are terse."),
      (.user, "What is the capital of France?"),
    ]
    try GenerationEngine.prewarm(try makeRequest(messages))
    let result = try await GenerationEngine.generate(try makeRequest(messages))
    try expect(
      result.text.lowercased().contains("paris"), "expected Paris, got: \(result.text)")
  }

  await harness.check("prewarm tolerates a history that ends with an assistant turn") {
    // The case prewarming is *for*: a chat screen opening on an existing
    // conversation, before the user has typed the next question.
    try GenerationEngine.prewarm(
      try makeRequest([
        (.user, "Hello"),
        (.assistant, "Hi! How can I help?"),
      ]))
  }
}

func runTokenCountChecks(_ harness: Harness) async {
  await harness.section("token counting (step 5)")

  let short: [(BridgeRole, String)] = [(.user, "What is the capital of France?")]
  let longer: [(BridgeRole, String)] = short + [
    (.assistant, "Paris."),
    (.user, "And of Spain? Answer in one word, then explain your reasoning in detail."),
  ]

  await harness.check("counts a known transcript as a positive integer") {
    let count = try await GenerationEngine.countTokens(try makeRequest(short))
    try expect(count > 0, "count was \(count)")
    try expect(count < 100, "a seven-word question counted as \(count) tokens")
  }

  await harness.check("the same messages count the same twice") {
    let first = try await GenerationEngine.countTokens(try makeRequest(short))
    let second = try await GenerationEngine.countTokens(try makeRequest(short))
    try expectEqual(first, second, "repeat count")
  }

  await harness.check("count(A + B) >= count(A)") {
    let a = try await GenerationEngine.countTokens(try makeRequest(short))
    let ab = try await GenerationEngine.countTokens(try makeRequest(longer))
    try expect(ab >= a, "count(A+B) = \(ab) < count(A) = \(a)")
  }

  await harness.check("instructions are counted too") {
    let withSystem: [(BridgeRole, String)] =
      [(.system, "You are a helpful assistant that answers in Dutch.")] + short
    let bare = try await GenerationEngine.countTokens(try makeRequest(short))
    let instructed = try await GenerationEngine.countTokens(try makeRequest(withSystem))
    try expect(instructed > bare, "system message added \(instructed - bare) tokens")
  }

  await harness.check("counting a schema-carrying request includes the schema") {
    let bare = try await GenerationEngine.countTokens(try makeRequest(short))
    let withSchema = try await GenerationEngine.countTokens(
      try makeRequest(short, schemaJson: SchemaFixtures.person))
    try expect(withSchema > bare, "schema added \(withSchema - bare) tokens")
  }
}
