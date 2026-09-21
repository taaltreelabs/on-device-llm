import { describe, expect, it } from 'vitest';

import { createOpenAIProvider, OpenAIProvider } from '../index';

describe('openai package entry point', () => {
  it('createOpenAIProvider returns an OpenAIProvider implementing the LLMProvider surface', () => {
    const provider = createOpenAIProvider({ baseUrl: 'http://127.0.0.1:1976/v1', model: 'system' });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.id).toBe('openai');
    expect(typeof provider.generate).toBe('function');
    expect(typeof provider.stream).toBe('function');
    expect(typeof provider.availability).toBe('function');
    expect(typeof provider.capabilities).toBe('function');
    expect(typeof provider.countTokens).toBe('function');
  });
});
