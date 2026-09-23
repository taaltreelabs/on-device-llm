/**
 * A scriptable `LLMProvider` for tests.
 *
 * Used by this package's own tests and by every later phase — the Phase 2
 * context manager and the Phase 4 router are tested entirely against it, and
 * app developers can use it to test their code without a device or a network
 * (docs/plan.md §5, Phase 1).
 *
 * The scripting surface is deliberately tiny: a queue of turns, each one
 * either a result, an error, or a stream. One turn is consumed per
 * `generate()`/`stream()` call, in order. Anything a turn does not specify
 * gets a sensible default, so the common case is a one-liner:
 *
 * ```ts
 * const provider = new MockProvider({ turns: [{ type: 'result', text: 'hi' }] });
 * ```
 */

import type { Availability } from './availability';
import { UNKNOWN, type Capabilities } from './capabilities';
import { LLMError } from './errors';
import type { FinishReason, GenerateRequest, GenerateResult, TokenUsage } from './generation';
import type { Message } from './messages';
import type { LLMProvider, RequestOptions } from './provider';
import type { StreamEvent } from './stream';

/** One chunk of a scripted stream. A bare string is shorthand for `{ text }`. */
export interface MockStreamChunk {
  /** The delta to emit. */
  readonly text: string;
  /**
   * Wait this long before emitting. Omit (the default) for an immediate
   * chunk — tests stay fast, and the delay is only needed when the test is
   * specifically about timing or about aborting between chunks.
   */
  readonly delayMs?: number;
}

/** Return a complete response. */
export interface MockResultTurn {
  readonly type: 'result';
  /** Response text. Defaults to `''`. */
  readonly text?: string;
  /** Structured output, as if the request carried a schema. */
  readonly object?: unknown;
  /** Defaults to `'stop'`. */
  readonly finishReason?: FinishReason;
  /** Reported token usage. Omitted by default, like a provider that cannot report it. */
  readonly usage?: TokenUsage;
  /** Wait this long before answering — lets a test abort mid-`generate()`. */
  readonly delayMs?: number;
}

/** Fail the call. */
export interface MockErrorTurn {
  readonly type: 'error';
  /** Thrown as-is, so tests assert on exactly the error they scripted. */
  readonly error: LLMError;
  /** Wait this long before throwing. */
  readonly delayMs?: number;
}

/** Stream a response chunk by chunk. */
export interface MockStreamTurn {
  readonly type: 'stream';
  /** Deltas, in order. Strings are shorthand for `{ text }`. */
  readonly chunks: readonly (string | MockStreamChunk)[];
  /**
   * Fail *after* emitting the chunks above, instead of finishing. To fail
   * halfway through a response, script the chunks that should arrive first
   * and put the error here — that is the whole mid-stream-failure model, and
   * it avoids an error-position index that would have to stay in sync with
   * the chunk list.
   */
  readonly error?: LLMError;
  /** Emitted as an `objectSnapshot` just before `finish`, for structured-output streams. */
  readonly object?: unknown;
  /** Defaults to `'stop'`. */
  readonly finishReason?: FinishReason;
  /** Reported token usage. */
  readonly usage?: TokenUsage;
}

/** One scripted turn. */
export type MockTurn = MockResultTurn | MockErrorTurn | MockStreamTurn;

/**
 * How `countTokens` should behave:
 * - a number — always return it;
 * - a function — compute it (pass `estimateTokens` for realistic numbers);
 * - an `LLMError` — throw it, reproducing a provider whose counter fails;
 * - omitted — no `countTokens` method at all, and `tokenCounting: 'none'`.
 */
export type MockCountTokens =
  number | ((messages: readonly Message[]) => number | Promise<number>) | LLMError;

/** Construction options for {@link MockProvider}. */
export interface MockProviderOptions {
  /** Provider `id`. Defaults to `'mock'`. */
  readonly id?: string;
  /** The script. More can be appended later with `script()`. */
  readonly turns?: readonly MockTurn[];
  /** What `availability()` reports. Defaults to available. */
  readonly availability?: Availability;
  /** Overrides merged over the defaults returned by `capabilities()`. */
  readonly capabilities?: Partial<Capabilities>;
  /** See {@link MockCountTokens}. */
  readonly countTokens?: MockCountTokens;
}

/** A recorded call, for assertions. */
export interface MockCall {
  /** Which method was called. */
  readonly method: 'generate' | 'stream' | 'countTokens';
  /** The request, for `generate`/`stream`. */
  readonly request?: GenerateRequest;
  /** The messages, for `countTokens`. */
  readonly messages?: readonly Message[];
  /** The signal that was passed, if any — lets a test assert cancellation was wired through. */
  readonly signal?: AbortSignal;
}

function normalizeChunks(
  chunks: readonly (string | MockStreamChunk)[]
): readonly MockStreamChunk[] {
  return chunks.map((chunk) => (typeof chunk === 'string' ? { text: chunk } : chunk));
}

/**
 * `setTimeout` that also loses to an `AbortSignal`, so aborting during a
 * scripted delay rejects immediately instead of after the delay.
 * Web-standard APIs only — no Node timers, no RN specifics.
 */
function sleep(ms: number, signal: AbortSignal | undefined, providerId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelled(signal, providerId));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(cancelled(signal, providerId));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cancelled(signal: AbortSignal | undefined, providerId: string): LLMError {
  return new LLMError({ code: 'cancelled' }, { providerId, cause: signal?.reason });
}

function throwIfAborted(signal: AbortSignal | undefined, providerId: string): void {
  if (signal?.aborted === true) throw cancelled(signal, providerId);
}

/**
 * Scriptable in-memory provider.
 *
 * Behaviour worth knowing:
 *
 * - **Turn reuse across both call paths.** A `result` turn streamed by
 *   `stream()` arrives as one `textDelta` plus `finish`; a `stream` turn
 *   passed to `generate()` is played to completion (delays included) and
 *   returns the concatenated text. So one script exercises both paths, and a
 *   test that switches from `generate` to `stream` needs no rewrite.
 * - **Script exhaustion is an error**, not an empty response: calling once
 *   more than scripted throws `invalidRequest` with a message saying so.
 *   Silently returning `''` hides the bug in the test.
 * - **Abort is honoured before the call, during a delay, and between
 *   chunks**, always as `LLMError` code `cancelled`.
 * - **Errors from `stream()` surface on iteration**, never synchronously
 *   from the call itself — matching the real providers' contract.
 */
export class MockProvider implements LLMProvider {
  readonly id: string;

  /**
   * Present only when `countTokens` was configured — an absent method is the
   * only honest way to model a provider that cannot count, since
   * `LLMProvider.countTokens` is optional.
   */
  readonly countTokens?: (messages: readonly Message[]) => Promise<number>;

  private readonly availabilityValue: Availability;
  private readonly capabilitiesValue: Capabilities;
  private readonly turns: MockTurn[];
  private readonly recorded: MockCall[] = [];

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.turns = [...(options.turns ?? [])];
    this.availabilityValue = options.availability ?? { available: true };

    const counter = options.countTokens;
    this.capabilitiesValue = {
      // A small, believable window: big enough for test conversations, small
      // enough that Phase 2 trimming tests can overflow it on purpose.
      contextWindow: 4096,
      streaming: true,
      structuredOutput: true,
      // Tools land in Phase 3; nothing can honour them yet.
      tools: false,
      tokenCounting: counter === undefined ? 'none' : 'exact',
      // UNKNOWN by default so the unknown-locale branch of consumer code
      // gets exercised unless a test opts into a concrete list.
      locales: UNKNOWN,
      ...options.capabilities,
    };

    if (counter !== undefined) {
      this.countTokens = async (messages: readonly Message[]): Promise<number> => {
        this.recorded.push({ method: 'countTokens', messages });
        if (counter instanceof LLMError) throw counter;
        if (typeof counter === 'number') return counter;
        return counter(messages);
      };
    }
  }

  /** Every call received, in order. */
  get calls(): readonly MockCall[] {
    return this.recorded;
  }

  /** Just the `generate`/`stream` requests, in order — the common assertion. */
  get requests(): readonly GenerateRequest[] {
    return this.recorded
      .map((call) => call.request)
      .filter((request): request is GenerateRequest => request !== undefined);
  }

  /** How many scripted turns are left. */
  get remainingTurns(): number {
    return this.turns.length;
  }

  /** Append turns to the script. Returns `this` for chaining. */
  script(...turns: MockTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  /** Forget every recorded call and drop any unused turns. */
  reset(): void {
    this.recorded.length = 0;
    this.turns.length = 0;
  }

  async availability(): Promise<Availability> {
    return this.availabilityValue;
  }

  async capabilities(): Promise<Capabilities> {
    return this.capabilitiesValue;
  }

  async generate(request: GenerateRequest, options?: RequestOptions): Promise<GenerateResult> {
    const signal = options?.signal;
    this.recorded.push({ method: 'generate', request, signal });
    throwIfAborted(signal, this.id);

    const turn = this.takeTurn();
    if (turn.type === 'stream') {
      let text = '';
      for (const chunk of normalizeChunks(turn.chunks)) {
        if (chunk.delayMs !== undefined) await sleep(chunk.delayMs, signal, this.id);
        throwIfAborted(signal, this.id);
        text += chunk.text;
      }
      if (turn.error !== undefined) throw turn.error;
      return this.toResult({
        text,
        object: turn.object,
        finishReason: turn.finishReason,
        usage: turn.usage,
      });
    }

    if (turn.delayMs !== undefined) await sleep(turn.delayMs, signal, this.id);
    throwIfAborted(signal, this.id);
    if (turn.type === 'error') throw turn.error;
    return this.toResult(turn);
  }

  stream(request: GenerateRequest, options?: RequestOptions): AsyncIterable<StreamEvent> {
    const signal = options?.signal;
    // Recorded (and the turn consumed) at call time rather than on first
    // iteration, so a test can assert the provider "saw" the request even if
    // it never iterates, and so turn order matches call order.
    this.recorded.push({ method: 'stream', request, signal });
    const turn = this.turns.shift();
    return this.play(turn, signal);
  }

  private async *play(
    turn: MockTurn | undefined,
    signal: AbortSignal | undefined
  ): AsyncGenerator<StreamEvent, void, undefined> {
    throwIfAborted(signal, this.id);
    if (turn === undefined) throw this.exhausted();

    if (turn.type === 'error') {
      if (turn.delayMs !== undefined) await sleep(turn.delayMs, signal, this.id);
      throwIfAborted(signal, this.id);
      throw turn.error;
    }

    if (turn.type === 'result') {
      if (turn.delayMs !== undefined) await sleep(turn.delayMs, signal, this.id);
      throwIfAborted(signal, this.id);
      if (turn.text !== undefined && turn.text !== '') {
        yield { type: 'textDelta', delta: turn.text };
      }
      if (turn.object !== undefined) yield { type: 'objectSnapshot', snapshot: turn.object };
      yield { type: 'finish', result: this.toResult(turn) };
      return;
    }

    let text = '';
    for (const chunk of normalizeChunks(turn.chunks)) {
      if (chunk.delayMs !== undefined) await sleep(chunk.delayMs, signal, this.id);
      throwIfAborted(signal, this.id);
      text += chunk.text;
      yield { type: 'textDelta', delta: chunk.text };
    }
    if (turn.error !== undefined) throw turn.error;
    throwIfAborted(signal, this.id);
    if (turn.object !== undefined) yield { type: 'objectSnapshot', snapshot: turn.object };
    yield {
      type: 'finish',
      result: this.toResult({
        text,
        object: turn.object,
        finishReason: turn.finishReason,
        usage: turn.usage,
      }),
    };
  }

  private takeTurn(): MockTurn {
    const turn = this.turns.shift();
    if (turn === undefined) throw this.exhausted();
    return turn;
  }

  private exhausted(): LLMError {
    return new LLMError(
      { code: 'invalidRequest' },
      {
        message: `MockProvider "${this.id}" received a request with no scripted turns left — script one more turn, or assert the extra call away.`,
        providerId: this.id,
      }
    );
  }

  private toResult(turn: {
    readonly text?: string;
    readonly object?: unknown;
    readonly finishReason?: FinishReason;
    readonly usage?: TokenUsage;
  }): GenerateResult {
    return {
      text: turn.text ?? '',
      ...(turn.object !== undefined ? { object: turn.object } : {}),
      finishReason: turn.finishReason ?? 'stop',
      ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
      providerId: this.id,
    };
  }
}
