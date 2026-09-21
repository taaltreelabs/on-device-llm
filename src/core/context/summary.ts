/**
 * The rolling summary's message format and prompt.
 *
 * Split out from the strategy because two other places need to recognise a
 * summary without running one: {@link analyzeConversation} (a summary must not
 * accidentally become "the system prompt" and get pinned forever) and the
 * strategy's *next* pass (which has to fold the old summary into the new one
 * instead of treating it as ordinary history).
 *
 * ### How a summary is marked, and why that way
 *
 * `Message` is `{ role, content, pinned? }` — there is no metadata field, and
 * widening it for this would put a context-manager concern into the type every
 * provider consumes. So the mark lives in the content: a summary is a message
 * with role `'system'` whose content starts with a marker line
 * ({@link DEFAULT_SUMMARY_MARKER}).
 *
 * - **Role `system`, not `assistant`.** The summary is out-of-band context
 *   *about* the conversation, not a turn anybody took. As an `assistant`
 *   message the model reads it as something it said and may defend or
 *   continue it. Both Chat Completions and Apple's `Transcript` accept a
 *   second system entry.
 * - **In the content, not a new field.** It survives every round-trip an app
 *   will put it through — JSON storage, a React state update, a provider that
 *   copies only the fields it knows — because it *is* the content.
 * - **Visible text, not an invisible sentinel.** The marker is sent to the
 *   model, where it usefully reads as a label. A zero-width or comment-style
 *   sentinel would be silently destroyed by any content normalisation.
 * - **Not auto-pinned.** `analyzeConversation` pins the first *non-summary*
 *   system message, so a summary stays an ordinary, re-summarizable,
 *   droppable part of history. That is the whole point: the next pass must be
 *   able to pick it up together with newly-aged turns and compress them into
 *   one replacement.
 *
 * Change the marker via `summaryMarker` if it collides with your own content,
 * but change it *consistently* — an old summary written with a different
 * marker is not recognised, and will be treated as an ordinary system message
 * in the middle of the history (a turn of its own, droppable, never merged).
 */

import type { Message } from '../messages';

/**
 * Prefix identifying a rolling-summary message. Reads as a label to the model
 * and as a discriminator to us.
 */
export const DEFAULT_SUMMARY_MARKER = '[summary of earlier conversation]';

/** Default cap on the summarizer's output, in tokens. */
export const DEFAULT_MAX_SUMMARY_TOKENS = 256;

/** Build a summary message in the format {@link isSummaryMessage} recognises. */
export function createSummaryMessage(
  text: string,
  options: { readonly marker?: string } = {}
): Message {
  const marker = options.marker ?? DEFAULT_SUMMARY_MARKER;
  return { role: 'system', content: `${marker}\n${text}` };
}

/** Is this message a rolling summary produced by {@link createSummaryMessage}? */
export function isSummaryMessage(
  message: Message,
  marker: string = DEFAULT_SUMMARY_MARKER
): boolean {
  return message.role === 'system' && message.content.startsWith(marker);
}

/**
 * The summary text with its marker stripped, or `undefined` if this is not a
 * summary message. Use it to feed a previous summary back into the next
 * summarization prompt.
 */
export function summaryText(
  message: Message,
  marker: string = DEFAULT_SUMMARY_MARKER
): string | undefined {
  if (!isSummaryMessage(message, marker)) return undefined;
  return message.content.slice(marker.length).replace(/^\n/, '');
}

/** What {@link SummaryPromptBuilder} is given. */
export interface SummaryPromptInput {
  /**
   * The verbatim messages being compressed, oldest first, with any previous
   * summary already removed (it arrives as {@link previousSummary} instead).
   */
  readonly messages: readonly Message[];
  /**
   * The text of the summary being superseded, when this is a
   * summary-of-summary pass. The builder must fold it into the new summary;
   * dropping it silently loses everything older than the current window.
   */
  readonly previousSummary?: string;
}

/**
 * Builds the request sent to the summarizer provider. Override to change tone,
 * language, or what gets preserved.
 *
 * Must return a message list that can stand alone as a request — the
 * summarizer is a plain `LLMProvider` and sees nothing else.
 */
export type SummaryPromptBuilder = (input: SummaryPromptInput) => readonly Message[];

/** Render messages as a plain labelled transcript for the summarizer to read. */
function renderTranscript(messages: readonly Message[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n');
}

const DEFAULT_INSTRUCTIONS = [
  'You compress conversation history.',
  'Rewrite the transcript below as a compact factual summary that will replace those messages in a later prompt.',
  'Preserve: goals the user stated, facts, names, numbers, identifiers, decisions reached, unresolved questions, and any instruction the user gave that still applies.',
  'Drop: greetings, acknowledgements, and restatements.',
  'Write in the third person ("the user...", "the assistant...") and in the language of the transcript.',
  'Do not answer the conversation, do not address anyone, do not add information that is not in the transcript.',
  'Reply with the summary text only.',
].join(' ');

/**
 * The stock summarization prompt: deliberately app-agnostic.
 *
 * It knows nothing about the domain, so it optimises for what any
 * conversation needs on a second pass — facts, decisions, standing
 * instructions — and explicitly forbids the two failure modes that make a
 * summary worse than useless: answering the conversation instead of
 * summarizing it, and inventing detail to fill the space.
 *
 * Supply your own via `prompt` when your app knows what matters (an order id,
 * a document under discussion). A domain-aware prompt is usually a large win;
 * this one is the floor, not the ceiling.
 */
export const defaultSummaryPrompt: SummaryPromptBuilder = ({ messages, previousSummary }) => {
  const body =
    previousSummary === undefined
      ? `Transcript:\n${renderTranscript(messages)}`
      : [
          'Summary of the conversation before this transcript:',
          previousSummary,
          '',
          'Transcript that follows it:',
          renderTranscript(messages),
          '',
          'Merge both into a single summary that replaces all of it.',
        ].join('\n');

  return [
    { role: 'system', content: DEFAULT_INSTRUCTIONS },
    { role: 'user', content: body },
  ];
};
