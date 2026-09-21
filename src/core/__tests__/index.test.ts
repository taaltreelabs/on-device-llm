import { describe, expect, it } from 'vitest';

import { CORE_PLACEHOLDER } from '../index';

describe('core placeholder', () => {
  it('is present until Phase 1 fills in the real exports', () => {
    expect(CORE_PLACEHOLDER).toBe(true);
  });
});
