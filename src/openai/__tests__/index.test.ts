import { describe, expect, it } from 'vitest';

import { OPENAI_PLACEHOLDER } from '../index';

describe('openai placeholder', () => {
  it('is present until Phase 1 fills in the real exports', () => {
    expect(OPENAI_PLACEHOLDER).toBe(true);
  });
});
