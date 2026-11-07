/** Verifies UTF-16 budgets preserve complete code points in retained prefixes. */
import { describe, expect, it } from 'vitest';

import { truncateAtCodePointBoundary } from './truncate-at-code-point-boundary.js';

describe('truncateAtCodePointBoundary', () => {
  it('drops an astral character whole when its surrogate pair straddles the budget', () => {
    expect(truncateAtCodePointBoundary('a😀b', 2)).toBe('a');
    expect(truncateAtCodePointBoundary('😀b', 1)).toBe('');
  });

  it('retains an astral character when both code units fit', () => {
    expect(truncateAtCodePointBoundary('a😀b', 3)).toBe('a😀');
    expect(truncateAtCodePointBoundary('😀b', 2)).toBe('😀');
  });

  it('returns the longest prefix without skipping a character that does not fit', () => {
    expect(truncateAtCodePointBoundary('a😀b', 2)).toBe('a');
    expect(truncateAtCodePointBoundary('abcd', 3)).toBe('abc');
  });

  it('preserves values that already fit, including empty strings', () => {
    expect(truncateAtCodePointBoundary('a😀', 3)).toBe('a😀');
    expect(truncateAtCodePointBoundary('abc', 10)).toBe('abc');
    expect(truncateAtCodePointBoundary('', 0)).toBe('');
  });

  it('retains no characters when the budget is zero or negative', () => {
    expect(truncateAtCodePointBoundary('abc', 0)).toBe('');
    expect(truncateAtCodePointBoundary('😀', -1)).toBe('');
  });
});
