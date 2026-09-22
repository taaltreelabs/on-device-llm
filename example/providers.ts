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
 *   required, so the chat screen is fully exercisable today.
 * - `'router'` -- `createRouter()` (Phase 4, core) over two providers, in
 *   fallback order: the Apple provider (`createAppleProvider()` from the
 *   package's `/apple` subpath, wrapped by {@link simulateUnavailable} so the
 *   example app's switch can force it out of the running) then `cloud-fm`
 *   (`createOpenAIProvider()` from `/openai`, pointed at `fm serve` on the
 *   development Mac). Default. If `createAppleProvider` has not landed yet,
 *   calling it throws (or resolves to `undefined` via CommonJS interop) and
 *   `getAppleProvider()` below falls back to a `PendingAppleProvider`
 *   stand-in that reports itself `unavailable` rather than crashing the
 *   toggle -- the router falls back past it exactly as it would past a real
 *   Apple provider that is not ready yet.
 */
// Real consumer import of the Phase 3 factory. May not exist yet -- see the
// module doc above and the "Metro subpath-exports verification" section of
// the example app's build report.
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import {
  createRouter,
  LLMError,
  MockProvider,
  UNKNOWN,
  type Availability,
  type Capabilities,
  type GenerateRequest,
  type GenerateResult,
  type JsonSchema,
  type LLMProvider,
  type OnRoute,
  type RequestOptions,
  type StreamEvent,
  type ToolDefinition,
} from '@taaltreelabs/on-device-llm/core';
// `createOpenAIProvider`'s injectable `fetch` is the documented seam for real
// token-by-token streaming in Expo (docs/research/ecosystem.md §3): bare RN's
// built-in `fetch` has no readable-stream body, so without this the cloud leg
// would silently degrade to one aggregated `textDelta` per turn.
import { createOpenAIProvider } from '@taaltreelabs/on-device-llm/openai';
import { fetch as expoFetch } from 'expo/fetch';
import Constants from 'expo-constants';
import { NativeModules } from 'react-native';

export type ProviderKind = 'mock' | 'router';

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
    'flip the toggle above to "Router" to exercise the real providers instead.';
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

/**
 * Mutable flag the router's wrapped Apple provider (see
 * {@link simulateUnavailable}) reads on every call -- a plain object, not a
 * React ref, so `App.tsx`'s "simulate on-device unavailable" `Switch` can
 * flip it straight from an event handler with no re-render required to take
 * effect and no risk of tripping `react-hooks/refs` (that rule polices
 * `useRef`, not an ordinary exported mutable). Flipping it never rebuilds
 * `router` below; the *next* `generate()`/`stream()` call just reads a
 * different value (Phase 4 acceptance mechanism, docs/plan.md §5).
 */
export const simulateUnavailableFlag: { current: boolean } = { current: false };

/**
 * Wrap `inner` so it reports and behaves `unavailable` whenever `isOn()` is
 * true, and delegates verbatim otherwise (Phase 4 acceptance mechanism,
 * docs/plan.md §5: "toggling a 'simulate unavailable' switch moves the
 * conversation to the cloud provider on the next turn with history intact").
 *
 * `isOn` is a function, not a captured boolean, so flipping
 * {@link simulateUnavailableFlag} takes effect on the very next call without
 * this wrapper -- or the router built around it -- ever needing to be
 * rebuilt.
 */
export function simulateUnavailable(inner: LLMProvider, isOn: () => boolean): LLMProvider {
  const simulatedError = (): LLMError =>
    new LLMError(
      { code: 'unavailable', reason: 'modelNotReady' },
      { providerId: inner.id, message: 'simulated' }
    );

  const wrapped: LLMProvider = {
    id: inner.id,
    async availability(): Promise<Availability> {
      if (isOn()) return { available: false, reason: 'modelNotReady', detail: 'simulated' };
      return inner.availability();
    },
    // Capabilities are reported verbatim even while simulated-unavailable --
    // the router's own `capabilities()` only ever asks the *preferred
    // available* provider (src/core/router/router.ts), so this never misleads
    // a caller into budgeting against a provider it cannot reach.
    async capabilities(): Promise<Capabilities> {
      return inner.capabilities();
    },
    async generate(request: GenerateRequest, options?: RequestOptions): Promise<GenerateResult> {
      if (isOn()) throw simulatedError();
      return inner.generate(request, options);
    },
    stream(request: GenerateRequest, options?: RequestOptions): AsyncIterable<StreamEvent> {
      if (isOn()) {
        const error = simulatedError();
        // Deferred throw (only on first `.next()`), matching every real
        // provider's `stream()` contract -- the async generator function
        // itself must not throw synchronously at call time.
        return (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          throw error;
        })();
      }
      return inner.stream(request, options);
    },
  };
  if (inner.countTokens !== undefined) {
    wrapped.countTokens = (messages) => inner.countTokens!(messages);
  }
  if (inner.prewarm !== undefined) {
    wrapped.prewarm = (messages) => inner.prewarm!(messages);
  }
  return wrapped;
}

/**
 * Best-effort LAN IP for the Mac running `expo start`, so the device/simulator
 * can reach `fm serve` on that same machine.
 *
 * `Constants.expoConfig?.hostUri` (e.g. `"192.168.1.23:8081"`) is the
 * documented, stable source (expo-constants -- a transitive dependency of
 * `expo`, resolvable through Metro's/TypeScript's normal node_modules walk
 * even though it is not in `example/package.json` directly). Falls back to
 * parsing `NativeModules.SourceCode.scriptURL` (e.g.
 * `"http://192.168.1.23:8081/index.bundle?..."`) for the rare case
 * `hostUri` is unset.
 */
export function resolveDevHost(): string | undefined {
  const hostUri = Constants.expoConfig?.hostUri;
  if (typeof hostUri === 'string' && hostUri.length > 0) {
    const host = hostUri.split(':')[0];
    if (host !== undefined && host.length > 0) return host;
  }
  const scriptUrl = (NativeModules as { SourceCode?: { scriptURL?: string } }).SourceCode
    ?.scriptURL;
  if (typeof scriptUrl === 'string') {
    const match = /^https?:\/\/([^/:]+)/.exec(scriptUrl);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Port `fm serve` listens on during development (docs/plan.md §5 Phase 1/4). */
export const FM_SERVE_PORT = 1976;

let cloudFmProvider: LLMProvider | undefined;

/**
 * The cloud fallback: `fm serve` on the development Mac, reached over the
 * same LAN Metro is already using. `fetch` is injected from `expo/fetch` so
 * `stream()` gets real token-by-token delivery (see the import comment
 * above) rather than bare RN's built-in `fetch`, which has no readable-stream
 * body.
 */
export function getCloudFmProvider(): LLMProvider {
  if (cloudFmProvider !== undefined) return cloudFmProvider;
  const host = resolveDevHost() ?? '127.0.0.1';
  cloudFmProvider = createOpenAIProvider({
    baseUrl: `http://${host}:${FM_SERVE_PORT}/v1`,
    model: 'system',
    fetch: expoFetch as unknown as typeof fetch,
    contextWindow: 8192,
    id: 'cloud-fm',
  });
  return cloudFmProvider;
}

/**
 * The router's only subscriber, if any -- `App.tsx` registers/unregisters
 * this from a `useEffect` (never from render, so there is nothing here for
 * `react-hooks/refs` to flag) so it can caption each assistant bubble with
 * which provider actually answered. Indirected through a stable dispatcher
 * function (below) rather than reaching into `router`'s config directly,
 * since `createRouter`'s `onRoute` cannot be swapped after construction.
 */
let onRouteListener: OnRoute | undefined;

/** Register (or, with `undefined`, unregister) the one `onRoute` listener. Call from an effect. */
export function setOnRouteListener(listener: OnRoute | undefined): void {
  onRouteListener = listener;
}

let router: LLMProvider | undefined;

/**
 * The active provider for the `'router'` toggle position: the Apple provider
 * (wrapped so the "simulate unavailable" switch can force it out of the
 * running), then `cloud-fm`. `onRoute` is the router's only content-free
 * telemetry seam (src/core/router/router.ts); it dispatches to whichever
 * listener `setOnRouteListener` most recently registered.
 */
export function getRouter(): LLMProvider {
  if (router !== undefined) return router;
  router = createRouter({
    id: 'router',
    providers: [
      simulateUnavailable(getAppleProvider(), () => simulateUnavailableFlag.current),
      getCloudFmProvider(),
    ],
    onRoute: (report) => onRouteListener?.(report),
  });
  return router;
}

/** The active `LLMProvider` for a toggle position. Build the UI against its return type (`LLMProvider`) only. */
export function resolveProvider(kind: ProviderKind): LLMProvider {
  return kind === 'mock' ? mockProvider : getRouter();
}
