/**
 * Provider seam for the example app.
 *
 * Everything downstream (the chat screen) is built purely against the
 * `LLMProvider` interface from `@taaltreelabs/on-device-llm/core` -- it
 * never knows which concrete provider it is talking to. This file is the
 * one place that picks a concrete provider for a given toggle position.
 *
 * Two provider kinds:
 *
 * - `'mock'` -- a scripted `MockProvider` (core) that echoes back a canned,
 *   streamed reply for every turn. Always available, no device or network
 *   required, so the chat screen is fully exercisable today. Default.
 * - `'apple'` -- `createAppleProvider()` from the package's `/apple`
 *   subpath, imported exactly as a real consumer would:
 *   `import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple'`.
 *   Phase 3 (the Swift module in `ios/` and the factory in `src/apple`) is
 *   being built concurrently with this example app. If `createAppleProvider`
 *   has not landed yet, calling it throws (or resolves to `undefined` via
 *   CommonJS interop) and `getAppleProvider()` below falls back to a
 *   `PendingAppleProvider` stand-in that reports itself `unavailable` rather
 *   than crashing the toggle.
 */
// Real consumer import of the Phase 3 factory. May not exist yet -- see the
// module doc above and the "Metro subpath-exports verification" section of
// the example app's build report.
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import {
  LLMError,
  MockProvider,
  UNKNOWN,
  type Availability,
  type Capabilities,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type RequestOptions,
  type StreamEvent,
} from '@taaltreelabs/on-device-llm/core';

export type ProviderKind = 'mock' | 'apple';

/**
 * Deliberately small: makes `fitContext` + `slidingWindow` (wired in
 * `App.tsx`'s send path) actually trim history within a handful of turns,
 * so the "N of M messages sent" debug line is observable in a short manual
 * test session instead of sitting at "N of N" forever.
 */
export const MOCK_CONTEXT_WINDOW_TOKENS = 320;

/** Tokens held back for the answer, for the demo's `fitContext` call. Smaller than the library default (512) so the small window above still leaves room for input. */
export const DEMO_RESERVED_FOR_OUTPUT_TOKENS = 48;

/** Safety margin for the demo's `fitContext` call. Smaller than the estimated-tokens default (256), for the same reason. */
export const DEMO_SAFETY_MARGIN_TOKENS = 32;

/** Split a canned reply into several chunks so streaming has more than one delta to render. */
function scriptedReplyChunks(userText: string): readonly string[] {
  const reply =
    `You said: "${userText}". This is the scripted MockProvider talking -- ` +
    'flip the toggle above to "Apple" to exercise the on-device provider instead.';
  return reply.split(' ').map((word, index) => (index === 0 ? word : ` ${word}`));
}

/**
 * The shared mock instance. Exported as a value (not just built by a
 * factory) so the chat screen can queue a fresh turn onto it right before
 * every call -- `MockProvider` only replays a fixed queue of scripted
 * turns, and a chat rig needs to keep answering indefinitely.
 */
export const mockProvider: MockProvider = new MockProvider({
  id: 'mock',
  capabilities: { contextWindow: MOCK_CONTEXT_WINDOW_TOKENS },
});

/**
 * Queue the next scripted reply for `mockProvider`, based on the last user
 * message in the outgoing request. Call this right before
 * `mockProvider.stream(request, …)` (or `.generate`).
 */
export function scriptMockReply(request: GenerateRequest): void {
  const lastUserMessage = [...request.messages]
    .reverse()
    .find((message) => message.role === 'user');
  mockProvider.script({
    type: 'stream',
    chunks: scriptedReplyChunks(lastUserMessage?.content ?? ''),
  });
}

/**
 * `LLMProvider` stand-in used until the real Apple factory lands (or on a
 * device/OS that genuinely cannot run it). Every method resolves or throws
 * cleanly -- never throws at construction or import time -- so flipping the
 * toggle to "Apple" before Phase 3 lands is always safe.
 */
class PendingAppleProvider implements LLMProvider {
  readonly id = 'apple';

  constructor(private readonly detail: string) {}

  async availability(): Promise<Availability> {
    return { available: false, reason: 'unsupportedPlatform', detail: this.detail };
  }

  async capabilities(): Promise<Capabilities> {
    return {
      contextWindow: UNKNOWN,
      streaming: false,
      structuredOutput: false,
      tools: false,
      tokenCounting: 'none',
      locales: UNKNOWN,
    };
  }

  async generate(_request: GenerateRequest, _options?: RequestOptions): Promise<GenerateResult> {
    throw new LLMError(
      { code: 'unavailable', reason: 'unsupportedPlatform' },
      { providerId: this.id, message: this.detail }
    );
  }

  async *stream(
    _request: GenerateRequest,
    _options?: RequestOptions
  ): AsyncGenerator<StreamEvent, void, undefined> {
    throw new LLMError(
      { code: 'unavailable', reason: 'unsupportedPlatform' },
      { providerId: this.id, message: this.detail }
    );
  }
}

let appleProvider: LLMProvider | undefined;

/** Resolve (and cache) the Apple provider, falling back to `PendingAppleProvider` if the Phase 3 factory is not ready. */
export function getAppleProvider(): LLMProvider {
  if (appleProvider !== undefined) return appleProvider;
  let resolved: LLMProvider;
  try {
    if (typeof createAppleProvider !== 'function') {
      throw new Error(
        'createAppleProvider is not exported by @taaltreelabs/on-device-llm/apple yet -- Phase 3 (src/apple, ios/) is still in progress.'
      );
    }
    resolved = createAppleProvider();
  } catch (error) {
    resolved = new PendingAppleProvider(error instanceof Error ? error.message : String(error));
  }
  appleProvider = resolved;
  return resolved;
}

/** The active `LLMProvider` for a toggle position. Build the UI against its return type (`LLMProvider`) only. */
export function resolveProvider(kind: ProviderKind): LLMProvider {
  return kind === 'mock' ? mockProvider : getAppleProvider();
}
