//
//  RequestRegistry.swift
//  OnDeviceLlm
//
//  Cancellation that really cancels (docs/plan.md §5, Phase 3 step 3).
//
//  FoundationModels exposes no `stop()`: `respond` is `async throws` and
//  `ResponseStream` is a plain `AsyncSequence`, so the only way to stop
//  generation is to cancel the Swift `Task` driving it
//  (docs/research/sdk-surface.md §3). The bridge therefore has to hold onto
//  that task for as long as the request is in flight, keyed by the request id
//  JavaScript generated.
//
//  An `actor` rather than a locked dictionary: concurrent streams, their
//  cancellations, and their completions all mutate this map from different
//  tasks, and the actor makes that a compile-time guarantee instead of a
//  discipline. Cancellation handles are stored as `@Sendable () -> Void`
//  closures so one registry can hold tasks of different result types.
//

import Foundation

actor RequestRegistry {
  private var handles: [String: @Sendable () -> Void] = [:]

  init() {}

  /// Register a cancellation handle for `requestId`.
  ///
  /// If the id is already registered (a caller reusing an id), the previous
  /// request is cancelled first — leaking a running generation would keep the
  /// ANE busy with work nobody is listening to.
  func register(_ requestId: String, cancel: @escaping @Sendable () -> Void) {
    if let existing = handles[requestId] {
      existing()
    }
    handles[requestId] = cancel
  }

  /// Cancel a request. Returns `false` when the id is unknown, which is the
  /// normal outcome of a cancel that races a natural completion.
  @discardableResult
  func cancel(_ requestId: String) -> Bool {
    guard let handle = handles.removeValue(forKey: requestId) else {
      return false
    }
    handle()
    return true
  }

  /// Drop a finished request without cancelling it.
  func finish(_ requestId: String) {
    handles.removeValue(forKey: requestId)
  }

  /// Cancel everything. Used when the module is torn down (a JS reload leaves
  /// generations running otherwise).
  func cancelAll() {
    let all = handles
    handles.removeAll()
    for handle in all.values {
      handle()
    }
  }

  var activeCount: Int { handles.count }
}
