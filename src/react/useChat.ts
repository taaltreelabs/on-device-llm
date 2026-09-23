/**
 * `useChat` — a multi-turn conversation wired to `fitContext` and
 * `LLMProvider.stream`.
 *
 * Isolation: `react` only (see `useAvailability.ts`'s module doc for why
 * `react-native` cannot appear here).
 *
 * ### Design decisions worth knowing before reading the implementation
 *
 * - **No `schema` option.** `useChat` accumulates a text transcript
 *   (`messages`/`streamingText`); a schema request answers with `object`
 *   instead of (or in addition to) `text` (src/core/generation.ts), which
 *   has no natural place in a message list. An app that wants one schema-
 *   shaped turn inside an otherwise free-text conversation should reach for
 *   `useGenerate` for that one call — `tools` stays here because a tool
 *   call is a means to a text answer, not an alternative to one.
 * - **`send()` returns a `Promise<void>` that resolves when the turn ends**
 *   (assistant message appended, or the error/cancelled path taken) rather
 *   than firing-and-forgetting. This lets a caller `await send(text)` when it
 *   wants to (e.g. to chain a follow-up action), while `status`/`error`
 *   remain the source of truth for anything UI-driven.
 * - **A second `send()` while one is in flight rejects** with an
 *   `invalidRequest` `LLMError`, synchronously discoverable via a rejected
 *   promise, rather than being silently ignored or queued. Silently ignoring
 *   it hides a bug (a double-tapped send button that the UI failed to
 *   disable); queuing it invents an ordering guarantee this hook does not
 *   want to own. A UI that already disables its send affordance while
 *   `status !== 'idle'` will never see this in practice.
 * - **`stop()` does not set `error`.** An aborted turn always resolves the
 *   `send()` promise (never rejects it) and always reports `code: 'cancelled'`
 *   internally, but that code is swallowed rather than surfaced as `error` —
 *   the user asked for the cancellation, so it is not a failure to report.
 *   `reset()`'s implicit abort of an in-flight turn follows the same rule.
 * - **Partial streamed text survives an error or cancellation.** `finish`
 *   never arrives for a failed/cancelled stream (src/core/stream.ts), so
 *   there is no "final" text to fall back to, and discarding the partial
 *   text a user has already been watching stream in is worse than leaving it
 *   on screen. `streamingText` is therefore left exactly as it was at the
 *   moment of failure/cancellation — `status` returns to `'idle'`, so a
 *   caller can tell the turn is over — and is only cleared by the next
 *   `send()` or by `reset()`.
 * - **On error, the user message stays in history and no assistant message
 *   is appended.** The user's turn happened; re-sending it should not be
 *   required. Appending a synthetic assistant message (an error bubble)
 *   would be presentation, which belongs to the app, not this hook.
 * - **The system prompt is pinned twice over**: constructed with
 *   `pinned: true` explicitly, on top of `fitContext`'s own
 *   `pinSystemMessages: 'first'` default (src/core/context/fit.ts) which
 *   would pin it anyway. Belt and braces costs nothing here and survives a
 *   caller overriding `context.pinSystemMessages`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ContextStrategyName,
  ContextWarning,
  FitContextOptions,
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  Message,
  RequestOptions,
  ToolDefinition,
  ToolExecutor,
  UnknownValue,
} from '../core';
import { fitContext, LLMError, toLLMError } from '../core';

/** Where a turn is in its lifecycle. */
export type UseChatStatus = 'idle' | 'preparing' | 'streaming';

/** Options for {@link useChat}. */
export interface UseChatOptions {
  /** The provider (or router — a router is an `LLMProvider` too) this conversation talks to. */
  readonly provider: LLMProvider;
  /**
   * Sent as a pinned `system` message ahead of history on every turn. Not
   * itself part of the `messages` this hook returns — it is a standing
   * instruction, not a turn anyone took.
   */
  readonly systemPrompt?: string;
  /**
   * Passed through to `fitContext` (src/core/context/fit.ts), minus
   * `provider` and `signal`, which this hook supplies itself. Covers the
   * trimming strategy, budget knobs (`reservedForOutput`, `safetyMargin`),
   * the app-owned `systemState` slot, and everything else `fitContext`
   * takes — kept as a re-export of that type rather than a hand-picked
   * subset so new `fitContext` options are available here automatically.
   */
  readonly context?: Omit<FitContextOptions, 'provider' | 'signal'>;
  /** Tools the model may call while answering. See the module doc for why there is no `schema` option. */
  readonly tools?: readonly ToolDefinition[];
  /** Fallback handler for any tool in `tools` that has no `execute` of its own (`RequestOptions.onToolCall`). */
  readonly onToolCall?: ToolExecutor;
  /** Sampling temperature, passed straight to `GenerateRequest.temperature`. */
  readonly temperature?: number;
  /** Passed straight to `GenerateRequest.maxOutputTokens`. */
  readonly maxOutputTokens?: number;
  /**
   * Called for every non-cancelled failure, in addition to `error` being
   * set. Useful for toast/telemetry side effects that should not live in a
   * render.
   */
  readonly onError?: (error: LLMError) => void;
}

/**
 * `fitContext`'s metadata, trimmed to what a chat UI actually renders (a
 * debug line like "sent 4 of 9 messages"). See `FitContextResult`
 * (src/core/context/result.ts) for the full shape if more is needed —
 * `context.provider` isn't exposed here since the caller already has it.
 */
export interface ChatFitSummary {
  /** How many messages were actually sent to the provider this turn. */
  readonly sentCount: number;
  /** How many messages (including the pinned system prompt, if any) were considered. */
  readonly historyCount: number;
  /** Messages dropped to fit the budget, in original order. */
  readonly dropped: readonly Message[];
  /** Non-fatal problems from this pass (e.g. an unknown context window). */
  readonly warnings: readonly ContextWarning[];
  /** Whether the sent messages are known to fit a real budget. */
  readonly withinBudget: true | UnknownValue;
  /** Which trimming strategy ran. */
  readonly strategy: ContextStrategyName;
}

/** Result of {@link useChat}. */
export interface UseChatResult {
  /**
   * The full conversation this hook owns: every completed user and
   * assistant turn, oldest first. Does not include the system prompt (see
   * `UseChatOptions.systemPrompt`) or the in-flight assistant turn (see
   * {@link streamingText}).
   */
  readonly messages: readonly Message[];
  /**
   * The assistant's text so far for the turn currently in flight, or
   * `undefined` when there is none. Also holds the last turn's partial text
   * after an error or cancellation — see the module doc's "partial text
   * survives" note — until the next `send()` or `reset()`.
   */
  readonly streamingText: string | undefined;
  readonly status: UseChatStatus;
  /** Set on a non-cancelled failure; cleared at the start of the next `send()` and by `reset()`. */
  readonly error: LLMError | undefined;
  /** `fitContext`'s report for the most recent turn, or `undefined` before the first `send()`. */
  readonly lastFit: ChatFitSummary | undefined;
  /**
   * Append `text` as a user turn and run one assistant turn against it.
   * Resolves when the turn ends (successfully, on error, or cancelled — see
   * the module doc). Rejects only when called while another `send()` is
   * still in flight.
   */
  readonly send: (text: string) => Promise<void>;
  /** Abort the in-flight turn, if any. A no-op otherwise. */
  readonly stop: () => void;
  /** Abort any in-flight turn and clear `messages`, `streamingText`, `error`, and `lastFit`. */
  readonly reset: () => void;
}

function summarizeFit(
  fitted: Awaited<ReturnType<typeof fitContext>>,
  historyCount: number
): ChatFitSummary {
  return {
    sentCount: fitted.messages.length,
    historyCount,
    dropped: fitted.dropped,
    warnings: fitted.warnings,
    withinBudget: fitted.withinBudget,
    strategy: fitted.strategy,
  };
}

/** See the module doc for the behavioural decisions this hook makes. */
export function useChat(options: UseChatOptions): UseChatResult {
  const {
    provider,
    systemPrompt,
    context,
    tools,
    onToolCall,
    temperature,
    maxOutputTokens,
    onError,
  } = options;

  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [streamingText, setStreamingText] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<UseChatStatus>('idle');
  const [error, setError] = useState<LLMError | undefined>(undefined);
  const [lastFit, setLastFit] = useState<ChatFitSummary | undefined>(undefined);

  // Mirrors `messages` synchronously so `send()` can read "history plus the
  // turn just appended" without waiting on a re-render (React may batch or
  // defer the `useState` updater).
  const messagesRef = useRef<readonly Message[]>([]);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    },
    []
  );

  const setMessagesBoth = useCallback((next: readonly Message[]): void => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const runTurn = useCallback(
    async (text: string): Promise<void> => {
      busyRef.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      setStatus('preparing');
      setError(undefined);

      const userMessage: Message = { role: 'user', content: text };
      const nextHistory = [...messagesRef.current, userMessage];
      setMessagesBoth(nextHistory);

      const systemMessage: Message | undefined =
        systemPrompt !== undefined
          ? { role: 'system', content: systemPrompt, pinned: true }
          : undefined;
      const conversation: readonly Message[] =
        systemMessage !== undefined ? [systemMessage, ...nextHistory] : nextHistory;

      try {
        const fitted = await fitContext(conversation, {
          ...context,
          provider,
          signal: controller.signal,
        });

        if (!mountedRef.current) return;
        setLastFit(summarizeFit(fitted, conversation.length));
        setStatus('streaming');
        setStreamingText('');

        const request: GenerateRequest = {
          messages: fitted.messages,
          ...(tools !== undefined ? { tools } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        };
        const requestOptions: RequestOptions = {
          signal: controller.signal,
          ...(onToolCall !== undefined ? { onToolCall } : {}),
        };

        let accumulated = '';
        let finishResult: GenerateResult | undefined;
        for await (const event of provider.stream(request, requestOptions)) {
          if (event.type === 'textDelta') {
            accumulated += event.delta;
            if (mountedRef.current) setStreamingText(accumulated);
          } else if (event.type === 'finish') {
            finishResult = event.result;
          }
          // 'objectSnapshot' and 'toolCall' are ignored: useChat is text-only
          // (see the module doc), and a tool call is observability-only
          // (src/core/stream.ts) with nothing for this hook to do about it.
        }

        if (!mountedRef.current) return;

        const finalText = finishResult?.text ?? accumulated;
        const assistantMessage: Message = { role: 'assistant', content: finalText };
        setMessagesBoth([...messagesRef.current, assistantMessage]);
        setStreamingText(undefined);
        setStatus('idle');
      } catch (thrown) {
        if (!mountedRef.current) return;
        const llmError = toLLMError(thrown, { providerId: provider.id });
        setStatus('idle');
        // Cancelled: no `error` (see module doc); partial `streamingText` is
        // left as-is either way, and no assistant message is appended.
        if (llmError.code !== 'cancelled') {
          setError(llmError);
          onError?.(llmError);
        }
      } finally {
        busyRef.current = false;
        if (controllerRef.current === controller) controllerRef.current = undefined;
      }
    },
    [
      provider,
      systemPrompt,
      context,
      tools,
      onToolCall,
      temperature,
      maxOutputTokens,
      onError,
      setMessagesBoth,
    ]
  );

  const send = useCallback(
    (text: string): Promise<void> => {
      if (busyRef.current) {
        return Promise.reject(
          new LLMError(
            { code: 'invalidRequest' },
            {
              providerId: provider.id,
              message:
                'useChat: send() was called while a turn is already in flight. Await the previous send(), or call stop() first.',
            }
          )
        );
      }
      return runTurn(text);
    },
    [provider, runTurn]
  );

  const stop = useCallback((): void => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback((): void => {
    controllerRef.current?.abort();
    busyRef.current = false;
    setMessagesBoth([]);
    setStreamingText(undefined);
    setStatus('idle');
    setError(undefined);
    setLastFit(undefined);
  }, [setMessagesBoth]);

  return { messages, streamingText, status, error, lastFit, send, stop, reset };
}
