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
//  (baseline, prewarm, tokens, schema, constraints, tools).
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

print("model: \(SystemLanguageModel.default.variant.displayName)")

let harness = Harness()

if wants("baseline") { await runBaselineChecks(harness) }
if wants("prewarm") { await runPrewarmChecks(harness) }
if wants("tokens") { await runTokenCountChecks(harness) }
if wants("schema") { await runSchemaChecks(harness) }
if wants("constraints") { await runConstraintMatrixChecks(harness) }
if wants("tools") { await runToolChecks(harness) }

exit(await harness.summarize())
