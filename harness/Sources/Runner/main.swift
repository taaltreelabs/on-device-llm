//
//  main.swift
//  Runner
//
//  Entry point for `npm run harness:apple`.
//
//  Exits 0 when every check passes *or* when this machine has no usable model
//  (a CI Mac, a machine with Apple Intelligence turned off): a harness that
//  fails the build for a missing model would make the gate useless everywhere
//  but the maintainer's desk. It says which of the two happened, loudly.
//
//  `swift run Runner <group>…` runs only the named groups
//  (baseline, compat, prewarm, tokens, schema, constraints, tools).
//

import Foundation
import FoundationModels

let requestedGroups = Set(CommandLine.arguments.dropFirst().map { $0.lowercased() })
func wants(_ group: String) -> Bool {
  requestedGroups.isEmpty || requestedGroups.contains(group)
}

print("on-device-llm — Apple verification harness")
print("macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")

guard modelIsUsable() else {
  print(
    """

    SKIPPED: the system language model is not available on this machine.
    (availability = \(SystemLanguageModel.default.availability))

    This is the expected outcome on CI Macs and on machines without Apple
    Intelligence enabled. Nothing was verified; run this on a development Mac
    with the model downloaded before trusting a change to ios/Core.
    """)
  exit(0)
}

// Through `ModelInfo` rather than `variant.displayName` directly: `variant` is
// macOS 27 API and this package targets macOS 26.0 (the iOS 26 floor), and the
// label `capabilities()` reports is the one worth seeing anyway.
print("model: \(ModelInfo.capabilities()["modelLabel"] as? String ?? "?")")

// Observed model-stack failure: `availability` reports `.available`
// while every generation fails with `com.apple.SensitiveContentAnalysisML
// error 15` wrapping `ModelManagerError 1013`, `contextSize` reads 0, and the
// variant quietly downgrades. Apple's own `fm` CLI fails identically, so it is
// the machine's model assets, not this code — but the availability check alone
// cannot tell the two apart, so a generation probe is needed.
//
// Without this preflight the run reports ~28 failures that say nothing about
// the change under test, and a real regression would be invisible among them.
if let blocker = await preflightFailure() {
  print(
    """

    SKIPPED: the model reports itself available but cannot generate.

    \(blocker)

    The model stack is unavailable: the model assets on this machine are
    wedged (`fm respond` fails the same way). Logic-only checks would still
    pass, but every check that needs the model would fail for reasons that have
    nothing to do with the code. Nothing was verified.
    """)
  exit(0)
}

let harness = Harness()

if wants("baseline") { await runBaselineChecks(harness) }
if wants("compat") { await runCompatChecks(harness) }
if wants("prewarm") { await runPrewarmChecks(harness) }
if wants("tokens") { await runTokenCountChecks(harness) }
if wants("schema") { await runSchemaChecks(harness) }
if wants("constraints") { await runConstraintMatrixChecks(harness) }
if wants("tools") { await runToolChecks(harness) }

exit(await harness.summarize())
