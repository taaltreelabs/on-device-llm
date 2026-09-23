import { describe, expect, it } from 'vitest';

import { SseParser } from '../sse';

describe('SseParser', () => {
  it('parses a single complete event in one push', () => {
    const parser = new SseParser();
    const events = parser.push('data: {"a":1}\n\n');
    expect(events).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it('buffers a partial event split mid-line across chunks', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\n')).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it('buffers a partial event split exactly at the blank-line boundary', () => {
    const parser = new SseParser();
    expect(parser.push('data: hi\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: undefined, data: 'hi' }]);
  });

  it('parses multiple events delivered in a single chunk', () => {
    const parser = new SseParser();
    const events = parser.push('data: one\n\ndata: two\n\ndata: three\n\n');
    expect(events.map((e) => e.data)).toEqual(['one', 'two', 'three']);
  });

  it('handles CRLF line endings', () => {
    const parser = new SseParser();
    const events = parser.push('data: one\r\n\r\ndata: two\r\n\r\n');
    expect(events.map((e) => e.data)).toEqual(['one', 'two']);
  });

  it('handles lone-CR line endings', () => {
    const parser = new SseParser();
    const events = parser.push('data: one\r\rdata: two\r\r');
    expect(events.map((e) => e.data)).toEqual(['one', 'two']);
  });

  it('joins multiple data: lines in one event with \\n', () => {
    const parser = new SseParser();
    const events = parser.push('data: line1\ndata: line2\n\n');
    expect(events).toEqual([{ event: undefined, data: 'line1\nline2' }]);
  });

  it('parses an event: field alongside data:', () => {
    const parser = new SseParser();
    const events = parser.push('event: error\ndata: {"error":{"message":"boom"}}\n\n');
    expect(events).toEqual([{ event: 'error', data: '{"error":{"message":"boom"}}' }]);
  });

  it('ignores comment lines (leading colon)', () => {
    const parser = new SseParser();
    const events = parser.push(': this is a comment\ndata: hi\n\n');
    expect(events).toEqual([{ event: undefined, data: 'hi' }]);
  });

  it('ignores unrecognised fields (id, retry, whatever)', () => {
    const parser = new SseParser();
    const events = parser.push('id: 42\nretry: 3000\nfoo: bar\ndata: hi\n\n');
    expect(events).toEqual([{ event: undefined, data: 'hi' }]);
  });

  it('passes [DONE] through as an ordinary event for the caller to special-case', () => {
    const parser = new SseParser();
    const events = parser.push('data: [DONE]\n\n');
    expect(events).toEqual([{ event: undefined, data: '[DONE]' }]);
  });

  it('recovers a trailing event with no terminating blank line via flush()', () => {
    const parser = new SseParser();
    expect(parser.push('data: incomplete')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: undefined, data: 'incomplete' }]);
  });

  it('flush() on an empty/whitespace-only buffer returns nothing', () => {
    const parser = new SseParser();
    expect(parser.flush()).toEqual([]);
    parser.push('   \n');
    expect(parser.flush()).toEqual([]);
  });

  it('handles a field with no colon as a field name with empty value', () => {
    const parser = new SseParser();
    // "data" alone (no colon) is a legal data field with value "".
    const events = parser.push('data\n\n');
    expect(events).toEqual([{ event: undefined, data: '' }]);
  });
});
