//
//  SnapshotDiffer.swift
//  OnDeviceLlm
//
//  Turns FoundationModels' cumulative response snapshots into the deltas our
//  `StreamEvent` union carries (DECISIONS.md D5).
//
//  `LanguageModelSession.ResponseStream.Element` is literally named `Snapshot`
//  and, for `Content == String`, each iteration yields the whole accumulated
//  string (docs/research/sdk-surface.md §3). Chat Completions, every UI that
//  appends to a text node, and our own `openai` provider all speak deltas, so
//  the conversion happens here, once, in a pure value type that the macOS
//  harness exercises against the real model.
//

import Foundation

/// One diff step. `reset` is the D18 fallback flag.
struct SnapshotDelta: Sendable, Equatable {
  let text: String
  let reset: Bool
}

/// Stateful over one stream; not shared between requests.
///
/// **DECISIONS.md D18 — the non-extension fallback.** In the normal case each
/// snapshot extends the previous one and the emitted deltas concatenate
/// *exactly* to the final text. A snapshot that is not an extension means the
/// model rewrote text we have already handed to the consumer, and a delta
/// stream physically cannot retract it. The policy is therefore:
///
/// 1. Emit the suffix of the new snapshot past the longest common prefix with
///    what was already emitted, flagged `reset: true`.
/// 2. Keep going — the alternatives are to stall the stream (the UI freezes
///    mid-sentence) or to re-emit the entire snapshot (which duplicates far
///    more text than the common prefix does).
/// 3. Treat the `finish` event's `text` — always the last snapshot, never the
///    concatenation — as authoritative, so a consumer that renders deltas
///    live and then swaps in the final text always converges.
///
/// `reset` is surfaced to JavaScript rather than swallowed so this stays
/// observable if the framework's behaviour ever changes. It has not been seen
/// in practice for `Content == String`; this is a guard, not a workaround.
struct SnapshotDiffer: Sendable {
  /// Everything handed to the consumer so far.
  private(set) var emitted: String = ""
  /// Whether rule 1 above has fired at least once during this stream.
  private(set) var diverged: Bool = false

  init() {}

  /// The delta for `snapshot`, or `nil` when there is nothing new to send.
  mutating func delta(for snapshot: String) -> SnapshotDelta? {
    if snapshot == emitted {
      return nil
    }
    if snapshot.hasPrefix(emitted) {
      let delta = String(snapshot.dropFirst(emitted.count))
      emitted = snapshot
      return SnapshotDelta(text: delta, reset: false)
    }

    // Non-extension: the model rewrote something we already emitted.
    diverged = true
    let common = snapshot.commonPrefix(with: emitted)
    let delta = String(snapshot.dropFirst(common.count))
    emitted = snapshot
    // A snapshot that only got *shorter* leaves nothing new to say; the
    // divergence is still recorded, and `finish` will carry the truth.
    return delta.isEmpty ? nil : SnapshotDelta(text: delta, reset: true)
  }
}
