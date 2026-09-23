/**
 * Request and result shapes for a single generation.
 *
 * Deliberately Chat-Completions-shaped (docs/plan.md §2, DECISIONS.md D1):
 * a flat request carrying the full message list, a flat result carrying text
 * and/or a parsed object. Everything optional is optional because at least
 * one real provider cannot supply it.
 */

import type { Message } from './messages';
import type { ToolDefinition } from './tools';

/**
 * A JSON Schema document describing the shape of structured output.
 *
 * Typed loosely on purpose. `core` has zero runtime dependencies (no schema
 * library) and the *authoritative* validation happens where the constraint
 * actually lives: per DECISIONS.md D6 the Apple provider normalizes and
 * validates the developer's schema in TypeScript against the subset Apple's
 * `GenerationSchema` can decode (objects, arrays, strings, numbers,
 * booleans, enums, optional fields, nesting; `title`,
 * `additionalProperties`, `required`, `x-order`), and rejects anything else
 * loudly as `invalidRequest` rather than silently dropping constraints. A
 * cloud provider will accept a wider subset. Encoding one provider's subset
 * in the shared type would be wrong for the other, so the type stays open
 * and the rejection is a runtime error with a clear message.
 *
 * The index signature keeps vendor extensions (`x-order`) and
 * not-yet-modelled keywords assignable without casts.
 */
export interface JsonSchema {
  /** JSON Schema `type`. Structured output roots are normally `'object'`. */
  readonly type?: string;
  /** Human-readable name. Apple's `GenerationSchema` decode requires it on the root. */
  readonly title?: string;
  /** Description passed through to the model as guidance. */
  readonly description?: string;
  /** Property schemas, for `type: 'object'`. */
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  /** Item schema, for `type: 'array'`. */
  readonly items?: JsonSchema;
  /** Required property names, for `type: 'object'`. */
  readonly required?: readonly string[];
  /** Permitted values, for enums. */
  readonly enum?: readonly unknown[];
  /** Whether unlisted properties are allowed. */
  readonly additionalProperties?: boolean;
  /** Any other JSON Schema (or vendor `x-`) keyword. */
  readonly [keyword: string]: unknown;
}

/**
 * Why generation stopped.
 *
 * - `stop` — the model finished normally.
 * - `length` — hit `maxOutputTokens`, or ran out of context window while
 *   generating. Distinguish "too long to even start" from this: that is a
 *   `contextOverflow` error, not a finish reason.
 * - `guardrail` — a safety guardrail cut the response off. Note that a
 *   guardrail that fires *before* any output is an error (`guardrail`), not
 *   a result; this value is for a response that was truncated.
 * - `refusal` — the model declined to answer. Apple models it separately
 *   from a guardrail violation (`LanguageModelError.refusal` vs
 *   `.guardrailViolation`, see docs/research/sdk-surface.md §5) and the
 *   distinction matters to callers: a refusal is model judgement about the
 *   request, a guardrail is a system filter. Collapsing them would throw
 *   away information we are handed for free.
 * - `cancelled` — an `AbortSignal` fired. Only reachable on a stream that
 *   was cancelled after emitting content; an aborted `generate()` throws
 *   `cancelled` instead of returning.
 * - `toolCalls` — the model wants a tool run and is waiting for results.
 *   Reserved for Phase 3; no Phase 1 provider ever produces it. It is
 *   declared now on purpose: adding a union member later would break every
 *   caller's exhaustive `switch`, so the seam is opened while nothing
 *   depends on it.
 * - `other` — a provider-specific reason with no faithful mapping. An
 *   escape hatch so providers never have to lie about `stop`; callers should
 *   treat it as "finished, reason unclear".
 */
export type FinishReason =
  'stop' | 'length' | 'guardrail' | 'refusal' | 'cancelled' | 'toolCalls' | 'other';

/**
 * Token accounting for one generation. Every field is optional because
 * providers disagree about what they can report: a Chat Completions
 * endpoint returns input and output counts, iOS 27 reports all four
 * (`LanguageModelSession.Usage`, docs/research/sdk-surface.md §3), and iOS
 * 26 reports nothing at all.
 *
 * Absent means "not reported", never zero. Do not default missing fields to
 * `0` — `@react-native-ai/apple` hardcodes zeros here and the result is
 * indistinguishable from a real measurement (DECISIONS.md D1).
 */
export interface TokenUsage {
  /** Tokens consumed by the prompt (messages, instructions, schema, tools). */
  readonly inputTokens?: number;
  /** Tokens produced in the response. */
  readonly outputTokens?: number;
  /**
   * Subset of `inputTokens` served from a prefix cache. iOS 27 reports this
   * as `usage.input.cachedTokenCount`; useful for judging whether session
   * reuse is paying off.
   */
  readonly cachedInputTokens?: number;
  /**
   * Subset of `outputTokens` spent on reasoning rather than the visible
   * answer (iOS 27 `usage.output.reasoningTokenCount`).
   */
  readonly reasoningTokens?: number;
}

/**
 * Everything needed to produce one response.
 *
 * FORWARD-COMPAT SEAM: Phase 3 added the optional `tools` field below (and a
 * later phase may add `toolChoice`). Sampling knobs beyond the two below —
 * `topP`/`topK`/`seed`, all expressible against Apple's `SamplingMode`
 * (docs/research/sdk-surface.md §4) — land as sibling optional fields. Both
 * are additive: a request built today stays valid, and a provider written
 * today keeps compiling (it just ignores what it does not know, or rejects
 * it as `invalidRequest` if honouring it matters for correctness).
 */
export interface GenerateRequest {
  /**
   * The full conversation, oldest first. Stateless by design — providers
   * rebuild whatever native session state they need from this list on every
   * request (docs/plan.md §2).
   */
  readonly messages: readonly Message[];
  /**
   * Ask for structured output matching this JSON Schema. Providers that
   * report `capabilities().structuredOutput === false` must reject a
   * request carrying a schema as `invalidRequest` rather than silently
   * returning prose.
   */
  readonly schema?: JsonSchema;
  /**
   * Tools the model may call while answering, each with the handler that runs
   * it (see {@link ToolDefinition}). Providers that report
   * `capabilities().tools === false` must reject a request carrying tools as
   * `invalidRequest` rather than answering without them — a model that was
   * supposed to look something up and instead guessed is the worst of the
   * available outcomes.
   */
  readonly tools?: readonly ToolDefinition[];
  /**
   * Sampling temperature. Range is provider-defined (Apple takes a
   * `Double`, OpenAI-compatible endpoints take 0–2). Omit to use the
   * provider's default rather than guessing a value.
   */
  readonly temperature?: number;
  /**
   * Cap on generated tokens (Apple's `maximumResponseTokens`, OpenAI's
   * `max_tokens`). Does not include input tokens — note that Apple's
   * `contextSize` is a *combined* input+output budget, which is why the
   * Phase 2 context manager reserves output space out of the same window.
   */
  readonly maxOutputTokens?: number;
  /**
   * What kind of work this is — `'simple'`, `'reasoning'`, `'translate'`,
   * whatever vocabulary your app routes on.
   *
   * **Read by the Phase 4 router only. Every provider must ignore it**, and in
   * particular must not reject a request for carrying one: it is routing
   * metadata, not a generation parameter, and a request that has been routed
   * arrives at its provider with the tag still attached.
   *
   * It lives here rather than on `RequestOptions` (DECISIONS.md D29) because it
   * describes the *ask*, not the call: it is plain serializable data that
   * belongs with the messages when a request is stored, replayed, or handed
   * down through the context manager and the hooks, whereas `RequestOptions`
   * carries the things that cannot be serialized and change on every
   * invocation — an `AbortSignal` and a tool dispatcher. It stays off
   * `Message` for the same reason inverted: a tag describes the whole request,
   * not one turn of the conversation.
   */
  readonly taskTag?: string;
}

/**
 * The outcome of one generation.
 *
 * `object` is typed `unknown` rather than made generic: the provider
 * interface is implemented by third parties (docs/plan.md §2) and a generic
 * `generate<T>` would promise type safety that no provider can actually
 * enforce — the cast has to happen somewhere, and it is more honest at the
 * call site. Schema-inferred typing is an ergonomics job for the layers
 * above (router, hooks) and can be added there without touching this
 * contract.
 */
export interface GenerateResult {
  /**
   * The response text. Always a string: `''` when the provider returned
   * only structured output, so callers never have to null-check it.
   */
  readonly text: string;
  /**
   * Parsed structured output, present only when the request carried a
   * `schema` and parsing succeeded. A schema request whose output fails to
   * parse is a `guardrail`-style failure of expectations, not a partial
   * success — providers throw (`invalidRequest`, carrying the raw content
   * from Apple's `GeneratedContent.ParsingError`) instead of returning a
   * result with `object` missing.
   */
  readonly object?: unknown;
  /** Why generation stopped. */
  readonly finishReason: FinishReason;
  /** Token accounting, when the provider reports any. */
  readonly usage?: TokenUsage;
  /**
   * `id` of the provider that actually answered. Present on every result so
   * a caller behind a router can tell on-device from cloud
   * (docs/plan.md §2).
   */
  readonly providerId: string;
}
