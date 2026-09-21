/**
 * Lazy native-module resolution (docs/plan.md §4, §5 Phase 3 step 8).
 *
 * These tests are not a simulation: Node *is* a platform with no
 * FoundationModels bridge, so running them under vitest exercises exactly the
 * code path an Android or web build takes. The package root must import, the
 * provider must construct, and every method must degrade to
 * `unavailable`/`unsupportedPlatform` rather than throw a `TypeError` about
 * an undefined native function.
 */

import { describe, expect, it } from 'vitest';

import { isLLMError, UNKNOWN } from '../../core';
import { createAppleProvider } from '../index';

describe('lazy native-module resolution under Node', () => {
  it('imports the subpath entry point without throwing', async () => {
    await expect(import('../index')).resolves.toBeDefined();
  });

  it('imports the package root without throwing', async () => {
    // The root re-exports `./apple`, so a module-scope `requireNativeModule`
    // anywhere in this subtree would take the whole package down here.
    await expect(import('../../index')).resolves.toBeDefined();
  });

  it('constructs a provider', () => {
    const provider = createAppleProvider();
    expect(provider.id).toBe('apple');
  });

  it('honours a configured id', () => {
    expect(createAppleProvider({ id: 'on-device' }).id).toBe('on-device');
  });

  it('reports unsupportedPlatform rather than throwing', async () => {
    const availability = await createAppleProvider().availability();
    expect(availability).toMatchObject({ available: false, reason: 'unsupportedPlatform' });
  });

  it('reports empty capabilities with an UNKNOWN context window', async () => {
    const capabilities = await createAppleProvider().capabilities();
    expect(capabilities).toEqual({
      contextWindow: UNKNOWN,
      streaming: false,
      structuredOutput: false,
      tools: false,
      tokenCounting: 'none',
      locales: UNKNOWN,
    });
  });

  it('rejects generate with unavailable/unsupportedPlatform', async () => {
    const provider = createAppleProvider();
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toSatisfy((err: unknown) => {
      return (
        isLLMError(err, 'unavailable') &&
        err.details.reason === 'unsupportedPlatform' &&
        err.providerId === 'apple'
      );
    });
  });

  it('rejects stream with unavailable/unsupportedPlatform, at the call, not at the first pull', () => {
    const provider = createAppleProvider();
    // Thrown synchronously from `stream()` itself: a caller that never
    // iterates still learns the provider is unusable.
    expect(() => provider.stream({ messages: [{ role: 'user', content: 'hi' }] })).toThrow(
      /not available in this process/i
    );
  });
});
