/**
 * Tool calling — the request-side types.
 *
 * The seam (DECISIONS.md D24): **a tool is a definition plus a handler, and
 * both live on the request.** `GenerateRequest.tools` carries
 * `{ name, description, parameters, execute }`, where `execute` is the
 * function the provider calls when the model asks for that tool.
 *
 * The alternatives, and why not:
 *
 * - *Handlers configured on the provider* (`createAppleProvider({ tools })`).
 *   Tools are a property of a conversation, not of a model: a chat screen and
 *   a background summarizer share one provider and need different tools. It
 *   also breaks the Phase 4 router, where the provider that ends up answering
 *   is chosen per request.
 * - *Definitions on the request, handlers in a parallel map passed as an
 *   option.* Two structures to keep in sync, and the failure mode — a
 *   definition with no matching handler — is discovered mid-generation,
 *   with a tool call already in flight.
 *
 * Keeping them together makes "every tool the model can see has something to
 * run" checkable before the request starts, which is what the Apple provider's
 * `buildNativeRequest` does — one rejection, at the call site, naming the tool.
 *
 * `execute` is optional on the type because a definition is still meaningful
 * without one: a cloud provider that round-trips tool calls to the caller, or
 * a request serialized for logging, has a name/description/parameters and no
 * function. Providers that *run* tools require either `execute` or
 * {@link RequestOptions.onToolCall} and reject the request otherwise.
 */

import type { JsonSchema } from './generation';

/** What a provider hands a tool handler when the model calls it. */
export interface ToolCall {
  /**
   * Identifies this call. Unique per call, not per tool: the model may have
   * two calls to the same tool in flight at once, and the id is what routes
   * each reply back to the right one.
   */
  readonly callId: string;
  readonly toolName: string;
  /**
   * Arguments as parsed from the model's output, typed `unknown` because no
   * provider can guarantee they match `parameters` — validate them in the
   * handler if it matters.
   */
  readonly arguments: unknown;
  /**
   * Aborts when the request is cancelled or the tool call is abandoned
   * (timeout). A handler doing real work — a fetch, a database read — should
   * pass this along, because a reply after the abort is discarded.
   */
  readonly signal: AbortSignal;
}

/**
 * Runs one tool call.
 *
 * The return value is converted to text for the model: a string is passed
 * through unchanged, anything else is `JSON.stringify`d. Returning `undefined`
 * sends an empty result, which the model usually reads as "the tool had
 * nothing to say" — prefer an explicit value.
 *
 * Throwing fails the whole request with the original error preserved as the
 * `LLMError`'s `cause`. That is deliberate: a tool that cannot answer has
 * derailed the generation, and a provider that swallowed the error would leave
 * the model to invent the missing fact.
 */
export type ToolExecutor = (call: ToolCall) => unknown | Promise<unknown>;

/** A tool the model may call during a request. */
export interface ToolDefinition {
  /**
   * Identifier the model uses to call it. Must be unique within a request;
   * keep it short and descriptive (`getWeather`, `lookupLesson`).
   */
  readonly name: string;
  /**
   * What the tool does and when to use it, in a sentence or two. This is
   * prompt text — the model chooses tools by reading it — so it earns its
   * tokens.
   */
  readonly description: string;
  /**
   * JSON Schema for the arguments, normalized by the same rules as
   * `GenerateRequest.schema` (`normalizeJsonSchema`). An object schema in
   * practice: the model fills in named parameters.
   */
  readonly parameters: JsonSchema;
  /** The handler. See {@link ToolExecutor}. */
  readonly execute?: ToolExecutor;
}
