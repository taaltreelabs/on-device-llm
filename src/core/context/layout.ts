/**
 * Conversation layout: which messages are pinned, and how the rest group into
 * turns that can only be dropped whole.
 *
 * Every strategy trims by choosing turns to discard, so this module is where
 * the two invariants the property tests check are actually established:
 * pinned messages survive, and no assistant message is ever orphaned.
 */

import type { Message } from '../messages';
import { DEFAULT_SUMMARY_MARKER, isSummaryMessage } from './summary';

/**
 * Which `system` messages count as pinned.
 *
 * - `'first'` (default) — the system prompt only. The reading docs/plan.md
 *   §5 asks for, and the one that keeps a rolling summary droppable: a
 *   summary is a system message, and pinning every system message would make
 *   each one immortal, so a long conversation would accumulate summaries it
 *   could never retire.
 * - `'all'` — every system message. For apps that inject standing
 *   instructions mid-conversation and mean them to be permanent.
 * - `'none'` — no implicit pinning at all; only `pinned: true` protects a
 *   message. For callers who want total control.
 *
 * A summary message (see `isSummaryMessage`) is never pinned implicitly under
 * *any* of these modes — including `'all'` — because a pinned summary can
 * never be re-summarized or retired. Set `pinned: true` on it yourself if you
 * really want that.
 */
export type PinSystemMessages = 'first' | 'all' | 'none';

/**
 * A group of messages that trimming treats as one unit.
 *
 * "Turn" rather than "message pair" because real conversations are not neat
 * pairs: see {@link analyzeConversation} for the exact pairing rules and the
 * edge shapes they were written for.
 */
export interface ConversationTurn {
  /** Indices into the original message list, ascending. Never empty. */
  readonly indices: readonly number[];
  /** Whether this turn contains at least one `user` message. */
  readonly hasUser: boolean;
  /** Whether this turn contains at least one `assistant` message. */
  readonly hasAssistant: boolean;
  /**
   * `true` for a turn that is a single non-pinned `system` message — in
   * practice, a rolling summary. Kept distinct because it is the one turn
   * shape that carries compressed history rather than a literal exchange.
   */
  readonly isSystemBlock: boolean;
}

/** The result of {@link analyzeConversation}. */
export interface ConversationLayout {
  /** Indices that no strategy may drop, ascending. */
  readonly pinnedIndices: readonly number[];
  /** Droppable turns, oldest first. Together with `pinnedIndices` these cover every index exactly once. */
  readonly turns: readonly ConversationTurn[];
}

/** Options for {@link analyzeConversation}. */
export interface AnalyzeConversationOptions {
  /** See {@link PinSystemMessages}. Defaults to `'first'`. */
  readonly pinSystemMessages?: PinSystemMessages;
  /** Marker identifying rolling summaries. Defaults to {@link DEFAULT_SUMMARY_MARKER}. */
  readonly summaryMarker?: string;
}

/**
 * Split a conversation into pinned messages and droppable turns.
 *
 * ### Pinning rules
 *
 * 1. `message.pinned === true` always pins, whatever the role.
 * 2. A `system` message that is **not** a summary is pinned according to
 *    {@link PinSystemMessages} (default: only the first one — the system
 *    prompt).
 * 3. A summary message is never pinned implicitly.
 *
 * ### Turn pairing rules
 *
 * Turns are formed over the non-pinned messages only, in order. Pinned
 * messages sit outside every turn and stay exactly where they are, so a
 * pinned message in the middle of history does not split the turns around it.
 *
 * - **R1 — a turn opens at a `user` message.** Its `assistant` replies join
 *   it. This is the ordinary `[user, assistant]` pair.
 * - **R2 — consecutive `user` messages merge into one turn.** `[u1, u2, a]`
 *   is a single turn, not two: `a` answers both, and dropping `u1` while
 *   keeping `u2, a` would strand a reply on top of half its prompt. A new
 *   turn only opens at a `user` message that follows at least one
 *   `assistant`.
 * - **R3 — consecutive `assistant` messages stay in the turn they replied
 *   to.** A multi-part answer is one answer.
 * - **R4 — `assistant` messages before any `user` form a leading turn of
 *   their own** (the seeded-greeting shape, `[assistant, user, assistant]`).
 *   It has no user message and is not "orphaned" — it never had a prompt to
 *   be separated from — so it is droppable like any other turn, and being
 *   oldest it goes first.
 * - **R5 — a `system` message that is not pinned forms a turn by itself**
 *   (the rolling-summary shape). It does not absorb the turns around it, so
 *   trimming can retire a stale summary without taking verbatim history with
 *   it. The exception: a system message that lands *inside* an unanswered turn
 *   (`[user, system, assistant]`) joins that turn instead, because splitting
 *   there would leave the assistant standing alone as the newest turn — an
 *   orphan by any other name.
 * - **R6 — the last turn may be user-only.** That is the normal shape of a
 *   request awaiting a reply, and `slidingWindow` never drops the newest
 *   turn.
 * - **R7 — an assistant-only turn re-joins the turn it continues.** When a
 *   non-pinned `system` message lands between two parts of an answer
 *   (`[user, assistant, system, assistant]`), R5 gives the system message its
 *   own turn, which would leave the trailing `assistant` stranded in a turn
 *   with no user — droppable separately from its prompt, i.e. an orphan
 *   waiting to happen. So after grouping, any turn that has assistant
 *   messages but no user message is merged into the nearest earlier turn
 *   that is not a system block. A leading assistant run with no earlier turn
 *   to join stays a prologue turn (R4). Found by a fast-check property
 *   (seed 1367200082) during Phase 3, not by the hand-written edge cases.
 *
 * Because turns are dropped whole and oldest-first, an `assistant` message can
 * only ever be kept alongside the `user` message(s) that prompted it. That is
 * the orphan guarantee — it falls out of the grouping rather than being
 * patched up afterwards.
 */
export function analyzeConversation(
  messages: readonly Message[],
  options: AnalyzeConversationOptions = {}
): ConversationLayout {
  const pinSystemMessages = options.pinSystemMessages ?? 'first';
  const summaryMarker = options.summaryMarker ?? DEFAULT_SUMMARY_MARKER;

  const pinnedIndices: number[] = [];
  const droppable: number[] = [];
  let seenSystemPrompt = false;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isSummary = isSummaryMessage(message, summaryMarker);
    let pinned = message.pinned === true;

    if (!pinned && message.role === 'system' && !isSummary) {
      if (pinSystemMessages === 'all') {
        pinned = true;
      } else if (pinSystemMessages === 'first' && !seenSystemPrompt) {
        pinned = true;
      }
      seenSystemPrompt = true;
    }

    if (pinned) pinnedIndices.push(index);
    else droppable.push(index);
  }

  const turns: ConversationTurn[] = [];
  let current: number[] = [];
  let hasUser = false;
  let hasAssistant = false;

  const flush = (): void => {
    if (current.length === 0) return;
    turns.push({ indices: current, hasUser, hasAssistant, isSystemBlock: false });
    current = [];
    hasUser = false;
    hasAssistant = false;
  };

  for (const index of droppable) {
    const role = messages[index].role;

    // R5: a non-pinned system message (a summary, normally) stands alone —
    // unless it interrupts a turn that has not been answered yet, in which
    // case it is part of that turn's prompt and must not split it. Standing
    // alone unconditionally orphans the reply in `[user, system, assistant]`:
    // the assistant would end up the newest turn all by itself.
    if (role === 'system') {
      if (current.length > 0 && !hasAssistant) {
        current.push(index);
        continue;
      }
      flush();
      turns.push({ indices: [index], hasUser: false, hasAssistant: false, isSystemBlock: true });
      continue;
    }

    // R1/R2: a user message opens a turn only if the current one already has
    // a reply in it. Otherwise it merges (consecutive users answered together).
    if (role === 'user' && hasAssistant) {
      flush();
    }

    current.push(index);
    if (role === 'user') hasUser = true;
    // Any non-user, non-system role counts as a reply for pairing purposes.
    // Written this way rather than `role === 'assistant'` because MessageRole
    // is explicitly an open union (see messages.ts): a future `tool` message
    // belongs to the turn it answers, exactly like an assistant message, and
    // must never open a turn of its own.
    else hasAssistant = true;
  }
  flush();

  // R7: merge any assistant-only turn back into the turn it continues, so a
  // system message that interrupted a multi-part answer cannot leave the
  // trailing part droppable separately from its prompt.
  const merged: ConversationTurn[] = [];
  for (const turn of turns) {
    if (turn.hasAssistant && !turn.hasUser && !turn.isSystemBlock) {
      let target = -1;
      for (let i = merged.length - 1; i >= 0; i -= 1) {
        if (!merged[i].isSystemBlock) {
          target = i;
          break;
        }
      }
      if (target !== -1) {
        const host = merged[target];
        merged[target] = {
          indices: [...host.indices, ...turn.indices],
          hasUser: host.hasUser,
          hasAssistant: true,
          isSystemBlock: false,
        };
        continue;
      }
    }
    merged.push(turn);
  }

  return { pinnedIndices, turns: merged };
}
