import { describe, expect, it } from 'vitest';

import { LLMError, isAbortError, isLLMError, toLLMError } from '../index';

describe('LLMError', () => {
  it('is an Error named LLMError with a code and a default message', () => {
    const error = new LLMError({ code: 'guardrail' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LLMError');
    expect(error.code).toBe('guardrail');
    expect(error.message).toMatch(/guardrail/i);
    expect(error.stack).toBeTruthy();
  });

  it('accepts an explicit message, providerId, and cause', () => {
    const cause = new Error('NSError 1013');
    const error = new LLMError(
      { code: 'unknown', transient: true },
      { message: 'native counter failed', providerId: 'apple', cause }
    );
    expect(error.message).toBe('native counter failed');
    expect(error.providerId).toBe('apple');
    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ code: 'unknown', transient: true });
  });

  it('builds informative default messages from the payload', () => {
    expect(new LLMError({ code: 'unavailable', reason: 'modelNotReady' }).message).toContain(
      'modelNotReady'
    );
    const overflow = new LLMError({ code: 'contextOverflow', contextSize: 4096, tokenCount: 5200 });
    expect(overflow.message).toContain('5200');
    expect(overflow.message).toContain('4096');
  });

  it('carries every code-specific payload', () => {
    const resetDate = new Date('2026-09-21T00:00:00.000Z');
    expect(new LLMError({ code: 'rateLimited', resetDate }).details).toEqual({
      code: 'rateLimited',
      resetDate,
    });
    expect(new LLMError({ code: 'unsupportedLocale', locale: 'pl-PL' }).details).toEqual({
      code: 'unsupportedLocale',
      locale: 'pl-PL',
    });
    expect(new LLMError({ code: 'network', status: 503 }).details).toEqual({
      code: 'network',
      status: 503,
    });
  });

  it('narrows details on the code discriminant', () => {
    const error: LLMError = new LLMError({
      code: 'contextOverflow',
      contextSize: 4096,
      tokenCount: 5200,
    });
    if (error.details.code === 'contextOverflow') {
      // Typed as number | undefined here — no cast needed.
      expect(error.details.tokenCount).toBe(5200);
    } else {
      throw new Error('expected contextOverflow details');
    }
  });
});

describe('isLLMError', () => {
  it('recognises LLMErrors and rejects everything else', () => {
    expect(isLLMError(new LLMError({ code: 'cancelled' }))).toBe(true);
    expect(isLLMError(new Error('nope'))).toBe(false);
    expect(isLLMError(undefined)).toBe(false);
    expect(isLLMError(null)).toBe(false);
    expect(isLLMError('cancelled')).toBe(false);
    expect(isLLMError({ code: 'cancelled' })).toBe(false);
  });

  it('optionally matches a specific code and narrows to it', () => {
    const thrown: unknown = new LLMError({ code: 'contextOverflow', tokenCount: 9000 });
    expect(isLLMError(thrown, 'guardrail')).toBe(false);
    if (!isLLMError(thrown, 'contextOverflow')) throw new Error('expected contextOverflow');
    expect(thrown.details.tokenCount).toBe(9000);
  });

  it('recognises a branded error from another copy of the class', () => {
    // Simulates two copies of the package in one dependency tree, where
    // `instanceof` fails but the brand survives.
    const foreign = Object.create(Object.getPrototypeOf(new Error())) as Record<string, unknown>;
    Object.assign(foreign, { code: 'network' });
    Object.defineProperty(foreign, '__taaltreeLLMError__', { value: true });
    expect(isLLMError(foreign)).toBe(true);
    expect(isLLMError(foreign, 'network')).toBe(true);
    expect(isLLMError(foreign, 'cancelled')).toBe(false);
  });
});

describe('isAbortError / toLLMError', () => {
  it('detects web-standard abort rejections', () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isAbortError(abortError)).toBe(true);
    expect(isAbortError(Object.assign(new Error('late'), { name: 'TimeoutError' }))).toBe(true);
    expect(isAbortError(new Error('aborted'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });

  it('maps aborts to cancelled, preserving the original', () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const mapped = toLLMError(abortError, { providerId: 'openai' });
    expect(mapped.code).toBe('cancelled');
    expect(mapped.providerId).toBe('openai');
    expect(mapped.cause).toBe(abortError);
  });

  it('passes existing LLMErrors through untouched', () => {
    const original = new LLMError({ code: 'guardrail' }, { providerId: 'apple' });
    expect(toLLMError(original, { providerId: 'openai' })).toBe(original);
  });

  it('maps anything else to unknown with the cause and the transient hint', () => {
    const native = new Error('SensitiveContentAnalysisML error 15');
    const mapped = toLLMError(native, { providerId: 'apple', transient: true });
    expect(mapped.code).toBe('unknown');
    expect(mapped.message).toBe('SensitiveContentAnalysisML error 15');
    expect(mapped.cause).toBe(native);
    if (!isLLMError(mapped, 'unknown')) throw new Error('expected unknown');
    expect(mapped.details.transient).toBe(true);
  });

  it('maps non-Error throws too', () => {
    const mapped = toLLMError('boom');
    expect(mapped.code).toBe('unknown');
    expect(mapped.cause).toBe('boom');
    expect(mapped.providerId).toBeUndefined();
    if (!isLLMError(mapped, 'unknown')) throw new Error('expected unknown');
    expect(mapped.details.transient).toBeUndefined();
  });
});
