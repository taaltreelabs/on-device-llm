import { describe, expect, it } from 'vitest';

import { REACT_PLACEHOLDER } from '../index';

describe('react placeholder', () => {
  it('is present until Phase 4 fills in the real hooks', () => {
    expect(REACT_PLACEHOLDER).toBe(true);
  });
});
