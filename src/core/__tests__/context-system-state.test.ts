/**
 * The app-owned structured state slot: the pattern docs/plan.md §5 asks to be
 * made first-class.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applySystemState,
  createSummaryMessage,
  stripSystemState,
  DEFAULT_SYSTEM_STATE_MARKER,
  type Message,
} from '../index';
import { conv } from './context-helpers';

/** The example from the docs: a task-tracking app rendering its open items. */
function renderTasks(tasks: readonly { title: string; done: boolean }[]): string {
  if (tasks.length === 0) return 'No open tasks.';
  return tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.title}`).join('\n');
}

describe('applySystemState', () => {
  it('appends the rendered block to the system prompt', () => {
    const messages = conv('s:You are a task assistant.', 'u:what is left?');
    const { messages: next, outcome } = applySystemState(messages, () =>
      renderTasks([
        { title: 'Renew passport', done: false },
        { title: 'Book dentist', done: true },
      ])
    );

    expect(next[0].content).toBe(
      'You are a task assistant.\n\n[current state]\n- [ ] Renew passport\n- [x] Book dentist'
    );
    expect(outcome).toMatchObject({ applied: true, placement: 'systemPrompt' });
    // Pure: the caller's array and messages are untouched.
    expect(messages[0].content).toBe('You are a task assistant.');
  });

  it('creates a pinned system prompt when the conversation has none', () => {
    const { messages: next } = applySystemState(conv('u:hi'), () => 'x: 1');
    expect(next[0]).toEqual({ role: 'system', content: '[current state]\nx: 1', pinned: true });
    expect(next).toHaveLength(2);
  });

  it('replaces a previously rendered block rather than stacking copies', () => {
    const slot = vi.fn<[], string>();
    slot.mockReturnValueOnce('count: 1').mockReturnValueOnce('count: 2');
    const first = applySystemState(conv('s:prompt', 'u:q'), slot).messages;
    const second = applySystemState(first, slot).messages;

    expect(second[0].content).toBe('prompt\n\n[current state]\ncount: 2');
    expect(second[0].content).not.toContain('count: 1');
  });

  it('renders nothing for an empty or undefined result, and strips a stale block', () => {
    const withState = applySystemState(conv('s:prompt', 'u:q'), () => 'x').messages;
    const cleared = applySystemState(withState, () => undefined);
    expect(cleared.messages[0].content).toBe('prompt');
    expect(cleared.outcome).toEqual({ applied: false });

    const blank = applySystemState(withState, () => '   ');
    expect(blank.messages[0].content).toBe('prompt');
  });

  it('places the block in its own pinned message when asked', () => {
    const { messages: next } = applySystemState(conv('s:prompt', 'u:q'), {
      render: () => 'x: 1',
      placement: 'ownMessage',
    });
    expect(next.map((message) => message.content)).toEqual([
      'prompt',
      '[current state]\nx: 1',
      'q',
    ]);
    expect(next[1].pinned).toBe(true);
    // Idempotent in this placement too.
    const again = applySystemState(next, { render: () => 'x: 2', placement: 'ownMessage' });
    expect(again.messages).toHaveLength(3);
    expect(again.messages[1].content).toBe('[current state]\nx: 2');
  });

  it('targets the system prompt, not a summary that happens to come first', () => {
    const messages: Message[] = [createSummaryMessage('earlier'), ...conv('s:prompt', 'u:q')];
    const { messages: next } = applySystemState(messages, () => 'x: 1');
    expect(next[0].content).toBe(messages[0].content);
    expect(next[1].content).toBe('prompt\n\n[current state]\nx: 1');
  });

  it('leaves the marker alone when it appears mid-sentence in the app’s own prose', () => {
    const prose = `Mention the ${DEFAULT_SYSTEM_STATE_MARKER} label if asked.`;
    expect(stripSystemState(prose)).toBe(prose);
  });

  it('strips a block back to the original prompt', () => {
    expect(stripSystemState('prompt\n\n[current state]\nx: 1')).toBe('prompt');
    expect(stripSystemState('[current state]\nx: 1')).toBe('');
    expect(stripSystemState('prompt')).toBe('prompt');
  });
});
