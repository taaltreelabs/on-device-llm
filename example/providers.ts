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
  type JsonSchema,
  type LLMProvider,
  type RequestOptions,
  type StreamEvent,
  type ToolDefinition,
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
 * Fixed prompt for the structured-output demo (`App.tsx`'s "JSON demo"
 * button). Deliberately unrelated to the running chat -- the demo is about
 * one schema-shaped turn, not conversation context.
 */
export const JSON_DEMO_PROMPT = 'Invent a plausible weather report for Amsterdam as JSON.';

/**
 * Schema for the structured-output demo. Kept inside the subset the Apple
 * provider's `normalizeJsonSchema`/`encodeAppleSchema` can decode
 * (docs/plan.md §5 Phase 3 step 6, src/core/schema.ts): an object with a
 * string, a ranged number, a string enum, and an optional bounded array of
 * strings.
 */
export const JSON_DEMO_SCHEMA: JsonSchema = {
  type: 'object',
  title: 'WeatherReport',
  properties: {
    city: { type: 'string' },
    tempC: { type: 'number', minimum: -40, maximum: 45 },
    conditions: { type: 'string', enum: ['sunny', 'rainy', 'cloudy', 'snowy'] },
    alerts: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['city', 'tempC', 'conditions'],
  additionalProperties: false,
};

const WEATHER_CONDITIONS = ['sunny', 'rainy', 'cloudy', 'snowy'] as const;

/** Result of {@link checkWeatherReport}. */
export interface ConformanceCheck {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

/**
 * Hand-rolled conformance check against `JSON_DEMO_SCHEMA` -- keys, types,
 * and the enum. Not a JSON Schema validator (no library, per the example
 * app's no-new-dependencies rule); just enough to catch a model that skipped
 * a required field, used the wrong type, or invented a condition outside the
 * enum.
 */
export function checkWeatherReport(value: unknown): ConformanceCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { pass: false, reasons: ['expected a JSON object'] };
  }
  const report = value as Record<string, unknown>;
  const reasons: string[] = [];

  if (typeof report['city'] !== 'string' || report['city'].trim() === '') {
    reasons.push('"city" must be a non-empty string');
  }
  const tempC = report['tempC'];
  if (typeof tempC !== 'number' || !Number.isFinite(tempC) || tempC < -40 || tempC > 45) {
    reasons.push('"tempC" must be a number between -40 and 45');
  }
  const conditions = report['conditions'];
  if (
    typeof conditions !== 'string' ||
    !WEATHER_CONDITIONS.includes(conditions as (typeof WEATHER_CONDITIONS)[number])
  ) {
    reasons.push(`"conditions" must be one of ${WEATHER_CONDITIONS.join(', ')}`);
  }
  const alerts = report['alerts'];
  if (
    alerts !== undefined &&
    (!Array.isArray(alerts) ||
      alerts.length > 3 ||
      alerts.some((entry) => typeof entry !== 'string'))
  ) {
    reasons.push('"alerts", if present, must be an array of at most 3 strings');
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Queue a scripted object turn for `mockProvider`'s JSON demo run.
 * `MockProvider` never evaluates `GenerateRequest.schema` -- it only ever
 * replays what a turn scripts -- so this stands in for what a real
 * structured-output provider would produce for `JSON_DEMO_PROMPT`, matching
 * `JSON_DEMO_SCHEMA`.
 */
export function scriptMockWeatherReply(): void {
  mockProvider.script({
    type: 'stream',
    chunks: [],
    object: {
      city: 'Amsterdam',
      tempC: 14,
      conditions: 'cloudy',
      alerts: ['Gale warning tonight'],
    },
  });
}

/** Fixed prompt for the tool round-trip demo (`App.tsx`'s "Tool demo" button). */
export const TOOL_DEMO_PROMPT = 'Check the battery and tell me if I should charge soon.';

/** What the fake battery sensor reports. */
export interface BatteryReading {
  readonly level: number;
  readonly state: 'charging' | 'unplugged';
}

/**
 * Fake in-JS "sensor" the battery tool calls. No native module and no new
 * dependency (a real battery read would need `expo-battery`) -- the point of
 * the demo is an honest JS round trip, not a real sensor.
 */
export async function readFakeBatterySensor(): Promise<BatteryReading> {
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  const level = Math.min(1, Math.max(0, 0.42 + (Math.random() - 0.5) * 0.08));
  const state: BatteryReading['state'] = Math.random() < 0.7 ? 'charging' : 'unplugged';
  return { level: Number(level.toFixed(2)), state };
}

/**
 * The one tool the demo request carries. `execute` really runs the fake
 * sensor above (with its 300ms delay) -- there is nothing scripted about the
 * tool call itself, only about what `mockProvider` does with the result (see
 * {@link scriptMockBatteryReply}).
 */
export function makeBatteryTool(): ToolDefinition {
  return {
    name: 'getBatteryLevel',
    description: 'Reads the current battery level (0 to 1) and charging state from the device.',
    parameters: {
      type: 'object',
      title: 'GetBatteryLevelArgs',
      properties: {},
      additionalProperties: false,
    },
    execute: async () => readFakeBatterySensor(),
  };
}

/** Compose the reply text once the battery reading is known, so both the real and scripted paths can show an answer that actually depends on it. */
export function describeBatteryReading(reading: BatteryReading): string {
  const percent = Math.round(reading.level * 100);
  if (reading.state === 'charging') {
    return `Battery is at ${percent}% and already charging, so there's nothing else to do.`;
  }
  return percent < 30
    ? `Battery is at ${percent}% and not charging -- you should plug in soon.`
    : `Battery is at ${percent}% and not charging, but that's comfortably enough for now.`;
}

/**
 * Queue a scripted reply for `mockProvider`'s tool demo run, once the
 * battery reading is known. `MockProvider` reports `capabilities().tools ===
 * false` and never calls `ToolDefinition.execute` itself -- `App.tsx` runs
 * it directly and passes the result here so the scripted text still depends
 * on it, the same way a real provider's final answer would.
 */
export function scriptMockBatteryReply(reading: BatteryReading): void {
  const reply = describeBatteryReading(reading);
  mockProvider.script({
    type: 'stream',
    chunks: reply.split(' ').map((word, index) => (index === 0 ? word : ` ${word}`)),
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
