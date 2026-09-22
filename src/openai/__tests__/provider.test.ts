import { describe, expect, it, vi } from 'vitest';

import { isLLMError, UNKNOWN } from '../../core';
import { createOpenAIProvider } from '../index';
import { expectHeader, fakeFetch, makeResponse, sseChunkContent } from './fake-fetch';

const BASE = 'http://127.0.0.1:1976/v1';

/** Fully consume an async iterable, for tests that only care about a side effect (request recorded, or a rejection). */
async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const event of iterable) {
    seen.push(event);
  }
  return seen;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
  };
}

describe('createOpenAIProvider: config and endpoint', () => {
  it('strips a trailing slash from baseUrl and posts to /chat/completions', async () => {
    const { fetch, requests } = fakeFetch([
      jsonResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: `${BASE}/`, model: 'system', fetch });
    await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(requests[0].url).toBe(`${BASE}/chat/completions`);
  });

  it('uses the injected fetch, not globalThis.fetch', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const { fetch, requests } = fakeFetch([
      jsonResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'system', fetch });
    await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(requests).toHaveLength(1);
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('sends Authorization: Bearer when apiKey is set, and lets caller headers win over it', async () => {
    const { fetch, requests } = fakeFetch([
      jsonResponse({ choices: [{ message: { content: 'a' }, finish_reason: 'stop' }] }),
      jsonResponse({ choices: [{ message: { content: 'b' }, finish_reason: 'stop' }] }),
    ]);
    const withAuth = createOpenAIProvider({ baseUrl: BASE, model: 'm', apiKey: 'secret', fetch });
    await withAuth.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expectHeader(requests, 0, 'Authorization', 'Bearer secret');

    const overridden = createOpenAIProvider({
      baseUrl: BASE,
      model: 'm',
      apiKey: 'secret',
      headers: { Authorization: 'Bearer override' },
      fetch,
    });
    await overridden.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expectHeader(requests, 1, 'Authorization', 'Bearer override');
  });

  it('default id is "openai"; a custom id is honoured and surfaced on results', async () => {
    const { fetch } = fakeFetch([
      jsonResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', id: 'my-cloud', fetch });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(provider.id).toBe('my-cloud');
    expect(result.providerId).toBe('my-cloud');
  });

  it('availability() is always available', async () => {
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm' });
    await expect(provider.availability()).resolves.toEqual({ available: true });
  });

  it('capabilities() defaults contextWindow/locales to UNKNOWN, honours configured values', async () => {
    const bare = createOpenAIProvider({ baseUrl: BASE, model: 'm' });
    const bareCaps = await bare.capabilities();
    expect(bareCaps).toMatchObject({
      contextWindow: UNKNOWN,
      streaming: true,
      structuredOutput: true,
      tools: false,
      tokenCounting: 'estimated',
      locales: UNKNOWN,
      modelLabel: 'm',
    });

    const configured = createOpenAIProvider({
      baseUrl: BASE,
      model: 'm',
      contextWindow: 8192,
      locales: ['en-US', 'fr-FR'],
    });
    const caps = await configured.capabilities();
    expect(caps.contextWindow).toBe(8192);
    expect(caps.locales).toEqual(['en-US', 'fr-FR']);
  });

  it('a non-positive configured contextWindow normalizes to UNKNOWN (D9 guard)', async () => {
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', contextWindow: 0 });
    expect((await provider.capabilities()).contextWindow).toBe(UNKNOWN);
  });

  it('countTokens is backed by estimateTokens', async () => {
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm' });
    const messages = [{ role: 'user' as const, content: 'hello world' }];
    const count = await provider.countTokens!(messages);
    expect(count).toBeGreaterThan(0);
  });
});

describe('generate(): non-streaming mapping', () => {
  it('maps text, finish_reason, and usage', async () => {
    const { fetch, requests } = fakeFetch([
      jsonResponse({
        choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'system', fetch });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({
      text: 'hello there',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
      providerId: 'openai',
    });
    expect(requests[0].body).toMatchObject({ model: 'system', stream: false });
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['content_filter', 'guardrail'],
    ['tool_calls', 'other'],
    [null, 'other'],
  ])('maps finish_reason %s -> %s', async (wire, expected) => {
    const { fetch } = fakeFetch([
      jsonResponse({ choices: [{ message: { content: 'x' }, finish_reason: wire }] }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.finishReason).toBe(expected);
  });

  it('never defaults missing usage fields to 0', async () => {
    const { fetch } = fakeFetch([
      jsonResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.usage).toBeUndefined();
  });

  it('sends response_format json_schema and parses object when request.schema is set', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const { fetch, requests } = fakeFetch([
      jsonResponse({
        choices: [{ message: { content: '{"name":"Ada"}' }, finish_reason: 'stop' }],
      }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema });
    expect(requests[0].body).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'output', strict: true, schema },
      },
    });
    expect(result.object).toEqual({ name: 'Ada' });
  });

  it('a schema request whose output fails to parse throws unknown, with rawText only on cause', async () => {
    const schema = { type: 'object' };
    const { fetch } = fakeFetch([
      jsonResponse({ choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const promise = provider.generate({ messages: [{ role: 'user', content: 'hi' }], schema });
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      if (!isLLMError(err, 'unknown')) return false;
      expect(err.message).not.toContain('not json');
      expect(err.cause).toMatchObject({ rawText: 'not json' });
      return true;
    });
  });

  it('sends temperature and max_tokens from request', async () => {
    const { fetch, requests } = fakeFetch([
      jsonResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      maxOutputTokens: 128,
    });
    expect(requests[0].body).toMatchObject({ temperature: 0.3, max_tokens: 128 });
  });

  it('rejects unrecognised message roles as invalidRequest', async () => {
    const { fetch } = fakeFetch([]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const bad = { role: 'tool', content: 'x' } as unknown as { role: 'user'; content: string };
    await expect(provider.generate({ messages: [bad] })).rejects.toMatchObject({
      code: 'invalidRequest',
    });
  });

  it('D8: aggregates an SSE response even though the request was stream:false', async () => {
    const { fetch, requests } = fakeFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseChunkContent(['Hel', 'lo'], { usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(requests[0].body).toMatchObject({ stream: false });
    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('aborting before the call throws cancelled without calling fetch', async () => {
    const { fetch, requests } = fakeFetch([jsonResponse({ choices: [] })]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.generate(
        { messages: [{ role: 'user', content: 'hi' }] },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests).toHaveLength(0);
  });
});

describe('stream(): incremental parsing and aggregation', () => {
  it('emits textDelta per content delta then exactly one finish with aggregated text and usage', async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseChunkContent(['Hel', 'lo', ' world'], {
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const events = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    const deltas = events
      .filter((e) => e.type === 'textDelta')
      .map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(['Hel', 'lo', ' world']);
    expect(events.at(-1)).toMatchObject({
      type: 'finish',
      result: {
        text: 'Hello world',
        finishReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 3 },
      },
    });
    expect(events.filter((e) => e.type === 'finish')).toHaveLength(1);
  });

  it('parses events split mid-line across chunk boundaries', async () => {
    const full = sseChunkContent(['ab']);
    const cut = Math.floor(full.length / 2);
    const { fetch } = fakeFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [full.slice(0, cut), full.slice(cut)],
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    let text = '';
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'textDelta') text += event.delta;
    }
    expect(text).toBe('ab');
  });

  it('handles multiple events delivered in a single chunk', async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseChunkContent(['a', 'b', 'c']),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    let text = '';
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'textDelta') text += event.delta;
    }
    expect(text).toBe('abc');
  });

  it('handles CRLF-terminated SSE lines', async () => {
    const body =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }) +
      '\r\n\r\ndata: [DONE]\r\n\r\n';
    const { fetch } = fakeFetch([
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    let text = '';
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'textDelta') text += event.delta;
    }
    expect(text).toBe('x');
  });

  it('stops at [DONE] and ignores anything scripted after it', async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseChunkContent(['only']) + 'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    let text = '';
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'textDelta') text += event.delta;
    }
    expect(text).toBe('only');
  });

  it('D8: maps an in-band event: error frame to an LLMError and throws it out of the iterator', async () => {
    const body =
      'event: error\ndata: ' +
      JSON.stringify({ error: { message: 'internal server error' } }) +
      '\n\n';
    const { fetch } = fakeFetch([
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const iterate = () => drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));
    await expect(iterate()).rejects.toMatchObject({ code: 'network' });
  });

  it('structured output: parses the aggregated text into result.object on finish', async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseChunkContent(['{"a":1}']),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    let finishResult;
    for await (const event of provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
      schema: { type: 'object' },
    })) {
      if (event.type === 'finish') finishResult = event.result;
    }
    expect(finishResult?.object).toEqual({ a: 1 });
  });

  it('injectable fetch is used for streaming too', async () => {
    const { fetch, requests } = fakeFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseChunkContent(['x']),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(requests[0].body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('sendStreamOptions: false omits stream_options', async () => {
    const { fetch, requests } = fakeFetch([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseChunkContent(['x']),
      },
    ]);
    const provider = createOpenAIProvider({
      baseUrl: BASE,
      model: 'm',
      fetch,
      sendStreamOptions: false,
    });
    await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(requests[0].body).not.toHaveProperty('stream_options');
  });

  it('aborting before the call throws cancelled without calling fetch', async () => {
    const { fetch, requests } = fakeFetch([]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const controller = new AbortController();
    controller.abort();
    const iterate = () =>
      drain(
        provider.stream(
          { messages: [{ role: 'user', content: 'hi' }] },
          { signal: controller.signal }
        )
      );
    await expect(iterate()).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests).toHaveLength(0);
  });

  it('aborting mid-stream cancels the reader and throws cancelled', async () => {
    const cancelTracker = { called: false };
    const encoder = new TextEncoder();
    const chunk1 =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'Hel' }, finish_reason: null }] }) +
      '\n\n';
    const chunk2 =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n';
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pullCount === 0) {
          controller.enqueue(encoder.encode(chunk1));
          pullCount += 1;
          return;
        }
        if (pullCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          controller.enqueue(encoder.encode(chunk2));
          pullCount += 1;
          return;
        }
        controller.close();
      },
      cancel() {
        cancelTracker.called = true;
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const fetchFn = vi.fn(async () => response);
    const provider = createOpenAIProvider({
      baseUrl: BASE,
      model: 'm',
      fetch: fetchFn as unknown as typeof fetch,
    });

    const controller2 = new AbortController();
    const iterator = provider
      .stream({ messages: [{ role: 'user', content: 'hi' }] }, { signal: controller2.signal })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({ type: 'textDelta', delta: 'Hel' });

    controller2.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancelTracker.called).toBe(true);
  });

  it('falls back to one textDelta + finish when response.body is not a ReadableStream (no-streaming environment)', async () => {
    const body = sseChunkContent(['whole response at once']);
    const response = makeResponse({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body,
      noReadableStream: true,
    });
    const fetchFn = vi.fn(async () => response);
    const provider = createOpenAIProvider({
      baseUrl: BASE,
      model: 'm',
      fetch: fetchFn as unknown as typeof fetch,
    });
    const events = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === 'textDelta')).toHaveLength(1);
    expect(events).toEqual([
      { type: 'textDelta', delta: 'whole response at once' },
      { type: 'finish', result: expect.objectContaining({ text: 'whole response at once' }) },
    ]);
  });

  it('falls back for a non-SSE JSON response too, in the no-ReadableStream path', async () => {
    const response = makeResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        choices: [{ message: { content: 'plain json' }, finish_reason: 'stop' }],
      }),
      noReadableStream: true,
    });
    const fetchFn = vi.fn(async () => response);
    const provider = createOpenAIProvider({
      baseUrl: BASE,
      model: 'm',
      fetch: fetchFn as unknown as typeof fetch,
    });
    const events = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    expect(events[0]).toEqual({ type: 'textDelta', delta: 'plain json' });
  });
});

describe('HTTP error mapping', () => {
  it('429 with numeric Retry-After maps to rateLimited with a resetDate', async () => {
    const { fetch } = fakeFetch([
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
        body: JSON.stringify({ error: { message: 'slow down' } }),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    const before = Date.now();
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toSatisfy((err: unknown) => {
      if (!isLLMError(err, 'rateLimited')) return false;
      expect(err.details.resetDate).toBeInstanceOf(Date);
      expect(err.details.resetDate!.getTime()).toBeGreaterThanOrEqual(before + 29_000);
      return true;
    });
  });

  it('429 with an HTTP-date Retry-After parses to that date', async () => {
    const future = new Date(Date.now() + 60_000);
    const { fetch } = fakeFetch([
      {
        status: 429,
        headers: { 'retry-after': future.toUTCString() },
        body: JSON.stringify({ error: { message: 'slow down' } }),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toSatisfy((err: unknown) => {
      if (!isLLMError(err, 'rateLimited')) return false;
      // HTTP-dates are second-precision (RFC 9110 §5.6.7), so compare at
      // that granularity rather than to the millisecond.
      expect(Math.floor((err.details.resetDate?.getTime() ?? 0) / 1000)).toBe(
        Math.floor(future.getTime() / 1000)
      );
      return true;
    });
  });

  it('400 maps to invalidRequest', async () => {
    const { fetch } = fakeFetch([
      { status: 400, body: JSON.stringify({ error: { message: 'bad field' } }) },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'invalidRequest' });
  });

  it('422 maps to invalidRequest', async () => {
    const { fetch } = fakeFetch([
      { status: 422, body: JSON.stringify({ error: { message: 'bad field' } }) },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'invalidRequest' });
  });

  it('400 with a context-length message maps to contextOverflow instead', async () => {
    const { fetch } = fakeFetch([
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "This model's maximum context length is 4096 tokens." },
        }),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'contextOverflow' });
  });

  it('401 maps to invalidRequest (auth misconfiguration is a caller mistake)', async () => {
    const { fetch } = fakeFetch([
      { status: 401, body: JSON.stringify({ error: { message: 'invalid api key' } }) },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'invalidRequest' });
  });

  it('403 maps to invalidRequest', async () => {
    const { fetch } = fakeFetch([
      { status: 403, body: JSON.stringify({ error: { message: 'forbidden' } }) },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'invalidRequest' });
  });

  it('5xx maps to network with status', async () => {
    const { fetch } = fakeFetch([
      { status: 503, body: JSON.stringify({ error: { message: 'unavailable' } }) },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({
      code: 'network',
      details: { status: 503 },
    });
  });

  it('a fetch/TypeError network failure maps to network', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const provider = createOpenAIProvider({
      baseUrl: BASE,
      model: 'm',
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('an unrecognised status still maps through toLLMError territory as network, never unclassified', async () => {
    const { fetch } = fakeFetch([
      { status: 418, body: JSON.stringify({ error: { message: "I'm a teapot" } }) },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('never leaks response body content verbatim from a JSON error payload beyond its own message field', async () => {
    const { fetch } = fakeFetch([
      {
        status: 400,
        body: JSON.stringify({
          error: { message: 'bad request' },
          secretField: 'user prompt echoed here',
        }),
      },
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toSatisfy((err: unknown) => {
      if (!isLLMError(err)) return false;
      expect(err.message).not.toContain('secretField');
      expect(err.message).not.toContain('user prompt echoed here');
      return true;
    });
  });
});

describe('config validation', () => {
  it('throws invalidRequest when baseUrl is missing', () => {
    expect(() => createOpenAIProvider({ baseUrl: '', model: 'm' })).toThrow();
  });

  it('throws invalidRequest when model is missing', () => {
    expect(() => createOpenAIProvider({ baseUrl: BASE, model: '' })).toThrow();
  });
});

describe('tool calling: advertised as unsupported, and rejected as such', () => {
  const toolRequest = {
    messages: [{ role: 'user' as const, content: 'weather?' }],
    tools: [
      {
        name: 'getWeather',
        description: 'Current weather for a city.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        execute: () => 'sunny',
      },
    ],
  };

  it('reports tools: false', async () => {
    const { fetch } = fakeFetch([]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(provider.capabilities()).resolves.toMatchObject({ tools: false });
  });

  it('rejects a request carrying tools instead of answering without them', async () => {
    const { fetch, requests } = fakeFetch([]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });

    const error = await provider.generate(toolRequest).catch((e: unknown) => e);
    expect(isLLMError(error, 'invalidRequest')).toBe(true);
    expect((error as Error).message).toMatch(/does not support tool calling/);

    const streamError = await drain(provider.stream(toolRequest)).catch((e: unknown) => e);
    expect(isLLMError(streamError, 'invalidRequest')).toBe(true);

    // The point of rejecting: no request was sent, so the model never answered
    // a tool-shaped question without its tools.
    expect(requests).toHaveLength(0);
  });

  it('still accepts a request with an empty tools array', async () => {
    const { fetch } = fakeFetch([
      jsonResponse({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      }),
    ]);
    const provider = createOpenAIProvider({ baseUrl: BASE, model: 'm', fetch });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }], tools: [] })
    ).resolves.toMatchObject({ text: 'hi' });
  });
});
