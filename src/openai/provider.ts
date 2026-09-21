/**
 * `OpenAIProvider` — an `LLMProvider` for any Chat Completions-compatible
 * HTTP endpoint (docs/plan.md §5 Phase 1). Two intended targets: a
 * developer-supplied cloud fallback in production, and `fm serve` on
 * loopback during development (DECISIONS.md D8).
 */

import {
  estimateTokens,
  isAbortError,
  normalizeContextWindow,
  toLLMError,
  LLMError,
  UNKNOWN,
  type Availability,
  type Capabilities,
  type FinishReason,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type Message,
  type RequestOptions,
  type StreamEvent,
  type TokenUsage,
  type UnknownValue,
} from '../core';
import { buildApiError, extractErrorMessage } from './errors';
import { SseParser, type SseEvent } from './sse';
import {
  mapFinishReason,
  mapMessage,
  mapUsage,
  parseStructuredOutput,
  type ChatCompletionChunk,
  type ChatCompletionRequestBody,
  type ChatCompletionResponse,
} from './wire';

type FetchLike = typeof fetch;

/** Configuration for {@link createOpenAIProvider}. */
export interface OpenAIProviderConfig {
  /**
   * Base URL of the Chat Completions-compatible server, e.g.
   * `'https://api.openai.com/v1'` or `'http://127.0.0.1:1976/v1'` for
   * `fm serve`. The request is POSTed to `{baseUrl}/chat/completions` — note
   * that **you must include `/v1`** (or whatever path segment your server
   * uses) in `baseUrl` yourself; this provider does not add one. A trailing
   * slash is stripped if present.
   */
  readonly baseUrl: string;
  /** Model name sent as the request's `model` field (`fm serve` wants `'system'`). */
  readonly model: string;
  /** Sent as `Authorization: Bearer {apiKey}` when present. Omit for a server that needs no auth (e.g. loopback `fm serve`). */
  readonly apiKey?: string;
  /** Extra headers, merged over this provider's own (`Content-Type`, `Authorization`) — a caller-supplied header of the same name wins. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Injectable `fetch`, resolved lazily on every call rather than once at
   * construction — resolved eagerly, an RN app that has not yet finished
   * setting up `expo/fetch` (or that wants to swap it later) would get
   * frozen onto whatever `globalThis.fetch` was at construction time
   * (docs/research/ecosystem.md §3). Defaults to `globalThis.fetch`. Pass
   * `expo/fetch`'s `fetch` for real token-by-token streaming in Expo; bare
   * React Native's built-in `fetch` does not implement a `ReadableStream`
   * body, so streaming falls back to one aggregated `textDelta` (see
   * `stream()` below) unless you inject a WHATWG-compliant streaming fetch.
   */
  readonly fetch?: FetchLike;
  /** Stable provider id surfaced on results/errors. Defaults to `'openai'`. */
  readonly id?: string;
  /**
   * Total token budget for one request, including the response. The server
   * has no way to report this itself, so it comes from whoever configured
   * the endpoint. Defaults to `UNKNOWN` — better an honest "don't know" than
   * a guessed number silently driving the Phase 2 context manager's budget.
   */
  readonly contextWindow?: number;
  /** BCP-47 tags the endpoint is known to support. Defaults to `UNKNOWN` — most cloud endpoints cannot enumerate this. */
  readonly locales?: readonly string[];
  /**
   * Whether to send `stream_options: { include_usage: true }` on streaming
   * requests. Default `true`. Most Chat Completions-compatible servers
   * accept and honour this; if a target server 400s on the unrecognised
   * field, set this to `false` rather than dropping streaming entirely.
   */
  readonly sendStreamOptions?: boolean;
}

function missingConfig(field: string): never {
  throw new LLMError(
    { code: 'invalidRequest' },
    { message: `createOpenAIProvider: "${field}" is required` }
  );
}

/** Is `body` a real, readable `ReadableStream` (has `getReader`)? Bare React Native's built-in `fetch` returns a body without one. */
function hasReadableBody(response: Response): response is Response & {
  body: ReadableStream<Uint8Array>;
} {
  const body = response.body as unknown;
  return (
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { getReader?: unknown }).getReader === 'function'
  );
}

export class OpenAIProvider implements LLMProvider {
  readonly id: string;

  private readonly endpoint: string;
  private readonly model: string;
  private readonly config: OpenAIProviderConfig;
  private readonly contextWindowValue: number | UnknownValue;
  private readonly localesValue: readonly string[] | UnknownValue;

  constructor(config: OpenAIProviderConfig) {
    if (!config.baseUrl) missingConfig('baseUrl');
    if (!config.model) missingConfig('model');
    this.config = config;
    this.id = config.id ?? 'openai';
    this.model = config.model;
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.contextWindowValue =
      config.contextWindow === undefined ? UNKNOWN : normalizeContextWindow(config.contextWindow);
    this.localesValue = config.locales ?? UNKNOWN;
  }

  /**
   * Always reports available. Whether an HTTP endpoint is actually up,
   * reachable, and correctly configured is only knowable per-request — a
   * successful health check a moment ago says nothing about the next
   * request, and a synchronous "unavailable" here would just be a stale
   * cache of a fact that changes on its own schedule. Real reachability
   * failures surface as `network` `LLMError`s from `generate()`/`stream()`.
   */
  async availability(): Promise<Availability> {
    return { available: true };
  }

  async capabilities(): Promise<Capabilities> {
    return {
      contextWindow: this.contextWindowValue,
      streaming: true,
      structuredOutput: true,
      // Phase 3.
      tools: false,
      tokenCounting: 'estimated',
      locales: this.localesValue,
      modelLabel: this.model,
    };
  }

  /** Backed by `estimateTokens` — a heuristic, not a real count (no server here can pre-count). Callers should widen their safety margin accordingly (see `Capabilities.tokenCounting`). */
  async countTokens(messages: readonly Message[]): Promise<number> {
    return estimateTokens(messages);
  }

  async generate(request: GenerateRequest, options?: RequestOptions): Promise<GenerateResult> {
    const signal = options?.signal;
    this.throwIfAborted(signal);

    const body = this.buildRequestBody(request, false);
    const response = await this.doFetch(body, signal);
    if (!response.ok) throw await this.errorFromResponse(response);

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // D8 fm-serve quirk: it has been observed replying with an SSE
      // envelope even for `stream: false` (and, during one wedged period,
      // 500ing on an explicit `stream: false`). Aggregate rather than
      // failing `response.json()` on the SSE syntax.
      return this.aggregateSseResponse(response, request, signal);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new LLMError(
        { code: 'unknown' },
        { providerId: this.id, cause: err, message: 'Response body was not valid JSON' }
      );
    }
    return this.toGenerateResult(json as ChatCompletionResponse, request);
  }

  stream(request: GenerateRequest, options?: RequestOptions): AsyncIterable<StreamEvent> {
    return this.streamImpl(request, options);
  }

  private async *streamImpl(
    request: GenerateRequest,
    options?: RequestOptions
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const signal = options?.signal;
    this.throwIfAborted(signal);

    const body = this.buildRequestBody(request, true);
    const response = await this.doFetch(body, signal);
    if (!response.ok) throw await this.errorFromResponse(response);

    if (!hasReadableBody(response)) {
      // No real ReadableStream body (bare React Native's built-in `fetch`,
      // docs/research/ecosystem.md §3). Fall back to reading the whole
      // response and emitting it as a single textDelta + finish. This is
      // NOT real streaming — inject `expo/fetch` or another WHATWG-compliant
      // streaming `fetch` (config.fetch) for token-by-token delivery.
      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      const result = contentType.includes('text/event-stream')
        ? this.aggregateFromSseText(text, request)
        : this.toGenerateResult(this.parseJsonOrThrow(text), request);
      if (result.text !== '') yield { type: 'textDelta', delta: result.text };
      if (result.object !== undefined) yield { type: 'objectSnapshot', snapshot: result.object };
      yield { type: 'finish', result };
      return;
    }

    const reader = response.body.getReader();
    const onAbort = (): void => {
      reader.cancel().catch(() => {
        // Nothing to do — we are already unwinding via the abort error below.
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const decoder = new TextDecoder();
    const parser = new SseParser();
    let text = '';
    let finishReason: FinishReason = 'stop';
    let usage: TokenUsage | undefined;
    let sawDone = false;

    try {
      while (!sawDone) {
        this.throwIfAborted(signal);
        const { value, done } = await reader.read();
        // Re-check: cancelling a reader resolves a pending read as `done`
        // rather than rejecting it, so an abort that raced the read must be
        // caught here too, not just before it.
        this.throwIfAborted(signal);
        if (done) break;
        const events = parser.push(decoder.decode(value, { stream: true }));
        for (const event of events) {
          if (event.event === 'error') {
            // Observed live against fm serve (DECISIONS.md D8): an
            // otherwise-200 SSE stream can carry an in-band error frame.
            throw this.errorFromSseEvent(event);
          }
          if (event.data === '[DONE]') {
            sawDone = true;
            break;
          }
          if (event.data === '') continue;
          const chunk = this.tryParseChunk(event.data);
          if (chunk === undefined) continue;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === 'string' && delta !== '') {
            text += delta;
            yield { type: 'textDelta', delta };
          }
          if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
          const chunkUsage = mapUsage(chunk.usage);
          if (chunkUsage !== undefined) usage = chunkUsage;
        }
      }
    } catch (err) {
      if (signal?.aborted === true || isAbortError(err)) {
        throw new LLMError(
          { code: 'cancelled' },
          { providerId: this.id, cause: signal?.reason ?? err }
        );
      }
      throw toLLMError(err, { providerId: this.id });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!sawDone) {
        try {
          await reader.cancel();
        } catch {
          // Already unwinding; nothing more to do.
        }
      }
    }

    const object =
      request.schema !== undefined && text !== ''
        ? parseStructuredOutput(text, this.id)
        : undefined;

    const result: GenerateResult = {
      text,
      ...(object !== undefined ? { object } : {}),
      finishReason,
      ...(usage !== undefined ? { usage } : {}),
      providerId: this.id,
    };
    yield { type: 'finish', result };
  }

  // ---- request building -------------------------------------------------

  private buildRequestBody(request: GenerateRequest, stream: boolean): ChatCompletionRequestBody {
    const messages = request.messages.map((message) => mapMessage(message, this.id));
    const body: ChatCompletionRequestBody = { model: this.model, messages, stream };
    return {
      ...body,
      ...(stream && (this.config.sendStreamOptions ?? true)
        ? { stream_options: { include_usage: true as const } }
        : {}),
      ...(request.schema !== undefined
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: { name: 'output', strict: true as const, schema: request.schema },
            },
          }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
    };
  }

  private buildHeaders(): Record<string, string> {
    const base: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey !== undefined) base['Authorization'] = `Bearer ${this.config.apiKey}`;
    // Caller-supplied headers win over ours, per the config doc.
    return { ...base, ...(this.config.headers ?? {}) };
  }

  private async doFetch(
    body: ChatCompletionRequestBody,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    // Resolved lazily, at call time, not captured at construction — see the
    // `fetch` config doc for why (an RN app wiring up `expo/fetch` after
    // construction, or swapping it later, must not be frozen out).
    const fetchImpl: FetchLike | undefined = this.config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new LLMError(
        { code: 'invalidRequest' },
        {
          providerId: this.id,
          message:
            'No fetch implementation is available in this environment; pass one via createOpenAIProvider({ fetch: ... }).',
        }
      );
    }
    try {
      return await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw toLLMError(err, { providerId: this.id });
      throw new LLMError(
        { code: 'network' },
        { providerId: this.id, cause: err, message: 'Network request failed' }
      );
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new LLMError({ code: 'cancelled' }, { providerId: this.id, cause: signal.reason });
    }
  }

  // ---- response mapping ---------------------------------------------------

  private toGenerateResult(
    payload: ChatCompletionResponse,
    request: GenerateRequest
  ): GenerateResult {
    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? '';
    const finishReason = mapFinishReason(choice?.finish_reason);
    const usage = mapUsage(payload.usage);
    const object =
      request.schema !== undefined && text !== ''
        ? parseStructuredOutput(text, this.id)
        : undefined;
    return {
      text,
      ...(object !== undefined ? { object } : {}),
      finishReason,
      ...(usage !== undefined ? { usage } : {}),
      providerId: this.id,
    };
  }

  private parseJsonOrThrow(text: string): ChatCompletionResponse {
    try {
      return JSON.parse(text) as ChatCompletionResponse;
    } catch (err) {
      throw new LLMError(
        { code: 'unknown' },
        { providerId: this.id, cause: err, message: 'Response body was not valid JSON' }
      );
    }
  }

  private tryParseChunk(data: string): ChatCompletionChunk | undefined {
    try {
      return JSON.parse(data) as ChatCompletionChunk;
    } catch {
      // A malformed line inside an otherwise well-formed stream — ignore
      // and keep reading rather than aborting the whole response over one
      // corrupt frame.
      return undefined;
    }
  }

  // ---- SSE aggregation (non-streaming request, SSE-shaped response) -----

  private async aggregateSseResponse(
    response: Response,
    request: GenerateRequest,
    signal: AbortSignal | undefined
  ): Promise<GenerateResult> {
    if (!hasReadableBody(response)) {
      const text = await response.text();
      return this.aggregateFromSseText(text, request);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const events: SseEvent[] = [];
    try {
      while (true) {
        this.throwIfAborted(signal);
        const { value, done } = await reader.read();
        this.throwIfAborted(signal);
        if (done) break;
        events.push(...parser.push(decoder.decode(value, { stream: true })));
      }
      events.push(...parser.flush());
    } catch (err) {
      try {
        await reader.cancel();
      } catch {
        // Already unwinding.
      }
      if (signal?.aborted === true || isAbortError(err)) {
        throw new LLMError(
          { code: 'cancelled' },
          { providerId: this.id, cause: signal?.reason ?? err }
        );
      }
      throw toLLMError(err, { providerId: this.id });
    }
    return this.aggregateSseEvents(events, request);
  }

  private aggregateFromSseText(text: string, request: GenerateRequest): GenerateResult {
    const parser = new SseParser();
    const events = [...parser.push(text), ...parser.flush()];
    return this.aggregateSseEvents(events, request);
  }

  private aggregateSseEvents(
    events: readonly SseEvent[],
    request: GenerateRequest
  ): GenerateResult {
    let text = '';
    let finishReason: FinishReason = 'stop';
    let usage: TokenUsage | undefined;
    for (const event of events) {
      if (event.event === 'error') throw this.errorFromSseEvent(event);
      if (event.data === '' || event.data === '[DONE]') continue;
      const chunk = this.tryParseChunk(event.data);
      if (chunk === undefined) continue;
      const choice = chunk.choices?.[0];
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
      if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
      const chunkUsage = mapUsage(chunk.usage);
      if (chunkUsage !== undefined) usage = chunkUsage;
    }
    const object =
      request.schema !== undefined && text !== ''
        ? parseStructuredOutput(text, this.id)
        : undefined;
    return {
      text,
      ...(object !== undefined ? { object } : {}),
      finishReason,
      ...(usage !== undefined ? { usage } : {}),
      providerId: this.id,
    };
  }

  // ---- error mapping ------------------------------------------------------

  private async errorFromResponse(response: Response): Promise<LLMError> {
    const status = response.status;
    const retryAfter = response.headers.get('retry-after');
    let message: string | undefined;
    let rawBody = '';
    try {
      rawBody = await response.text();
      message = extractErrorMessage(rawBody);
    } catch {
      // Body unreadable — map on status alone.
    }
    return buildApiError({ status, message, retryAfter, providerId: this.id, cause: rawBody });
  }

  private errorFromSseEvent(event: SseEvent): LLMError {
    const message = extractErrorMessage(event.data);
    return buildApiError({ message, providerId: this.id, cause: event.data });
  }
}
