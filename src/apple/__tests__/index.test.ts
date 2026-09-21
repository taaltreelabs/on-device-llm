import { describe, expect, it } from 'vitest';

import { APPLE_PLACEHOLDER } from '../index';

describe('apple placeholder', () => {
  it('is present until Phase 3 fills in the real exports', () => {
    expect(APPLE_PLACEHOLDER).toBe(true);
  });

  it('does not import the native module at load time', async () => {
    // Regression guard for docs/plan.md §4: importing the package root must
    // never throw on a platform without the FoundationModels bridge. As
    // long as `../index` (the placeholder) has no import of `./native`,
    // this import succeeding under plain Node is evidence of that.
    await expect(import('../index')).resolves.toBeDefined();
  });
});
