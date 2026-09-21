/**
 * Streaming events.
 *
 * DECISIONS.md D5: `StreamEvent` carries **deltas**, not cumulative
 * snapshots. Deltas are the convention of Chat Completions, of UI code that
 * appends to a buffer, and of our `openai` provider. Apple's
 * `ResponseStream` yields cumulative `Snapshot` values
 * (docs/research/sdk-surface.md §streaming — confirmed still true in iOS
 * 27.1), so the Apple provider diffs consecutive snapshots and emits deltas
 * here. The conversion cost is paid once, in one provider, instead of by
 * every consumer.
 */

import type { GenerateResult } from './generation';

/** A chunk of newly generated text. Concatenating every delta in order reproduces `GenerateResult.text`. */
export interface TextDeltaEvent {
  readonly type: 'textDelta';
  /** Only the new characters since the previous event — never the accumulated text. */
  readonly delta: string;
}

/**
 * A partially populated structured-output value.
 *
 * Justification for existing alongside `textDelta` (D5 mandates deltas, and
 * this event is explicitly a snapshot): text is append-only, so a delta is
 * well-defined, but a partially generated *object* changes by having fields
 * filled in — Apple's stream yields a partially populated
 * `GeneratedContent` whose fields appear and firm up over time
 * (docs/research/sdk-surface.md §streaming). There is no meaningful "object
 * delta" to diff, and a JSON-patch-shaped event would push the reassembly
 * work onto every consumer. So structured output streams as successive
 * whole-value snapshots, each replacing the last.
 *
 * Providers that cannot stream structured output simply never emit this and
 * deliver `object` on the `finish` event.
 */
export interface ObjectSnapshotEvent {
  readonly type: 'objectSnapshot';
  /** The value so far. Replaces any previous snapshot; may have missing or incomplete fields. */
  readonly snapshot: unknown;
}

/**
 * The stream finished normally, carrying the same `GenerateResult` that
 * `generate()` would have returned for this request.
 *
 * Always the last event of a successful stream, and emitted exactly once —
 * so a consumer can read `finishReason`, `usage`, and `providerId` without
 * making a second call. Failures do **not** arrive as an event: the async
 * iterator throws an `LLMError` instead, which is what `for await` + `try`
 * already handles and what keeps "stream failed" impossible to ignore. An
 * aborted stream therefore throws `cancelled` rather than finishing.
 */
export interface FinishEvent {
  readonly type: 'finish';
  /** The complete result for this generation. */
  readonly result: GenerateResult;
}

/**
 * One event from `LLMProvider.stream()`.
 *
 * Discriminated on `type`. Consumers should ignore event types they do not
 * recognise (a `default: break`) rather than throwing — Phase 3 adds tool
 * events here, and a UI that renders text should not break when a provider
 * starts reporting tool activity. Tool events are intentionally not
 * declared yet: unlike `FinishReason.toolCalls`, a new *event type* can be
 * added without breaking the callers that follow this rule.
 */
export type StreamEvent = TextDeltaEvent | ObjectSnapshotEvent | FinishEvent;
