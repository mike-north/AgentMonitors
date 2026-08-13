import { describe, expect, it, vi } from 'vitest';
import { canonicalJsonStringify } from './json.js';

describe('external JSON canonicalization', () => {
  it('sorts object keys recursively without sorting arrays', () => {
    expect(
      canonicalJsonStringify({ z: [2, 1, { z: 2, a: 1 }], a: 'first' }),
    ).toBe('{"a":"first","z":[2,1,{"a":1,"z":2}]}');
    expect(
      canonicalJsonStringify([
        [2, 1],
        [1, 2],
      ]),
    ).toBe('[[2,1],[1,2]]');
    expect(canonicalJsonStringify([2, 1])).not.toBe(
      canonicalJsonStringify([1, 2]),
    );
    expect(canonicalJsonStringify({ z: 1, a: 2 })).toBe(
      canonicalJsonStringify({ a: 2, z: 1 }),
    );
  });

  it('rejects non-JSON values, prototypes, cycles, and sparse arrays', () => {
    for (const value of [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: Number.MAX_SAFE_INTEGER + 1 },
      { value: undefined },
      { value: 1n },
      new Date(),
      Object.create({ inherited: true }) as unknown,
    ]) {
      expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
    }

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow(TypeError);

    const sparse = Array.from({ length: 2 }) as unknown[];
    sparse[1] = 'present';
    expect(() => canonicalJsonStringify(sparse)).toThrow(TypeError);
  });

  it('rejects object accessors and non-JSON own properties without reading them', () => {
    const getter = vi.fn(() => 'computed');
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: getter });
    expect(() => canonicalJsonStringify(accessor)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();

    const hidden = { visible: true };
    Object.defineProperty(hidden, 'secret', {
      enumerable: false,
      value: 'private',
    });
    expect(() => canonicalJsonStringify(hidden)).toThrow(TypeError);

    const symbolic = { visible: true } as Record<PropertyKey, unknown>;
    symbolic[Symbol('secret')] = 'private';
    expect(() => canonicalJsonStringify(symbolic)).toThrow(TypeError);
  });

  it('rejects array accessors and extra own properties without reading them', () => {
    const getter = vi.fn(() => 'computed');
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: getter });
    expect(() => canonicalJsonStringify(accessor)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();

    const extra = ['visible'] as unknown[] & Record<string, unknown>;
    extra['secret'] = 'private';
    expect(() => canonicalJsonStringify(extra)).toThrow(TypeError);

    const hidden = ['visible'];
    Object.defineProperty(hidden, 'secret', {
      enumerable: false,
      value: 'private',
    });
    expect(() => canonicalJsonStringify(hidden)).toThrow(TypeError);

    const symbolic = ['visible'] as unknown[] & Record<PropertyKey, unknown>;
    symbolic[Symbol('secret')] = 'private';
    expect(() => canonicalJsonStringify(symbolic)).toThrow(TypeError);
  });
});
