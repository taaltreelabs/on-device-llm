import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createAppleProvider } from '@taaltreelabs/on-device-llm/apple';
import { isLLMError, type UnavailableReason } from '@taaltreelabs/on-device-llm/core';
import { useAvailability, useGenerate } from '@taaltreelabs/on-device-llm/react';
import { extractionRequest, MAX_NOTE_LENGTH, parseTasks, SAMPLE_NOTE, type Task } from './task';

const apple = createAppleProvider();
const onForeground = (check: () => void) => {
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') check();
  });
  return () => subscription.remove();
};
const unavailableMessages: Record<UnavailableReason, string> = {
  unsupportedPlatform:
    'Use an iOS development build on a supported iPhone with iOS 26 or later. Expo Go cannot load the model bridge.',
  deviceNotEligible:
    'This device cannot use Apple Intelligence. Try an Apple Intelligence-compatible iPhone.',
  notEnabled: 'Enable Apple Intelligence in Settings, then return here and check again.',
  modelNotReady:
    'The model is not ready. Let Apple Intelligence finish downloading its assets, then check again.',
};

type ReviewTask = Task & { done: boolean };

export default function App() {
  return (
    <SafeAreaProvider>
      <TaskExtractor />
    </SafeAreaProvider>
  );
}

function TaskExtractor() {
  const [note, setNote] = useState(SAMPLE_NOTE);
  const [tasks, setTasks] = useState<ReviewTask[] | undefined>();
  const [message, setMessage] = useState<string>();
  const [elapsed, setElapsed] = useState<number>();
  const mounted = useRef(true);
  const {
    availability,
    capabilities,
    loading: checking,
    error: checkError,
    refresh,
  } = useAvailability(apple, { resubscribe: onForeground });
  const { generate, loading, abort } = useGenerate(apple);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ready =
    !checking &&
    !checkError &&
    availability?.available === true &&
    capabilities?.structuredOutput === true;
  const status = checking
    ? 'Checking Apple Intelligence…'
    : checkError
      ? 'Could not check the model. Try again.'
      : availability?.available === false
        ? unavailableMessages[availability.reason]
        : ready
          ? 'Apple Intelligence is ready.'
          : 'Structured output is unavailable on this model. Check again after updating your device.';

  function changeNote(text: string) {
    setNote(text);
    setTasks(undefined);
    setElapsed(undefined);
    setMessage(undefined);
  }

  async function extract() {
    if (!ready || loading || !note.trim()) return;
    Keyboard.dismiss();
    setTasks(undefined);
    setElapsed(undefined);
    setMessage(undefined);
    const started = Date.now();
    try {
      const result = await generate(extractionRequest(note));
      const extracted = parseTasks(result.object);
      if (!mounted.current) return;
      setTasks(extracted.map((task) => ({ ...task, done: false })));
      setElapsed((Date.now() - started) / 1000);
    } catch (error) {
      if (!mounted.current) return;
      const detail =
        isLLMError(error) && error.code === 'cancelled'
          ? 'Extraction stopped.'
          : isLLMError(error) && error.code === 'contextOverflow'
            ? 'This note exceeded the model’s context. Shorten it and try again.'
            : error instanceof Error
              ? error.message
              : 'Extraction failed. Please try again.';
      setMessage(detail);
    }
  }

  function updateTask(index: number, change: Partial<ReviewTask>) {
    setTasks((previous) =>
      previous?.map((task, i) => (i === index ? { ...task, ...change } : task))
    );
  }

  async function shareTasks() {
    if (!tasks?.length) return;
    try {
      await Share.share({
        message: tasks
          .map(
            (task) =>
              `${task.done ? '[x]' : '[ ]'} ${task.title}${task.when ? ` — ${task.when}` : ''}`
          )
          .join('\n'),
      });
    } catch {
      if (mounted.current) setMessage('Could not open sharing. Please try again.');
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>NOTE TO TASKS</Text>
          <Text style={styles.heading}>A little less{'\n'}on your mind.</Text>
          <Text style={styles.subtitle}>Turn a messy note into a checklist you can use.</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>On-device only · No cloud fallback</Text>
          </View>

          <View style={styles.statusBox}>
            <Text accessibilityLiveRegion="polite" style={styles.body}>
              {status}
            </Text>
            {!ready && (
              <Pressable
                accessibilityRole="button"
                disabled={checking || loading}
                onPress={refresh}
                style={styles.smallButton}>
                <Text style={styles.link}>{checking ? 'Checking…' : 'Check again'}</Text>
              </Pressable>
            )}
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>YOUR NOTE</Text>
            <Pressable
              accessibilityRole="button"
              disabled={loading}
              onPress={() => changeNote(SAMPLE_NOTE)}
              style={styles.smallButton}>
              <Text style={styles.link}>Use sample</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Note to turn into tasks"
            multiline
            editable={!loading}
            maxLength={MAX_NOTE_LENGTH}
            value={note}
            onChangeText={changeNote}
            placeholder="What do you need to do?"
            placeholderTextColor="#63706B"
            style={styles.note}
            textAlignVertical="top"
          />
          <Text style={styles.caption}>
            {note.length} / {MAX_NOTE_LENGTH} characters
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready || !note.trim() || loading }}
            disabled={!ready || !note.trim() || loading}
            onPress={() => void extract()}
            style={[styles.primary, (!ready || !note.trim() || loading) && styles.disabled]}>
            {loading && <ActivityIndicator color="#FFFFFF" />}
            <Text style={styles.primaryText}>
              {loading ? 'Finding your tasks…' : 'Extract tasks'}
            </Text>
          </Pressable>
          {loading && (
            <Pressable accessibilityRole="button" onPress={abort} style={styles.secondary}>
              <Text style={styles.link}>Stop extraction</Text>
            </Pressable>
          )}
          {message && (
            <Text accessibilityRole="alert" style={styles.error}>
              {message}
            </Text>
          )}

          {tasks !== undefined && (
            <View style={styles.results}>
              <Text style={styles.resultTitle}>
                {tasks.length ? 'Ready for your review' : 'Nothing to add'}
              </Text>
              <Text style={styles.caption}>
                Generated on this device{elapsed !== undefined ? ` in ${elapsed.toFixed(1)}s` : ''}.
              </Text>
              <Text style={styles.body}>
                {tasks.length
                  ? 'Edit any detail before using or sharing it.'
                  : 'No unfinished tasks were found. Try a note with a clear action.'}
              </Text>
              {tasks.map((task, index) => (
                <View key={index} style={styles.task}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: task.done }}
                    accessibilityLabel={`Complete task ${index + 1}: ${task.title}`}
                    onPress={() => updateTask(index, { done: !task.done })}
                    style={styles.checkbox}>
                    <Text style={styles.checkmark}>{task.done ? '✓' : '○'}</Text>
                  </Pressable>
                  <View style={styles.flex}>
                    <TextInput
                      accessibilityLabel={`Task ${index + 1} title`}
                      value={task.title}
                      multiline
                      onChangeText={(title) => updateTask(index, { title })}
                      style={[styles.taskTitle, task.done && styles.completed]}
                    />
                    <TextInput
                      accessibilityLabel={`Task ${index + 1} timing`}
                      value={task.when}
                      placeholder="No timing specified"
                      placeholderTextColor="#63706B"
                      onChangeText={(when) => updateTask(index, { when })}
                      style={styles.timing}
                    />
                  </View>
                </View>
              ))}
              {tasks.length > 0 && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void shareTasks()}
                  style={styles.secondary}>
                  <Text style={styles.link}>Share checklist</Text>
                </Pressable>
              )}
            </View>
          )}
          <Text style={styles.footer}>
            Notes and tasks stay in memory and are cleared when the app restarts. Sharing sends the
            checklist to the app you choose.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#F5F4EE' },
  page: { padding: 24, gap: 16, maxWidth: 640, width: '100%', alignSelf: 'center' },
  eyebrow: { color: '#345747', fontSize: 12, fontWeight: '700', letterSpacing: 2, marginTop: 12 },
  heading: { color: '#182E24', fontSize: 38, fontWeight: '700', letterSpacing: -1, lineHeight: 43 },
  subtitle: { color: '#526258', fontSize: 17, lineHeight: 25 },
  badge: { backgroundColor: '#E0ECDE', padding: 10, borderRadius: 20, alignSelf: 'flex-start' },
  badgeText: { color: '#284C38', fontSize: 12, fontWeight: '600' },
  statusBox: { borderLeftWidth: 3, borderLeftColor: '#7B967D', paddingLeft: 14, gap: 4 },
  body: { color: '#43554B', fontSize: 15, lineHeight: 22 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: '#345747', fontSize: 12, letterSpacing: 1, fontWeight: '700' },
  smallButton: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 4,
  },
  link: { color: '#28553B', fontSize: 15, fontWeight: '600' },
  note: {
    backgroundColor: '#FFFFFF',
    borderColor: '#CCD4C8',
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    minHeight: 180,
    color: '#182E24',
    fontSize: 17,
    lineHeight: 26,
  },
  caption: { color: '#63706B', fontSize: 12, lineHeight: 18 },
  primary: {
    backgroundColor: '#28553B',
    borderRadius: 14,
    padding: 18,
    minHeight: 56,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  primaryText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  secondary: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#B7C8B7',
    padding: 12,
  },
  error: { color: '#933724', fontSize: 15, lineHeight: 22 },
  results: { gap: 12, marginTop: 12 },
  resultTitle: { color: '#182E24', fontSize: 24, fontWeight: '600' },
  task: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 14,
    alignItems: 'flex-start',
    gap: 8,
  },
  checkbox: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  checkmark: { fontSize: 26, color: '#28553B' },
  taskTitle: { fontSize: 17, color: '#182E24', minHeight: 44, padding: 4 },
  timing: { fontSize: 14, color: '#526258', minHeight: 44, padding: 4 },
  completed: { textDecorationLine: 'line-through', color: '#63706B' },
  footer: { fontSize: 12, lineHeight: 19, color: '#63706B', marginVertical: 12 },
});
