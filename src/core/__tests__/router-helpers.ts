/**
 * Test doubles the router needs that `MockProvider` deliberately does not
 * offer: a provider that counts how often it is introspected (for the cache
 * TTL tests), one that emits arbitrary `StreamEvent`s (for `toolCall`), and
 * one that can be prewarmed.
 *
 * Kept out of `mock-provider.ts` on purpose — these exist to test the router,
 * not to be part of the package's public testing surface.
 */

import type { Availability } from '../availability';
import { UNKNOWN, type Capabilities } from '../capabilities';
import type { LLMError } from '../errors';
import type { GenerateRequest, GenerateResult } from '../generation';
import type { Message } from '../messages';
import type { LLMProvider, RequestOptions } from '../provider';
import type { StreamEvent } from '../stream';

/** Counts of the introspection calls a router makes. */
export interface IntrospectionCounts {
  availability: number;
  capabilities: number;
}

/** Wrap a provider so every `availability()`/`capabilities()` call is counted. */
export function countingProvider(inner: LLMProvider): {
  provider: LLMProvider;
  counts: IntrospectionCounts;
} {
  const counts: IntrospectionCounts = { availability: 0, capabilities: 0 };
  const provider: LLMProvider = {
    id: inner.id,
    availability: () => {
      counts.availability += 1;
      return inner.availability();
    },
    capabilities: () => {
      counts.capabilities += 1;
      return inner.capabilities();
    },
    generate: (request, options) => inner.generate(request, options),
    stream: (request, options) => inner.stream(request, options),
  };
  const counter = inner.countTokens;
  if (counter !== undefined) {
    provider.countTokens = (messages) => counter.call(inner, messages);
  }
  return { provider, counts };
}

/** Options for {@link stubProvider}. */
export interface StubProviderOptions {
  readonly id: string;
  readonly availability?: Availability;
  readonly capabilities?: Partial<Capabilities>;
  /** Events to emit from `stream()`, before {@link error}. */
  readonly events?: readonly StreamEvent[];
  /** Thrown from `stream()` after the events, and from `generate()` immediately. */
  readonly error?: LLMError;
  /** What `generate()` resolves to when there is no {@link error}. */
  readonly text?: string;
  /** Present only when supplied — the router's `prewarm` presence depends on it. */
  readonly prewarm?: (messages?: readonly Message[]) => Promise<boolean>;
  /** Present only when supplied. */
  readonly countTokens?: (messages: readonly Message[]) => Promise<number>;
}

/** A provider with full control over the events it emits. */
export function stubProvider(options: StubProviderOptions): LLMProvider {
  const capabilities: Capabilities = {
    contextWindow: 4096,
    streaming: true,
    structuredOutput: true,
    tools: true,
    tokenCounting: options.countTokens === undefined ? 'none' : 'exact',
    locales: UNKNOWN,
    ...options.capabilities,
  };
  const result = (): GenerateResult => ({
    text: options.text ?? '',
    finishReason: 'stop',
    providerId: options.id,
  });

  const provider: LLMProvider = {
    id: options.id,
    async availability(): Promise<Availability> {
      return options.availability ?? { available: true };
    },
    async capabilities(): Promise<Capabilities> {
      return capabilities;
    },
    async generate(_request: GenerateRequest, _options?: RequestOptions): Promise<GenerateResult> {
      if (options.error !== undefined) throw options.error;
      return result();
    },
    async *stream(): AsyncGenerator<StreamEvent, void, undefined> {
      for (const event of options.events ?? []) {
        yield event;
      }
      if (options.error !== undefined) throw options.error;
      yield { type: 'finish', result: result() };
    },
  };
  if (options.prewarm !== undefined) provider.prewarm = options.prewarm;
  if (options.countTokens !== undefined) provider.countTokens = options.countTokens;
  return provider;
}

/** Drain a stream into an array, letting failures throw. */
export async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The text deltas of a stream, for terse assertions. */
export function deltas(events: readonly StreamEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'textDelta' ? [event.delta] : []));
}
