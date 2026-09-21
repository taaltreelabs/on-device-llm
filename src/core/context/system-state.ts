/**
 * The app-owned structured state slot.
 *
 * **This is the recommended pattern for a purpose-built app** (docs/plan.md §5
 * Phase 2), and it is worth understanding why before reaching for a bigger
 * context strategy.
 *
 * A chat history is a terrible database. If your app has state the model needs
 * — a task list, a shopping cart, the document currently open, the step of a
 * flow the user is on — do not hope the model remembers it from twenty turns
 * ago, and do not pay for those twenty turns to stay in the window. Render the
 * state, freshly, into the system prompt on every request. It is then always
 * current, always exactly as long as the state is, and it costs the same
 * whether the conversation is two turns old or two hundred. History becomes
 * what it should be: recent phrasing and intent, which is exactly the part
 * that is cheap to trim.
 *
 * ```ts
 * // A task-tracking app. `store` is the app's own state — this package never
 * // sees or owns it.
 * const result = await fitContext(messages, {
 *   provider,
 *   systemState: () => {
 *     const tasks = store.getState().tasks;
 *     if (tasks.length === 0) return 'No open tasks.';
 *     return tasks
 *       .map((t) => `- [${t.done ? 'x' : ' '}] ${t.title} (due ${t.due ?? 'unset'})`)
 *       .join('\n');
 *   },
 * });
 * await provider.generate({ messages: result.messages });
 * ```
 *
 * which sends a system prompt of:
 *
 * ```text
 * You are a task assistant. Be brief.
 *
 * [current state]
 * - [ ] Renew passport (due 2026-10-01)
 * - [x] Book dentist (due unset)
 * ```
 *
 * ### Why the renderer takes no arguments
 *
 * `() => string`, not `(state) => string`. The state belongs to your app: a
 * store, a hook, a database read. A closure reaches all of them, needs no
 * generic parameter threaded through `fitContext`'s options, and keeps this
 * package from pretending to own a state container it knows nothing about. If
 * you already have `(state) => string`, pass `() => render(store.get())`.
 *
 * ### Idempotence
 *
 * The rendered block is delimited by a marker and any previously rendered
 * block is stripped before the new one is appended. So feeding a previous
 * result back in — which the rolling-summary flow encourages, see
 * `FitContextResult.summary` — replaces the state block rather than stacking
 * copies of it.
 */

import type { Message } from '../messages';
import { DEFAULT_SUMMARY_MARKER, isSummaryMessage } from './summary';

/** Marker line introducing the rendered state block inside the system prompt. */
export const DEFAULT_SYSTEM_STATE_MARKER = '[current state]';

/**
 * Renders the app's current state as text, called once per `fitContext` pass.
 *
 * Return `undefined` or an empty/whitespace string to render nothing this
 * turn — that is the correct answer when there is no state worth sending, and
 * it still strips any block left over from a previous pass.
 *
 * Must be synchronous and side-effect free. Load whatever you need before
 * calling `fitContext`.
 */
export type SystemStateRenderer = () => string | undefined;

/** Where the rendered state goes. */
export type SystemStatePlacement =
  /**
   * Appended to the system prompt, after a blank line. The default: one system
   * block is what Apple's `instructions` and Chat Completions both expect, and
   * a single block is harder for a model to ignore than a stray message.
   * Creates a pinned system prompt if the conversation has none.
   */
  | 'systemPrompt'
  /**
   * A pinned `system` message of its own, placed immediately after the system
   * prompt. Use when your system prompt is long and cached by the provider,
   * and you would rather not invalidate that cache every turn.
   */
  | 'ownMessage';

/** The long form of {@link SystemStateSlot}. */
export interface SystemStateOptions {
  /** See {@link SystemStateRenderer}. */
  readonly render: SystemStateRenderer;
  /** Defaults to `'systemPrompt'`. */
  readonly placement?: SystemStatePlacement;
  /** Defaults to {@link DEFAULT_SYSTEM_STATE_MARKER}. Keep it stable, or old blocks stop being recognised and will accumulate. */
  readonly marker?: string;
}

/**
 * Either a bare renderer or the full options object — `systemState: () => …`
 * is the common case and should not require a wrapper.
 */
export type SystemStateSlot = SystemStateRenderer | SystemStateOptions;

function toOptions(slot: SystemStateSlot): SystemStateOptions {
  return typeof slot === 'function' ? { render: slot } : slot;
}

/**
 * Remove a previously rendered state block from a system prompt, returning the
 * prompt as it was before the block was appended.
 *
 * Exported because an app that persists the messages it sent (rather than the
 * ones it holds) needs this to get its original system prompt back.
 */
export function stripSystemState(
  content: string,
  marker: string = DEFAULT_SYSTEM_STATE_MARKER
): string {
  const index = content.indexOf(marker);
  if (index === -1) return content;
  // Only strip a block that starts a line — a marker mentioned mid-sentence is
  // the app's own prose, not ours.
  if (index !== 0 && content[index - 1] !== '\n') return content;
  return content.slice(0, index).replace(/\n+$/, '');
}

/** The outcome of {@link applySystemState}, for `FitContextResult`. */
export interface SystemStateOutcome {
  /** Whether a non-empty block was rendered into the output. */
  readonly applied: boolean;
  /** Where it went, when `applied`. */
  readonly placement?: SystemStatePlacement;
  /** The rendered text, without the marker. Useful for logging what the model was told. */
  readonly text?: string;
}

/**
 * Render the slot into a copy of `messages`.
 *
 * Pure: `messages` is never mutated, and the returned array shares every
 * message object that did not change. Runs *before* measurement, so the state
 * block is inside the budget like any other content — which is the point, a
 * state block big enough to matter should push history out, not overflow the
 * request.
 */
export function applySystemState(
  messages: readonly Message[],
  slot: SystemStateSlot | undefined,
  summaryMarker: string = DEFAULT_SUMMARY_MARKER
): { readonly messages: readonly Message[]; readonly outcome: SystemStateOutcome } {
  if (slot === undefined) return { messages, outcome: { applied: false } };

  const {
    render,
    placement = 'systemPrompt',
    marker = DEFAULT_SYSTEM_STATE_MARKER,
  } = toOptions(slot);
  const rendered = render();
  const text = rendered === undefined ? '' : rendered.trim();
  const block = `${marker}\n${text}`;

  // The system prompt is the first system message that is not a summary — the
  // same rule analyzeConversation pins by, so the block always lands on a
  // message that survives trimming.
  const promptIndex = messages.findIndex(
    (message) => message.role === 'system' && !isSummaryMessage(message, summaryMarker)
  );

  if (placement === 'ownMessage') {
    const existing = messages.findIndex(
      (message) => message.role === 'system' && message.content.startsWith(marker)
    );
    const next = [...messages];
    if (existing !== -1) next.splice(existing, 1);
    if (text !== '') {
      const insertAt =
        promptIndex === -1 || (existing !== -1 && existing <= promptIndex) ? 0 : promptIndex + 1;
      next.splice(insertAt, 0, { role: 'system', content: block, pinned: true });
    }
    return {
      messages: next,
      outcome: text === '' ? { applied: false } : { applied: true, placement, text },
    };
  }

  if (promptIndex === -1) {
    if (text === '') return { messages, outcome: { applied: false } };
    return {
      messages: [{ role: 'system', content: block, pinned: true }, ...messages],
      outcome: { applied: true, placement, text },
    };
  }

  const prompt = messages[promptIndex];
  const base = stripSystemState(prompt.content, marker);
  const content = text === '' ? base : base === '' ? block : `${base}\n\n${block}`;
  if (content === prompt.content) {
    return {
      messages,
      outcome: text === '' ? { applied: false } : { applied: true, placement, text },
    };
  }

  const next = [...messages];
  next[promptIndex] = { ...prompt, content };
  return {
    messages: next,
    outcome: text === '' ? { applied: false } : { applied: true, placement, text },
  };
}
