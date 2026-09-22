/**
 * Consumer's-eye view of the public API: everything is imported from
 * `src/core/index.ts` exactly as a third-party provider author would import
 * it from `@taaltreelabs/on-device-llm/core`.
 */
import { describe, expect, it } from 'vitest';

import {
  LLMError,
  MockProvider,
  UNKNOWN,
  estimateTokens,
  isUnknown,
  normalizeContextWindow,
  type Availability,
  type Capabilities,
  type FinishReason,
  type GenerateRequest,
  type GenerateResult,
  type LLMErrorCode,
  type LLMProvider,
  type Message,
  type MessageRole,
  type RequestOptions,
  type StreamEvent,
  type UnavailableReason,
} from '../index';
import * as core from '../index';

describe('core public API', () => {
  it('exports the runtime surface Phases 1-3 promise, and no default export', () => {
    expect(Object.keys(core).sort()).toEqual([
      'DEFAULT_CHARS_PER_TOKEN',
      'DEFAULT_KEEP_RECENT_TURNS',
      'DEFAULT_MAX_SUMMARY_TOKENS',
      'DEFAULT_PER_MESSAGE_OVERHEAD_TOKENS',
      'DEFAULT_RESERVED_FOR_OUTPUT_TOKENS',
      'DEFAULT_SAFETY_MARGIN_ESTIMATED_TOKENS',
      'DEFAULT_SAFETY_MARGIN_EXACT_TOKENS',
      'DEFAULT_SUMMARY_MARKER',
      'DEFAULT_SUMMARY_THRESHOLD',
      'DEFAULT_SYSTEM_STATE_MARKER',
      'DROPPED_ANNOTATIONS',
      'LLMError',
      'MockProvider',
      'UNKNOWN',
      'analyzeConversation',
      'applySystemState',
      'computeContextBudget',
      'createMeasure',
      'createSummaryMessage',
      'defaultSummaryPrompt',
      'estimateTokens',
      'fitContext',
      'isAbortError',
      'isBoundedBudget',
      'isLLMError',
      'isSummaryMessage',
      'isUnknown',
      'measureMessages',
      'normalizeContextWindow',
      'normalizeJsonSchema',
      'projectMessages',
      'rollingSummary',
      'slidingWindow',
      'stripSystemState',
      'summaryText',
      'toLLMError',
    ]);
    expect('default' in core).toBe(false);
  });
});

describe('unknown-value sentinel', () => {
  it('guards a native context size of 0 (DECISIONS.md D9) instead of trusting it', () => {
    expect(normalizeContextWindow(0)).toBe(UNKNOWN);
    expect(normalizeContextWindow(-1)).toBe(UNKNOWN);
    expect(normalizeContextWindow(Number.NaN)).toBe(UNKNOWN);
    expect(normalizeContextWindow(null)).toBe(UNKNOWN);
    expect(normalizeContextWindow(undefined)).toBe(UNKNOWN);
    expect(normalizeContextWindow(4096)).toBe(4096);
    expect(normalizeContextWindow(8192.7)).toBe(8192);
  });

  it('narrows with isUnknown', () => {
    const window: Capabilities['contextWindow'] = normalizeContextWindow(0);
    expect(isUnknown(window)).toBe(true);
    if (!isUnknown(window)) {
      // Only reachable when it is a number, which is the point of the guard.
      expect(window - 100).toBeLessThan(window);
    }
  });
});

describe('type-level contracts', () => {
  it('lets a third party implement LLMProvider against the exported types alone', async () => {
    const reasons: UnavailableReason[] = [
      'deviceNotEligible',
      'notEnabled',
      'modelNotReady',
      'unsupportedPlatform',
    ];
    const codes: LLMErrorCode[] = [
      'unavailable',
      'contextOverflow',
      'guardrail',
      'unsupportedLocale',
      'rateLimited',
      'cancelled',
      'network',
      'invalidRequest',
      'unknown',
    ];
    const finishReasons: FinishReason[] = [
      'stop',
      'length',
      'guardrail',
      'refusal',
      'cancelled',
      'toolCalls',
      'other',
    ];
    const roles: MessageRole[] = ['system', 'user', 'assistant'];
    expect([reasons, codes, finishReasons, roles].every((list) => list.length > 0)).toBe(true);

    class EchoProvider implements LLMProvider {
      readonly id = 'echo';

      async availability(): Promise<Availability> {
        return { available: true };
      }

      async capabilities(): Promise<Capabilities> {
        return {
          contextWindow: normalizeContextWindow(0),
          streaming: true,
          structuredOutput: false,
          tools: false,
          tokenCounting: 'estimated',
          locales: UNKNOWN,
          modelLabel: 'echo-1',
        };
      }

      async countTokens(messages: readonly Message[]): Promise<number> {
        return estimateTokens(messages);
      }

      async generate(req: GenerateRequest, options?: RequestOptions): Promise<GenerateResult> {
        if (options?.signal?.aborted === true) {
          throw new LLMError({ code: 'cancelled' }, { providerId: this.id });
        }
        const last = req.messages[req.messages.length - 1];
        if (last === undefined) {
          throw new LLMError({ code: 'invalidRequest' }, { providerId: this.id });
        }
        return { text: last.content, finishReason: 'stop', providerId: this.id };
      }

      async *stream(
        req: GenerateRequest,
        options?: RequestOptions
      ): AsyncGenerator<StreamEvent, void, undefined> {
        const result = await this.generate(req, options);
        yield { type: 'textDelta', delta: result.text };
        yield { type: 'finish', result };
      }
    }

    const provider: LLMProvider = new EchoProvider();
    const messages: readonly Message[] = [{ role: 'user', content: 'Goedemorgen' }];
    await expect(provider.generate({ messages })).resolves.toMatchObject({
      text: 'Goedemorgen',
      providerId: 'echo',
    });
    await expect(provider.countTokens?.(messages)).resolves.toBeGreaterThan(0);

    // A router (Phase 4) will hold providers side by side through this type.
    const providers: LLMProvider[] = [provider, new MockProvider()];
    expect(providers.map((candidate) => candidate.id)).toEqual(['echo', 'mock']);
  });
});
