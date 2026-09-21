/**
 * Manual test rig for `@taaltreelabs/on-device-llm`.
 *
 * A single chat screen, built purely against the `LLMProvider` interface
 * from `@taaltreelabs/on-device-llm/core` (see `./providers.ts` for the
 * swap seam). Nothing here assumes which concrete provider is behind the
 * toggle -- the same code path drives the scripted `MockProvider` today and
 * the Apple provider once Phase 3 lands.
 *
 * This screen is the maintainer's checkpoint for Phase 3 (docs/plan.md §5):
 * chat, stream, cancel, and an availability/capabilities panel that renders
 * verbatim what the provider reports on-device.
 */
import {
  fitContext,
  toLLMError,
  type Availability,
  type Capabilities,
  type GenerateRequest,
  type LLMProvider,
  type Message,
} from '@taaltreelabs/on-device-llm/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  DEMO_RESERVED_FOR_OUTPUT_TOKENS,
  DEMO_SAFETY_MARGIN_TOKENS,
  resolveProvider,
  scriptMockReply,
  type ProviderKind,
} from './providers';

interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly streaming: boolean;
}

interface ChatError {
  readonly code: string;
  readonly message: string;
}

interface ContextDebugInfo {
  readonly sentCount: number;
  readonly historyCount: number;
  readonly droppedCount: number;
}

/** `Availability`/`Capabilities` panel state: not-yet-fetched, or a result. Loading is tracked separately (`isCheckingAvailability`). */
type PanelState<T> = { readonly status: 'idle' } | { readonly status: 'ready'; readonly value: T };

let nextMessageId = 0;
function makeMessageId(): string {
  nextMessageId += 1;
  return `msg-${nextMessageId}`;
}

/** Result of checking a provider's status. A plain data fetch -- no `setState` -- so it is safe to call from a `useEffect`. */
type ProviderStatusResult =
  | { readonly ok: true; readonly availability: Availability; readonly capabilities: Capabilities }
  | { readonly ok: false; readonly error: ChatError };

async function fetchProviderStatus(provider: LLMProvider): Promise<ProviderStatusResult> {
  try {
    const [availability, capabilities] = await Promise.all([
      provider.availability(),
      provider.capabilities(),
    ]);
    return { ok: true, availability, capabilities };
  } catch (thrown) {
    const llmError = toLLMError(thrown, { providerId: provider.id });
    return { ok: false, error: { code: llmError.code, message: llmError.message } };
  }
}

export default function App() {
  const [providerKind, setProviderKind] = useState<ProviderKind>('mock');
  const provider = useMemo(() => resolveProvider(providerKind), [providerKind]);

  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<ChatError | undefined>(undefined);
  const [contextDebug, setContextDebug] = useState<ContextDebugInfo | undefined>(undefined);

  const [availability, setAvailability] = useState<PanelState<Availability>>({ status: 'idle' });
  const [capabilities, setCapabilities] = useState<PanelState<Capabilities>>({ status: 'idle' });
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  // On mount, and whenever the toggle changes providers. Deliberately a
  // plain data fetch with no setState call of its own (react-hooks flags a
  // setState reachable directly from a useEffect callback as a
  // cascading-render risk) -- the effect below applies the result itself,
  // in a `.then` callback, once it knows the request was not superseded.
  useEffect(() => {
    let superseded = false;
    fetchProviderStatus(provider).then((result) => {
      if (superseded) return;
      if (result.ok) {
        setAvailability({ status: 'ready', value: result.availability });
        setCapabilities({ status: 'ready', value: result.capabilities });
      } else {
        setError(result.error);
      }
    });
    return () => {
      superseded = true;
    };
  }, [provider]);

  // The refresh button is a plain event handler, so toggling a loading flag
  // around the same fetch here is unambiguous.
  const handleRefreshPress = useCallback(() => {
    setIsCheckingAvailability(true);
    fetchProviderStatus(provider).then((result) => {
      setIsCheckingAvailability(false);
      if (result.ok) {
        setAvailability({ status: 'ready', value: result.availability });
        setCapabilities({ status: 'ready', value: result.capabilities });
      } else {
        setError(result.error);
      }
    });
  }, [provider]);

  const appendAssistantDelta = useCallback((id: string, delta: string) => {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === id ? { ...message, content: message.content + delta } : message
      )
    );
  }, []);

  const finishAssistantMessage = useCallback((id: string) => {
    setMessages((previous) =>
      previous.map((message) => (message.id === id ? { ...message, streaming: false } : message))
    );
  }, []);

  const dropEmptyAssistantMessage = useCallback((id: string) => {
    setMessages((previous) =>
      previous.filter((message) => !(message.id === id && message.content === ''))
    );
  }, []);

  const send = useCallback(async () => {
    const text = inputText.trim();
    if (text === '' || isGenerating) return;

    setError(undefined);
    setInputText('');

    const userMessage: ChatMessage = {
      id: makeMessageId(),
      role: 'user',
      content: text,
      streaming: false,
    };
    const assistantId = makeMessageId();
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
    };
    setMessages((previous) => [...previous, userMessage, assistantPlaceholder]);

    // The app owns the conversation array; fitContext never mutates it and
    // returns a new, possibly-trimmed list (src/core/context/fit.ts).
    const fullHistory: readonly Message[] = [...messages, userMessage].map(({ role, content }) => ({
      role,
      content,
    }));

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsGenerating(true);

    try {
      const fitted = await fitContext(fullHistory, {
        provider,
        strategy: 'slidingWindow',
        reservedForOutput: DEMO_RESERVED_FOR_OUTPUT_TOKENS,
        safetyMargin: DEMO_SAFETY_MARGIN_TOKENS,
        signal: controller.signal,
      });

      setContextDebug({
        sentCount: fitted.messages.length,
        historyCount: fullHistory.length,
        droppedCount: fitted.dropped.length,
      });

      const request: GenerateRequest = { messages: fitted.messages };
      if (providerKind === 'mock') scriptMockReply(request);

      for await (const event of provider.stream(request, { signal: controller.signal })) {
        if (event.type === 'textDelta') {
          appendAssistantDelta(assistantId, event.delta);
        }
        // 'finish' and any future event types are ignored here on purpose
        // (docs/plan.md: consumers should ignore event types they do not
        // recognise); the loop simply ends after 'finish'.
      }
    } catch (thrown) {
      const llmError = toLLMError(thrown, { providerId: provider.id });
      setError({ code: llmError.code, message: llmError.message });
      dropEmptyAssistantMessage(assistantId);
    } finally {
      finishAssistantMessage(assistantId);
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  }, [
    appendAssistantDelta,
    dropEmptyAssistantMessage,
    finishAssistantMessage,
    inputText,
    isGenerating,
    messages,
    provider,
    providerKind,
  ]);

  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const changeProvider = useCallback(
    (kind: ProviderKind) => {
      if (isGenerating || kind === providerKind) return;
      setProviderKind(kind);
      setContextDebug(undefined);
    },
    [isGenerating, providerKind]
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}>
        <StatusLine providerId={provider.id} availability={availability} />

        <ProviderToggle active={providerKind} disabled={isGenerating} onChange={changeProvider} />

        <AvailabilityPanel
          availability={availability}
          capabilities={capabilities}
          loading={isCheckingAvailability}
          onRefresh={handleRefreshPress}
        />

        {error !== undefined ? (
          <ErrorBanner error={error} onDismiss={() => setError(undefined)} />
        ) : null}

        <ScrollView
          ref={scrollRef}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
          {messages.length === 0 ? (
            <Text style={styles.emptyState}>No messages yet -- send one below.</Text>
          ) : (
            messages.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
        </ScrollView>

        {contextDebug !== undefined ? (
          <Text style={styles.debugLine}>
            Sent {contextDebug.sentCount} of {contextDebug.historyCount} messages in history
            {contextDebug.droppedCount > 0
              ? ` (${contextDebug.droppedCount} dropped to fit the context window)`
              : ''}
          </Text>
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
            <Button title="Stop" color="#b91c1c" onPress={stop} />
          ) : (
            <Button
              title="Send"
              onPress={() => {
                send();
              }}
              disabled={inputText.trim() === ''}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function StatusLine(props: {
  readonly providerId: string;
  readonly availability: PanelState<Availability>;
}) {
  const { availability } = props;
  const label =
    availability.status !== 'ready'
      ? 'checking…'
      : availability.value.available
        ? 'available'
        : `unavailable (${availability.value.reason})`;
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
      {(['mock', 'apple'] as const).map((kind) => (
        <View key={kind} style={styles.toggleButtonWrapper}>
          <Button
            title={kind === 'mock' ? 'Mock' : 'Apple'}
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
  readonly availability: PanelState<Availability>;
  readonly capabilities: PanelState<Capabilities>;
  readonly loading: boolean;
  readonly onRefresh: () => void;
}) {
  const { availability, capabilities } = props;
  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>Availability &amp; capabilities</Text>
        {props.loading ? (
          <ActivityIndicator size="small" />
        ) : (
          <Button title="Refresh" onPress={props.onRefresh} />
        )}
      </View>
      <Text style={styles.panelJson}>
        {availability.status === 'ready'
          ? JSON.stringify(availability.value, null, 2)
          : 'not yet checked'}
      </Text>
      <Text style={styles.panelJson}>
        {capabilities.status === 'ready'
          ? JSON.stringify(capabilities.value, null, 2)
          : 'not yet checked'}
      </Text>
    </View>
  );
}

function ErrorBanner(props: { readonly error: ChatError; readonly onDismiss: () => void }) {
  return (
    <View style={styles.errorBanner}>
      <View style={styles.errorTextColumn}>
        <Text style={styles.errorCode}>{props.error.code}</Text>
        <Text style={styles.errorMessage}>{props.error.message}</Text>
      </View>
      <Button title="Dismiss" onPress={props.onDismiss} />
    </View>
  );
}

function MessageBubble(props: { readonly message: ChatMessage }) {
  const { message } = props;
  const isUser = message.role === 'user';
  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text
          style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant]}>
          {message.content}
          {message.streaming ? '▍' : ''}
        </Text>
      </View>
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
  debugLine: {
    marginHorizontal: 12,
    marginBottom: 4,
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
