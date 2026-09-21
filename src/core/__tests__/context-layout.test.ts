/**
 * Turn pairing and pinning — the rules every strategy inherits.
 *
 * Each `it` below names one of the edge shapes docs/plan.md §5 asks to be
 * pinned down: consecutive user messages, a leading assistant message, a
 * trailing user message awaiting a reply, a pinned message mid-history.
 */
import { describe, expect, it } from 'vitest';

import { analyzeConversation, createSummaryMessage, type Message } from '../index';
import { conv } from './context-helpers';

/** Readable view of a layout: pinned contents, and each turn's contents. */
function shape(messages: readonly Message[], options?: Parameters<typeof analyzeConversation>[1]) {
  const layout = analyzeConversation(messages, options);
  return {
    pinned: layout.pinnedIndices.map((index) => messages[index].content),
    turns: layout.turns.map((turn) => turn.indices.map((index) => messages[index].content)),
  };
}

describe('pinning', () => {
  it('pins the first system message and nothing else, by default', () => {
    const messages = conv('s:prompt', 'u:q', 'a:r', 's:later instruction', 'u:q2');
    expect(shape(messages)).toEqual({
      pinned: ['prompt'],
      turns: [['q', 'r'], ['later instruction'], ['q2']],
    });
  });

  it('pins any message flagged pinned, whatever its role or position', () => {
    const messages = conv('s:prompt', 'u:q1', 'a:r1', '!u:remember this', 'u:q2', 'a:r2');
    expect(shape(messages)).toEqual({
      pinned: ['prompt', 'remember this'],
      turns: [
        ['q1', 'r1'],
        ['q2', 'r2'],
      ],
    });
  });

  it("pins every system message under 'all', and none under 'none'", () => {
    const messages = conv('s:prompt', 'u:q', 's:mid', 'a:r');
    expect(shape(messages, { pinSystemMessages: 'all' }).pinned).toEqual(['prompt', 'mid']);
    expect(shape(messages, { pinSystemMessages: 'none' }).pinned).toEqual([]);
  });

  it('never implicitly pins a summary message, not even under "all"', () => {
    const summary = createSummaryMessage('earlier: the user asked about X');
    const messages: Message[] = [summary, ...conv('u:q', 'a:r')];
    expect(analyzeConversation(messages, { pinSystemMessages: 'all' }).pinnedIndices).toEqual([]);
  });

  it('does not let a leading summary become "the system prompt" and outlive the conversation', () => {
    // The bug this guards: the summary is a system message, and it is first.
    // Under a naive "pin the first system message" rule it would be pinned
    // forever, so the next pass could neither drop nor re-summarize it.
    const summary = createSummaryMessage('earlier turns');
    const messages: Message[] = [summary, ...conv('s:real prompt', 'u:q')];
    const layout = analyzeConversation(messages);
    expect(layout.pinnedIndices).toEqual([1]);
    expect(layout.turns.map((turn) => turn.indices)).toEqual([[0], [2]]);
  });
});

describe('turn pairing', () => {
  it('pairs a user message with the assistant reply that follows it', () => {
    expect(shape(conv('u:q1', 'a:r1', 'u:q2', 'a:r2')).turns).toEqual([
      ['q1', 'r1'],
      ['q2', 'r2'],
    ]);
  });

  it('merges consecutive user messages into one turn (R2)', () => {
    // `r` answers both questions; splitting would let `q2, r` survive without
    // `q1`, which is exactly the half-context the rule exists to prevent.
    expect(shape(conv('u:q1', 'u:q2', 'a:r', 'u:q3', 'a:r3')).turns).toEqual([
      ['q1', 'q2', 'r'],
      ['q3', 'r3'],
    ]);
  });

  it('keeps a multi-part assistant reply in the turn it answered (R3)', () => {
    expect(shape(conv('u:q', 'a:part1', 'a:part2', 'u:q2')).turns).toEqual([
      ['q', 'part1', 'part2'],
      ['q2'],
    ]);
  });

  it('gives a leading assistant message a turn of its own (R4, seeded greeting)', () => {
    expect(shape(conv('a:hi, how can I help?', 'u:q', 'a:r')).turns).toEqual([
      ['hi, how can I help?'],
      ['q', 'r'],
    ]);
  });

  it('leaves a trailing user message as the newest turn (R5)', () => {
    const layout = analyzeConversation(conv('u:q1', 'a:r1', 'u:q2'));
    const last = layout.turns[layout.turns.length - 1];
    expect(last).toMatchObject({ hasUser: true, hasAssistant: false });
  });

  it('gives an unpinned system message a turn of its own, splitting the run (R5)', () => {
    // A system prompt is present, so `note` is not the first system message
    // and is therefore droppable rather than pinned.
    expect(shape(conv('s:prompt', 'u:q1', 'a:r1', 's:note', 'u:q2', 'a:r2'))).toEqual({
      pinned: ['prompt'],
      turns: [['q1', 'r1'], ['note'], ['q2', 'r2']],
    });
  });

  it('does not let a pinned message mid-history split the turn around it', () => {
    const messages = conv('u:q', '!s:standing rule', 'a:r');
    expect(shape(messages)).toEqual({ pinned: ['standing rule'], turns: [['q', 'r']] });
  });

  it('covers every index exactly once, pinned plus turns', () => {
    const messages = conv('s:p', 'u:a', 'a:b', '!u:c', 'u:d', 's:e', 'a:f', 'u:g');
    const layout = analyzeConversation(messages);
    const all = [...layout.pinnedIndices, ...layout.turns.flatMap((turn) => turn.indices)].sort(
      (x, y) => x - y
    );
    expect(all).toEqual(messages.map((_, index) => index));
  });

  it('handles the empty and only-system shapes', () => {
    expect(analyzeConversation([])).toEqual({ pinnedIndices: [], turns: [] });
    expect(analyzeConversation(conv('s:only'))).toEqual({ pinnedIndices: [0], turns: [] });
  });
});
