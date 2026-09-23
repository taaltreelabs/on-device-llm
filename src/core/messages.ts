/**
 * Conversation messages — the unit every provider speaks in.
 *
 * The provider interface is stateless and message-based (docs/plan.md §2,
 * "Stateless providers"): a request carries the whole message list, the
 * provider answers it, and the context manager / router own the
 * conversation. Providers never accumulate their own transcript.
 */

/**
 * Who authored a message.
 *
 * FORWARD-COMPAT SEAM (Phase 3, tool calling — docs/plan.md §4): a `'tool'`
 * role will be added here to carry tool results back to the model, together
 * with an optional `toolCalls` field on assistant messages. It is
 * deliberately *not* half-designed now, because its shape depends on the
 * bridge protocol that Phase 3 settles (call ids, timeouts, cancellation of
 * in-flight calls).
 *
 * What that means for code written today: treat this union as **open**.
 * Provider authors switching on `message.role` must include a `default`
 * branch — the safe behaviour for an unrecognised role is to throw
 * `new LLMError({ code: 'invalidRequest' })` rather than silently dropping
 * the message, since a dropped tool result corrupts the conversation.
 * Exhaustive switches with no default will stop compiling when the role is
 * added; a `default` branch keeps working.
 */
export type MessageRole = 'system' | 'user' | 'assistant';

/**
 * One turn of a conversation.
 *
 * Kept as a single open interface rather than a discriminated union of
 * per-role types so that Phase 3 can add role-specific optional fields
 * (`toolCalls` on assistant turns, a tool-call id on tool turns) without
 * reshaping the type that every provider, the context manager, and the
 * React hooks all consume.
 *
 * `content` is a plain string in Phase 1. Multimodal input (iOS 27 supports
 * image attachments, see docs/research/sdk-surface.md §9) would arrive as an
 * additional optional field — e.g. `attachments?: […]` — never by widening
 * `content` to a union, which would break every existing reader.
 */
export interface Message {
  /** Who authored this message. */
  readonly role: MessageRole;
  /** The message text. Empty strings are legal but rarely useful. */
  readonly content: string;
  /**
   * Never drop this message when trimming history to fit the context
   * window.
   *
   * Consumed by the Phase 2 context manager (docs/plan.md §5): pinned
   * messages and system messages survive every trimming strategy. Providers
   * ignore this flag — it is metadata for the layer above them.
   */
  readonly pinned?: boolean;
}
