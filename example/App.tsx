/**
 * Manual test rig for `@taaltreelabs/on-device-llm`.
 *
 * A single chat screen, built against the package's own public surface: the
 * chat loop is `useChat` (`@taaltreelabs/on-device-llm/react`), the
 * availability panel is `useAvailability`, and the two one-shot demos are
 * `useGenerate` -- all imported exactly as a real consumer would. `./providers.ts`
 * is still the only place that picks a concrete provider for the toggle.
 *
 * This screen is the maintainer's checkpoint for Phase 4 (docs/plan.md §5):
 * a router in front of the chat (Apple, falling back to a cloud provider),
 * a "simulate on-device unavailable" switch that forces that fallback on the
 * next turn with conversation history intact, and `onRoute` surfaced on
 * screen rather than only in a log.
 */
import type {
  Availability,
  Capabilities,
  LLMProvider,
  Message,
  OnRoute,
  RouteReport,
  ToolDefinition,
} from '@taaltreelabs/on-device-llm/core';
import { useAvailability, useChat, useGenerate } from '@taaltreelabs/on-device-llm/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Button,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
// Core SafeAreaView is deprecated in RN 0.86 (LogBox warns at launch) and will
// be removed; this is the replacement RN's own warning points at.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  checkWeatherReport,
  DEMO_RESERVED_FOR_OUTPUT_TOKENS,
  DEMO_SAFETY_MARGIN_TOKENS,
  JSON_DEMO_PROMPT,
  JSON_DEMO_SCHEMA,
  makeBatteryTool,
  resolveProvider,
  scriptMockBatteryReply,
  scriptMockReply,
  scriptMockWeatherReply,
  setOnRouteListener,
  simulateUnavailableFlag,
  TOOL_DEMO_PROMPT,
  type BatteryReading,
  type ProviderKind,
} from './providers';

/** Caption shown under an assistant bubble once its turn's `onRoute` report has arrived, keyed to `useChat().messages`'s index. */
function routeCaption(report: RouteReport): string {
  if (report.providerId === undefined) return 'no provider answered';
  return `via ${report.providerId}${report.fellBack ? ' (fell back)' : ''}`;
}

export default function App() {
  const [providerKind, setProviderKind] = useState<ProviderKind>('router');

  // The "simulate on-device unavailable" switch. `simulateUnavailableFlag`
  // (providers.ts) is a plain mutable object, not a `useRef` -- the router's
  // wrapped Apple provider reads it fresh on every call, so flipping it never
  // requires rebuilding the router (docs/plan.md §5 Phase 4 acceptance: the
  // *next* turn after flipping falls back, with history intact because the
  // router and `useChat`'s conversation are untouched).
  const [simulateOn, setSimulateOn] = useState(false);
  const toggleSimulate = useCallback((value: boolean) => {
    simulateUnavailableFlag.current = value;
    setSimulateOn(value);
  }, []);

  const provider = useMemo<LLMProvider>(() => resolveProvider(providerKind), [providerKind]);

  // The router's only telemetry seam. Content-free by construction
  // (src/core/router/router.ts) -- ids, a reason enum, booleans -- so it is
  // safe to hold verbatim in state and render. Registered from an effect
  // (never called during render) via `setOnRouteListener`, since
  // `createRouter`'s `onRoute` cannot be swapped after construction.
  const [lastRoute, setLastRoute] = useState<RouteReport | undefined>(undefined);
  const pendingRouteCaptionRef = useRef<string | undefined>(undefined);
  const handleRoute = useCallback<OnRoute>((report) => {
    setLastRoute(report);
    pendingRouteCaptionRef.current = routeCaption(report);
  }, []);
  useEffect(() => {
    setOnRouteListener(handleRoute);
    return () => setOnRouteListener(undefined);
  }, [handleRoute]);

  const [inputText, setInputText] = useState('');

  const chat = useChat({
    provider,
    context: {
      strategy: 'slidingWindow',
      reservedForOutput: DEMO_RESERVED_FOR_OUTPUT_TOKENS,
      safetyMargin: DEMO_SAFETY_MARGIN_TOKENS,
    },
  });

  // Which provider answered each assistant message in `chat.messages`,
  // indexed the same way. Only ever grows in step with `chat.messages`
  // (or resets to `[]` alongside it via `reset()`/a provider switch) --
  // `useChat` owns the array itself, so this mirrors it rather than
  // maintaining its own copy of the conversation.
  const [routeCaptions, setRouteCaptions] = useState<readonly (string | undefined)[]>([]);
  useEffect(() => {
    setRouteCaptions((previous) => {
      if (chat.messages.length <= previous.length) {
        return chat.messages.length === 0 ? [] : previous.slice(0, chat.messages.length);
      }
      const next = [...previous];
      for (let index = previous.length; index < chat.messages.length; index += 1) {
        next.push(
          chat.messages[index]?.role === 'assistant' ? pendingRouteCaptionRef.current : undefined
        );
      }
      return next;
    });
  }, [chat.messages]);

  const resubscribeToForeground = useCallback((check: () => void) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => subscription.remove();
  }, []);

  const availability = useAvailability(provider, { resubscribe: resubscribeToForeground });

  // Fire-and-forget: `prewarm` is a hint, not a contract (src/core/provider.ts)
  // -- it never throws and its result says nothing about how fast the next
  // request will be. Warming as soon as a provider is selected means the
  // on-device model is more likely to be ready by the time the maintainer
  // finishes typing a first message.
  useEffect(() => {
    const prewarming = provider.prewarm?.();
    prewarming?.catch(() => undefined);
  }, [provider]);

  const scrollRef = useRef<ScrollView | null>(null);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (text === '' || chat.status !== 'idle') return;
    setInputText('');
    // MockProvider only replays a scripted queue; the router's providers need
    // no such scripting. `scriptMockReply` only reads the last user message,
    // so a minimal one-message request is enough to script from `text`
    // itself, ahead of `useChat` building its own (system-prompt-and-history-
    // carrying) request internally.
    if (providerKind === 'mock') scriptMockReply({ messages: [{ role: 'user', content: text }] });
    chat.send(text).catch(() => undefined);
  }, [chat, inputText, providerKind]);

  const changeProvider = useCallback(
    (kind: ProviderKind) => {
      if (chat.status !== 'idle' || kind === providerKind) return;
      setProviderKind(kind);
      chat.reset();
    },
    [chat, providerKind]
  );

  // ---- JSON demo (useGenerate) --------------------------------------------

  const jsonDemo = useGenerate(provider);
  const jsonDemoObject = jsonDemo.object;
  const jsonConformance = useMemo(
    () => (jsonDemoObject === undefined ? undefined : checkWeatherReport(jsonDemoObject)),
    [jsonDemoObject]
  );
  const runJsonDemo = useCallback(() => {
    if (chat.status !== 'idle') return;
    if (providerKind === 'mock') scriptMockWeatherReply();
    jsonDemo
      .generate({
        messages: [{ role: 'user', content: JSON_DEMO_PROMPT }],
        schema: JSON_DEMO_SCHEMA,
      })
      .catch(() => undefined);
  }, [chat.status, jsonDemo, providerKind]);

  // ---- Tool demo (useGenerate) ---------------------------------------------

  const toolDemo = useGenerate(provider);
  const [toolCallNotice, setToolCallNotice] = useState<string | undefined>(undefined);
  const runToolDemo = useCallback(async () => {
    if (chat.status !== 'idle') return;
    setToolCallNotice(undefined);

    const battery = makeBatteryTool();
    // Wrapping `execute` (rather than reading `toolDemo.result` afterwards)
    // is what lets the same "→ tool called with …" notice appear whether the
    // handler ran because a real provider's model asked for it, or because
    // `MockProvider` never calls `execute` and the demo has to run it itself
    // below (docs/providers.ts comments on `scriptMockBatteryReply`).
    const tool: ToolDefinition = {
      ...battery,
      execute: async (call) => {
        const reading = await battery.execute?.(call);
        setToolCallNotice(
          `→ tool ${battery.name} called with ${JSON.stringify(call.arguments)} -> ${JSON.stringify(reading)}`
        );
        return reading;
      },
    };

    if (providerKind === 'mock') {
      // MockProvider reports capabilities().tools === false and never calls
      // ToolDefinition.execute itself -- run it directly so the scripted
      // reply still depends on a real reading, the same way a real
      // provider's final answer would.
      const reading = await tool.execute?.({
        callId: 'mock-battery-call',
        toolName: tool.name,
        arguments: {},
        signal: new AbortController().signal,
      });
      scriptMockBatteryReply(reading as BatteryReading);
    }

    try {
      await toolDemo.generate({
        messages: [{ role: 'user', content: TOOL_DEMO_PROMPT }],
        tools: [tool],
      });
    } catch {
      // toolDemo.error already carries this.
    }
  }, [chat.status, providerKind, toolDemo]);

  const contextDebugLine = useMemo(() => {
    const fit = chat.lastFit;
    if (fit === undefined) return undefined;
    const dropped =
      fit.dropped.length > 0 ? ` (${fit.dropped.length} dropped to fit the context window)` : '';
    const routing =
      providerKind === 'router' && lastRoute !== undefined ? ` -- ${routeCaption(lastRoute)}` : '';
    return `Sent ${fit.sentCount} of ${fit.historyCount} messages in history${dropped}${routing}`;
  }, [chat.lastFit, lastRoute, providerKind]);

  const isGenerating = chat.status !== 'idle';
  const bannerError = chat.error;
  const streamingText = chat.streamingText;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          // 'padding' on BOTH platforms: Android 15+ enforces edge-to-edge for
          // targetSdk 35+, where the old adjustResize no longer resizes the
          // window, so without padding the input row hides under the keyboard
          // (observed on the API 36 emulator).
          behavior="padding"
          keyboardVerticalOffset={0}>
          <StatusLine providerId={provider.id} availability={availability.availability} />

          <ProviderToggle active={providerKind} disabled={isGenerating} onChange={changeProvider} />

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Simulate on-device unavailable</Text>
            <Switch value={simulateOn} onValueChange={toggleSimulate} />
          </View>

          <AvailabilityPanel
            availability={availability.availability}
            capabilities={availability.capabilities}
            loading={availability.loading}
            onRefresh={availability.refresh}
          />

          {bannerError !== undefined || availability.error !== undefined ? (
            <ErrorBanner
              code={(bannerError ?? availability.error)?.code ?? 'unknown'}
              message={(bannerError ?? availability.error)?.message ?? ''}
            />
          ) : null}

          <ScrollView
            ref={scrollRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
            {chat.messages.length === 0 && streamingText === undefined ? (
              <Text style={styles.emptyState}>No messages yet -- send one below.</Text>
            ) : (
              chat.messages.map((message, index) => (
                <MessageBubble key={index} message={message} caption={routeCaptions[index]} />
              ))
            )}
            {streamingText !== undefined ? (
              <MessageBubble
                message={{ role: 'assistant', content: streamingText }}
                streaming={chat.status === 'streaming'}
              />
            ) : null}
          </ScrollView>

          <View style={styles.demosRow}>
            <View style={styles.demosButtonWrapper}>
              <Button title="JSON demo" onPress={runJsonDemo} disabled={isGenerating} />
            </View>
            <View style={styles.demosButtonWrapper}>
              <Button
                title="Tool demo"
                onPress={() => {
                  runToolDemo();
                }}
                disabled={isGenerating}
              />
            </View>
            <View style={styles.demosButtonWrapper}>
              <Button
                title="Clear"
                color="#b91c1c"
                onPress={chat.reset}
                disabled={isGenerating || chat.messages.length === 0}
              />
            </View>
          </View>

          <DemoResult
            title="JSON demo"
            loading={jsonDemo.loading}
            error={jsonDemo.error}
            text={
              jsonDemo.object !== undefined
                ? JSON.stringify(jsonDemo.object, null, 2)
                : jsonDemo.result?.text
            }
            footer={
              jsonConformance === undefined
                ? undefined
                : jsonConformance.pass
                  ? 'PASS -- matches the schema'
                  : `FAIL -- ${jsonConformance.reasons.join('; ')}`
            }
          />
          <DemoResult
            title="Tool demo"
            loading={toolDemo.loading}
            error={toolDemo.error}
            text={toolDemo.result?.text}
            footer={toolCallNotice}
          />

          {contextDebugLine !== undefined ? (
            <Text style={styles.debugLine}>{contextDebugLine}</Text>
          ) : null}

          <View style={styles.inputRow}>
            <TextInput
              style={styles.textInput}
              value={inputText}
              onChangeText={setInputText}
              placeholder="Message"
              editable={!isGenerating}
              multiline
            />
            {isGenerating ? (
              <Button title="Stop" color="#b91c1c" onPress={chat.stop} />
            ) : (
              <Button title="Send" onPress={handleSend} disabled={inputText.trim() === ''} />
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function StatusLine(props: {
  readonly providerId: string;
  readonly availability: Availability | undefined;
}) {
  const { availability } = props;
  const label =
    availability === undefined
      ? 'checking…'
      : availability.available
        ? 'available'
        : `unavailable (${availability.reason})`;
  return (
    <Text style={styles.statusLine}>
      Provider: {props.providerId} -- {label}
    </Text>
  );
}

function ProviderToggle(props: {
  readonly active: ProviderKind;
  readonly disabled: boolean;
  readonly onChange: (kind: ProviderKind) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      {(['router', 'mock'] as const).map((kind) => (
        <View key={kind} style={styles.toggleButtonWrapper}>
          <Button
            title={kind === 'router' ? 'Router' : 'Mock'}
            color={props.active === kind ? '#1d4ed8' : undefined}
            disabled={props.disabled}
            onPress={() => props.onChange(kind)}
          />
        </View>
      ))}
    </View>
  );
}

function AvailabilityPanel(props: {
  readonly availability: Availability | undefined;
  readonly capabilities: Capabilities | undefined;
  readonly loading: boolean;
  readonly onRefresh: () => void;
}) {
  const { availability, capabilities } = props;
  // Collapsed by default: the full capabilities JSON is taller than a phone
  // screen and starves the message list and input row of space. The one-line
  // summary in StatusLine stays visible either way.
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>Availability &amp; capabilities</Text>
        {props.loading ? (
          <ActivityIndicator size="small" />
        ) : (
          <>
            <Button title={expanded ? 'Hide' : 'Show'} onPress={() => setExpanded(!expanded)} />
            <Button title="Refresh" onPress={props.onRefresh} />
          </>
        )}
      </View>
      {expanded ? (
        <ScrollView style={styles.panelBody} nestedScrollEnabled>
          <Text style={styles.panelJson}>
            {availability !== undefined ? JSON.stringify(availability, null, 2) : 'not yet checked'}
          </Text>
          <Text style={styles.panelJson}>
            {capabilities !== undefined ? JSON.stringify(capabilities, null, 2) : 'not yet checked'}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function ErrorBanner(props: { readonly code: string; readonly message: string }) {
  return (
    <View style={styles.errorBanner}>
      <View style={styles.errorTextColumn}>
        <Text style={styles.errorCode}>{props.code}</Text>
        <Text style={styles.errorMessage}>{props.message}</Text>
      </View>
    </View>
  );
}

function MessageBubble(props: {
  readonly message: Message;
  readonly caption?: string;
  readonly streaming?: boolean;
}) {
  const { message } = props;
  const isUser = message.role === 'user';
  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text
          style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant]}>
          {message.content}
          {props.streaming ? '▍' : ''}
        </Text>
        {props.caption !== undefined ? (
          <Text style={styles.bubbleCaption}>{props.caption}</Text>
        ) : null}
      </View>
    </View>
  );
}

function DemoResult(props: {
  readonly title: string;
  readonly loading: boolean;
  readonly error: { readonly code: string; readonly message: string } | undefined;
  readonly text: string | undefined;
  readonly footer: string | undefined;
}) {
  if (
    !props.loading &&
    props.error === undefined &&
    props.text === undefined &&
    props.footer === undefined
  ) {
    return null;
  }
  return (
    <View style={styles.demoResult}>
      <View style={styles.demoResultHeader}>
        <Text style={styles.demoResultTitle}>{props.title}</Text>
        {props.loading ? <ActivityIndicator size="small" /> : null}
      </View>
      {props.error !== undefined ? (
        <Text style={styles.demoResultError}>
          {props.error.code}: {props.error.message}
        </Text>
      ) : null}
      {props.text !== undefined ? <Text style={styles.demoResultText}>{props.text}</Text> : null}
      {props.footer !== undefined ? (
        <Text
          style={[
            styles.bubbleFooter,
            props.footer.startsWith('PASS') ? styles.bubbleFooterPass : styles.bubbleFooterNeutral,
          ]}>
          {props.footer}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f3f4f6' },
  flex: { flex: 1 },
  statusLine: {
    paddingHorizontal: 12,
    paddingTop: 8,
    fontSize: 12,
    color: '#4b5563',
  },
  toggleRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
  },
  toggleButtonWrapper: { marginRight: 8 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  switchLabel: { fontSize: 13, color: '#374151' },
  panel: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    backgroundColor: '#111827',
    borderRadius: 8,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  panelBody: {
    maxHeight: 220,
  },
  panelTitle: { color: '#e5e7eb', fontWeight: '600', fontSize: 13 },
  panelJson: {
    color: '#a7f3d0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    marginBottom: 4,
  },
  errorBanner: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    backgroundColor: '#fee2e2',
    borderColor: '#b91c1c',
    borderWidth: 1,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  errorTextColumn: { flex: 1, marginRight: 8 },
  errorCode: { color: '#7f1d1d', fontWeight: '700', fontSize: 13 },
  errorMessage: { color: '#7f1d1d', fontSize: 12, marginTop: 2 },
  messageList: { flex: 1, marginHorizontal: 12 },
  messageListContent: { paddingVertical: 8 },
  emptyState: { color: '#9ca3af', textAlign: 'center', marginTop: 24 },
  demosRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: 8,
  },
  demosButtonWrapper: { marginRight: 8 },
  demoResult: {
    marginHorizontal: 12,
    marginTop: 6,
    padding: 8,
    backgroundColor: '#111827',
    borderRadius: 8,
  },
  demoResultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  demoResultTitle: { color: '#e5e7eb', fontWeight: '600', fontSize: 12 },
  demoResultError: { color: '#f87171', fontSize: 11 },
  demoResultText: {
    color: '#a7f3d0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
  },
  debugLine: {
    marginHorizontal: 12,
    marginBottom: 4,
    marginTop: 4,
    fontSize: 11,
    color: '#6b7280',
  },
  bubbleRow: { flexDirection: 'row', marginVertical: 4 },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubbleRowAssistant: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '80%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
  bubbleUser: { backgroundColor: '#1d4ed8' },
  bubbleAssistant: { backgroundColor: '#e5e7eb' },
  bubbleText: { fontSize: 15 },
  bubbleTextUser: { color: '#ffffff' },
  bubbleTextAssistant: { color: '#111827' },
  bubbleCaption: { fontSize: 10, color: '#6b7280', marginTop: 4 },
  bubbleFooter: { fontSize: 12, fontWeight: '700', marginTop: 6 },
  bubbleFooterPass: { color: '#4ade80' },
  bubbleFooterNeutral: { color: '#93c5fd' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    backgroundColor: '#ffffff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d1d5db',
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#f9fafb',
  },
});
