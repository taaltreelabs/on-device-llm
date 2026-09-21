/**
 * Chat Completions wire shapes and the mapping between them and `core`'s
 * provider-neutral types.
 *
 * Typed loosely (lots of optional fields) on purpose: every real server —
 * `fm serve`, a hosted OpenAI-compatible endpoint, a proxy in front of
 * either — omits or renames fields differently, and this provider's job is
 * to be lenient about what it reads while being strict about what it sends.
 */

import {
  LLMError,
  type FinishReason,
  type JsonSchema,
  type Message,
  type TokenUsage,
} from '../core';

/** A single message as sent on the wire. */
export interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** The JSON body of a Chat Completions request. */
export interface ChatCompletionRequestBody {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly stream: boolean;
  readonly stream_options?: { readonly include_usage: true };
  readonly response_format?: {
    readonly type: 'json_schema';
    readonly json_schema: {
      readonly name: string;
      readonly strict: true;
      readonly schema: JsonSchema;
    };
  };
  readonly temperature?: number;
  readonly max_tokens?: number;
}

interface WireUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
}

/** The JSON body of a non-streaming Chat Completions response. */
export interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: WireUsage;
}

/** One `data:` payload of a streaming Chat Completions response. */
export interface ChatCompletionChunk {
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: WireUsage;
}

/**
 * Map a `core` message onto the wire shape.
 *
 * `MessageRole` is documented as an open union (Phase 3 adds `'tool'`) —
 * per `core/messages.ts`, an unrecognised role must throw `invalidRequest`
 * rather than silently drop the message, since a dropped turn corrupts the
 * conversation the server sees.
 */
export function mapMessage(message: Message, providerId: string): WireMessage {
  switch (message.role) {
    case 'system':
    case 'user':
    case 'assistant':
      return { role: message.role, content: message.content };
    default:
      throw new LLMError(
        { code: 'invalidRequest' },
        {
          providerId,
          message: `openai provider does not support message role "${String(message.role)}"`,
        }
      );
  }
}

/** Map a Chat Completions `finish_reason` onto `core`'s `FinishReason`. */
export function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'guardrail';
    default:
      return 'other';
  }
}

/** Map wire `usage` onto `core`'s `TokenUsage`. Absent fields stay absent — never defaulted to `0` (see `core/generation.ts`). */
export function mapUsage(usage: WireUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined;
  const result: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof usage.prompt_tokens === 'number') result.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') result.outputTokens = usage.completion_tokens;
  if (result.inputTokens === undefined && result.outputTokens === undefined) return undefined;
  return result;
}

/**
 * Parse a model's structured-output text as JSON.
 *
 * Failure here means the *model* produced malformed JSON despite a
 * `response_format` constraint, not that the caller's request was wrong —
 * so this maps to `unknown` (never `invalidRequest`, which the taxonomy
 * reserves for requests that will fail again unchanged) and the raw text is
 * attached only to `cause`, never folded into the error `message` (see
 * `LLMErrorOptions.message` doc: "must not contain prompt or response
 * content").
 */
export function parseStructuredOutput(text: string, providerId: string): unknown {
  try {
    return JSON.parse(text);
  } catch (parseError) {
    throw new LLMError(
      { code: 'unknown' },
      {
        providerId,
        message: "The model's structured output could not be parsed as JSON",
        cause: { parseError, rawText: text },
      }
    );
  }
}
