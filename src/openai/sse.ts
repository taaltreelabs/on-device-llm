/**
 * Incremental Server-Sent Events parsing.
 *
 * Deliberately hand-rolled rather than pulled from a dependency (`core` and
 * `openai` ship zero runtime dependencies, docs/plan.md §6). The parser is
 * fed raw text chunks as they arrive off a `ReadableStream` and returns
 * complete events as soon as their terminating blank line has been seen,
 * buffering any partial event (or partial line) across chunk boundaries.
 *
 * Handles, per the SSE spec and observed `fm serve` behaviour
 * (DECISIONS.md D8, docs/research/prior-art.md §5):
 * - events split across chunk boundaries, at any byte position, including
 *   mid-line;
 * - multiple events in a single chunk;
 * - CRLF and lone-CR line endings, not just LF;
 * - multiple `data:` lines in one event (joined with `\n`, per spec);
 * - comment lines (leading `:`) and unrecognised fields (`id:`, `retry:`,
 *   anything else) — ignored rather than erroring;
 * - a field line with no colon, whose entire content is the field name and
 *   whose value is the empty string (per spec).
 *
 * `data: [DONE]` is not special-cased here — it arrives as a perfectly
 * ordinary event with `data === '[DONE]'`, and the caller (which knows the
 * Chat Completions convention) decides to stop reading.
 */

/** One complete SSE event. */
export interface SseEvent {
  /** The `event:` field, when present. `undefined` for a bare `data:`-only event. */
  readonly event?: string;
  /** Every `data:` line for this event, joined with `\n`, per the SSE spec. */
  readonly data: string;
}

function normalizeLineEndings(text: string): string {
  // CRLF and lone CR both count as a line terminator per the SSE spec.
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseEventBlock(block: string): SseEvent | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  let sawField = false;

  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue; // blank line within a block, or a comment
    sawField = true;
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'event') {
      event = value;
    }
    // `id`, `retry`, and anything else are recognised-but-irrelevant or
    // unrecognised fields; both are ignored per the class doc.
  }

  if (!sawField) return undefined;
  return { event, data: dataLines.join('\n') };
}

/**
 * Stateful incremental parser. Feed it chunks in arrival order via
 * {@link push}; call {@link flush} once at end-of-stream to recover a final
 * event that was not terminated by a trailing blank line (some servers omit
 * it on the very last event before closing the connection).
 */
export class SseParser {
  private buffer = '';

  /** Feed a newly-arrived chunk of decoded text. Returns zero or more complete events. */
  push(chunk: string): SseEvent[] {
    this.buffer += normalizeLineEndings(chunk);
    const events: SseEvent[] = [];
    let boundary: number;
    // Events are separated by a blank line, i.e. two consecutive newlines.
    while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
      const rawBlock = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseEventBlock(rawBlock);
      if (parsed !== undefined) events.push(parsed);
    }
    return events;
  }

  /** Recover a trailing event left in the buffer with no terminating blank line. */
  flush(): SseEvent[] {
    const remaining = this.buffer;
    this.buffer = '';
    if (remaining.trim() === '') return [];
    const parsed = parseEventBlock(remaining);
    return parsed === undefined ? [] : [parsed];
  }
}
