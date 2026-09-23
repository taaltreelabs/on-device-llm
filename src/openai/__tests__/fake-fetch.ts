/**
 * A tiny scriptable `fetch` for unit tests.
 *
 * Builds real `Response` objects (real `Headers`, a real
 * `ReadableStream<Uint8Array>` body when SSE chunks are scripted) so the
 * provider under test exercises its actual streaming/parsing code paths
 * instead of a mocked shortcut.
 */
import { expect, vi } from 'vitest';

export interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: unknown;
}

/** Turn a list of strings into a `ReadableStream<Uint8Array>` that yields one chunk per string. */
export function streamFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

/** SSE `data:` lines for a list of content deltas, terminated with `[DONE]`. */
export function sseChunkContent(
  deltas: readonly string[],
  options: {
    readonly usage?: { prompt_tokens: number; completion_tokens: number };
    readonly finishReason?: string;
  } = {}
): string {
  const parts = deltas.map(
    (delta) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: delta }, finish_reason: null }] })}\n\n`
  );
  const finishReason = options.finishReason ?? 'stop';
  parts.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`
  );
  if (options.usage) {
    parts.push(`data: ${JSON.stringify({ choices: [], usage: options.usage })}\n\n`);
  }
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

export interface ScriptedResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** Either a plain body string, or pre-chunked strings streamed via a real ReadableStream. */
  readonly body?: string | readonly string[];
  /** When true, `response.body` is `null` and `.text()` reads the joined body — simulates bare RN `fetch`. */
  readonly noReadableStream?: boolean;
}

export function makeResponse(scripted: ScriptedResponse): Response {
  const status = scripted.status ?? 200;
  const headers = new Headers(scripted.headers ?? { 'content-type': 'application/json' });
  const chunks =
    scripted.body === undefined
      ? []
      : typeof scripted.body === 'string'
        ? [scripted.body]
        : scripted.body;
  const fullText = chunks.join('');

  if (scripted.noReadableStream) {
    // Build a Response normally, then override `.body`/`.text()` to mimic
    // an environment without a streamable body (bare RN `fetch`).
    const response = new Response(fullText, { status, headers });
    Object.defineProperty(response, 'body', { value: null });
    return response;
  }

  const stream = streamFromChunks(chunks);
  return new Response(stream, { status, headers });
}

/** A scriptable fetch: each call consumes the next scripted response, in order. */
export function fakeFetch(responses: readonly (ScriptedResponse | (() => ScriptedResponse))[]) {
  const queue = [...responses];
  const requests: RecordedRequest[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    let bodyParsed: unknown;
    try {
      bodyParsed = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      bodyParsed = init?.body;
    }
    requests.push({ url, init: init ?? {}, body: bodyParsed });

    const signal = init?.signal;
    if (signal?.aborted) {
      const err = new DOMException('Aborted', 'AbortError');
      throw err;
    }

    const next = queue.shift();
    if (next === undefined) {
      throw new Error('fakeFetch: no scripted response left');
    }
    const scripted = typeof next === 'function' ? next() : next;

    // Honour abort firing while "in flight": if a signal is present, race
    // an abort event against immediate resolution.
    if (signal) {
      const abortPromise = new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
      return Promise.race([Promise.resolve(makeResponse(scripted)), abortPromise]);
    }
    return makeResponse(scripted);
  });
  return { fetch: fn as unknown as typeof fetch, requests };
}

export function expectHeader(
  requests: readonly RecordedRequest[],
  index: number,
  name: string,
  value: string
): void {
  const headers = new Headers(requests[index]?.init.headers as HeadersInit);
  expect(headers.get(name)).toBe(value);
}
