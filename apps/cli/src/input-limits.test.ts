/** Exact budget boundaries for plain JSON data, independent of socket chunking. */
import { describe, expect, it, vi } from 'vitest';
import { requestInputLimitViolation } from './input-limits.js';

describe('decoded request budgets', () => {
  it('checks near-budget arrays and records without copying their values', () => {
    const input = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`k${i}`, Array(1000).fill(null)]),
    );
    const values = vi.spyOn(Object, 'values');
    let copies: number;
    let violation: string | undefined;
    try {
      violation = requestInputLimitViolation(input);
      copies = values.mock.calls.length;
    } finally {
      values.mockRestore();
    }
    expect(violation).toBeUndefined();
    expect(copies).toBe(0);
  });

  it('admits depth 32 and rejects depth 33 without recursive traversal', () => {
    let value: unknown = null;
    for (let depth = 0; depth < 32; depth++) {
      value = { child: value };
    }
    expect(requestInputLimitViolation(value)).toBeUndefined();
    expect(requestInputLimitViolation({ child: value })).toContain('32 levels');
  });

  it('admits 10000 total values and rejects 10001', () => {
    const value = Array.from({ length: 10 }, (_, i) =>
      Array(i === 0 ? 998 : 999).fill(null),
    );
    expect(requestInputLimitViolation(value)).toBeUndefined();
    value[0]?.push(null);
    expect(requestInputLimitViolation(value)).toContain('10000 values');
  });

  it('bounds arrays and records even when the values are otherwise invalid', () => {
    expect(requestInputLimitViolation(Array(1000).fill(null))).toBeUndefined();
    expect(requestInputLimitViolation(Array(1001).fill(null))).toContain(
      '1000 entries',
    );
    const record = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`k${i}`, null]),
    );
    expect(requestInputLimitViolation(record)).toBeUndefined();
    expect(requestInputLimitViolation({ ...record, extra: null })).toContain(
      '1000 entries',
    );
  });
});
