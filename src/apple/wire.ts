/**
 * Conversions between the native wire shapes and `core`'s types, plus the
 * request validation that happens *before* anything crosses the bridge.
 *
 * Validating here rather than in Swift is deliberate (docs/plan.md §1, "when
 * a design choice trades native code for TypeScript, prefer TypeScript"): the
 * rules are unit-testable in Node, a rejected request costs no bridge hop,
 * and the error message can be as long and specific as it needs to be.
 * `ios/Core` repeats the structural checks as a backstop, not as the primary
 * gate.
 */

import {
  LLMError,
  type FinishReason,
  type GenerateRequest,
  type Message,
  type TokenUsage,
} from '../core';
import type { NativeUsage } from './native/types';

const FINISH_REASONS: readonly FinishReason[] = [
  'stop',
  'length',
  'guardrail',
  'refusal',
  'cancelled',
  'toolCalls',
  'other',
];

/** A native finish-reason string, validated. Anything unrecognised is `'other'`. */
export function toFinishReason(value: string | undefined): FinishReason {
  return FINISH_REASONS.includes(value as FinishReason) ? (value as FinishReason) : 'other';
}

/** Native usage -> `TokenUsage`, or `undefined` when nothing was reported. */
export function toTokenUsage(usage: NativeUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined;
  const mapped: TokenUsage = {
    ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
    ...(typeof usage.cachedInputTokens === 'number'
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(typeof usage.reasoningTokens === 'number'
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function invalid(message: string, providerId: string): LLMError {
  return new LLMError({ code: 'invalidRequest' }, { message, providerId });
}

/** The validated, bridge-ready form of a request. */
export interface NativeRequestArgs {
  readonly messages: { readonly role: string; readonly content: string }[];
  readonly temperature: number | null;
  readonly maxOutputTokens: number | null;
}

/**
 * Validate a `GenerateRequest` and flatten it for the bridge.
 *
 * Rejections, and why each one is `invalidRequest` (never retried, never
 * failed over — it will fail the same way next time):
 *
 * - **`schema`**: structured output is Phase 3 step 6. Silently ignoring it
 *   would hand the caller free-form prose where they asked for an object,
 *   which is the failure mode docs/plan.md §4 explicitly warns against.
 * - **empty `messages`**, or **no user message**: there is nothing to respond
 *   to.
 * - **a conversation not ending in a `user` message**: the framework has no
 *   "continue your own last message" affordance. See DECISIONS.md D17 and
 *   `ios/Core/TranscriptBuilder.swift` for the transcript/prompt split this
 *   falls out of.
 * - **a non-finite `temperature`** or a **non-positive, non-integer
 *   `maxOutputTokens`**: `GenerationOptions` would take them and misbehave
 *   later, further from the cause.
 */
export function buildNativeRequest(
  request: GenerateRequest,
  providerId: string
): NativeRequestArgs {
  if (request.schema !== undefined) {
    throw invalid(
      'The Apple provider does not support structured output yet (Phase 3 step 6). ' +
        'Remove `schema`, or route this request to a provider that supports it.',
      providerId
    );
  }

  const messages = request.messages;
  if (messages.length === 0) {
    throw invalid('`messages` is empty; there is nothing to respond to.', providerId);
  }

  const turns = messages.filter((message: Message) => message.role !== 'system');
  if (turns.length === 0) {
    throw invalid(
      'The request contains only system messages; the Apple provider needs a user message to respond to.',
      providerId
    );
  }
  const last = turns[turns.length - 1]!;
  if (last.role !== 'user') {
    throw invalid(
      'The Apple provider requires the conversation to end with a user message; this one ends ' +
        `with a ${last.role} message. Apple's FoundationModels session has no way to continue an ` +
        'assistant turn (DECISIONS.md D17).',
      providerId
    );
  }

  if (request.temperature !== undefined && !Number.isFinite(request.temperature)) {
    throw invalid(
      `\`temperature\` must be a finite number, got ${request.temperature}.`,
      providerId
    );
  }
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
  ) {
    throw invalid(
      `\`maxOutputTokens\` must be a positive integer, got ${request.maxOutputTokens}.`,
      providerId
    );
  }

  return {
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    temperature: request.temperature ?? null,
    maxOutputTokens: request.maxOutputTokens ?? null,
  };
}

let requestCounter = 0;

/**
 * A request id unique within this JS context.
 *
 * Not a UUID: `crypto.randomUUID` is not guaranteed in every React Native
 * runtime and this package has no runtime dependencies. The id only has to be
 * unique among *this* app's in-flight requests, which a monotonic counter
 * already guarantees; the timestamp and random suffix just keep ids
 * distinguishable in logs across reloads.
 */
export function nextRequestId(): string {
  requestCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `apple-${Date.now().toString(36)}-${requestCounter}-${random}`;
}
