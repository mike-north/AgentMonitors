import { describe, expect, it, vi } from 'vitest';
import { assertExternalJsonValue, canonicalJsonStringify } from './json.js';
import type { ExternalJsonValue } from './json.js';

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

/** Build container chains whose root uses the caller's initial depth. */
function nestedContainers(levels: number, arrays: boolean): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < levels; level += 1) {
    value = arrays ? [value] : { child: value };
  }
  return value;
}

/** Deterministic PRNG so ordering failures can be reproduced without dependencies. */
function seededRandom(): () => number {
  let seed = 596;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
}

/** Generate nested JSON with repeated shapes, numeric keys and escaped strings. */
function generatedValue(
  random: () => number,
  depth: number,
): ExternalJsonValue {
  if (depth === 0) {
    const leaves = [
      null,
      true,
      false,
      -0,
      1.25,
      'quote"\\\\unicode雪',
    ] as const;
    return leaves[Math.floor(random() * leaves.length)] ?? null;
  }
  if (random() < 0.35) {
    return Array.from({ length: 3 }, () => generatedValue(random, depth - 1));
  }
  return Object.fromEntries(
    ['z', 'a', '10', '2', '__proto__', '雪'].map((key) => [
      key,
      generatedValue(random, depth - 1),
    ]),
  );
}

/** Change only insertion order; array positions and scalar values are semantic. */
function shuffledValue(
  value: ExternalJsonValue,
  random: () => number,
): ExternalJsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => shuffledValue(item, random));
  const entries = Object.entries(value);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const left = entries[index];
    const right = entries[other];
    if (left && right) {
      entries[index] = right;
      entries[other] = left;
    }
  }
  return Object.fromEntries(
    entries.map(([key, item]) => [key, shuffledValue(item, random)]),
  );
}

describe('external JSON plain-data boundary', () => {
  it.each([
    undefined,
    () => 'callable',
    1n,
    Symbol('value'),
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    new Date(),
    new Map(),
    new Set(),
    new Uint8Array([1]),
    new (class Example {
      value = 1;
    })(),
    Object.create({ inherited: true }) as unknown,
  ])('rejects unsupported scalar or prototype %#', (value) => {
    expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
    expect(() => canonicalJsonStringify({ value })).toThrow(TypeError);
  });

  it('accepts null-prototype records and JSON numeric boundaries', () => {
    const record: unknown = Object.assign(Object.create(null), { z: 1, a: 2 });
    expect(canonicalJsonStringify(record)).toBe('{"a":2,"z":1}');
    expect(
      canonicalJsonStringify([
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        1.5,
        -0,
      ]),
    ).toBe('[-9007199254740991,9007199254740991,1.5,0]');
  });

  it.each(['object', 'array'])(
    'rejects getter and setter descriptors on an %s without calling them',
    (kind) => {
      for (const mode of ['get', 'set', 'both']) {
        const getter = vi.fn(() => 'unsafe');
        const setter = vi.fn();
        const value = kind === 'array' ? [] : {};
        Object.defineProperty(value, kind === 'array' ? '0' : 'value', {
          enumerable: true,
          ...(mode === 'set' ? {} : { get: getter }),
          ...(mode === 'get' ? {} : { set: setter }),
        });
        expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
        expect(getter).not.toHaveBeenCalled();
        expect(setter).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects proxies, including revoked proxies, before any reflection trap', () => {
    const trap = vi.fn(() => {
      throw new Error('caller code ran');
    });
    for (const target of [{}, [], new Date()]) {
      const proxy = new Proxy(target, {
        get: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
        getOwnPropertyDescriptor: trap,
      });
      expect(() => canonicalJsonStringify(proxy)).toThrow(TypeError);
      expect(() => assertExternalJsonValue(proxy, 0, 2)).toThrow(TypeError);
    }
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => canonicalJsonStringify(revoked.proxy)).toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();
  });

  it('accepts only dense ordinary arrays with enumerable data elements', () => {
    expect(canonicalJsonStringify([])).toBe('[]');
    expect(canonicalJsonStringify([null, { a: 1 }, [true]])).toBe(
      '[null,{"a":1},[true]]',
    );
    expect(canonicalJsonStringify(Object.freeze([1, 2]))).toBe('[1,2]');
    const sparse = new Array<unknown>(2);
    sparse[1] = 1;
    const hidden = [1];
    Object.defineProperty(hidden, '0', { enumerable: false });
    const customPrototype = [1];
    Object.setPrototypeOf(customPrototype, null);
    for (const value of [
      sparse,
      hidden,
      customPrototype,
      new (class extends Array<number> {})(1, 2),
      new Uint8Array([1]),
    ]) {
      expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
    }
  });

  it('rejects subclassed arrays', () => {
    class Values extends Array<number> {}
    expect(() => canonicalJsonStringify(new Values(1, 2))).toThrow(TypeError);
  });

  it('rejects named and symbol array properties even when an element is missing', () => {
    for (const key of ['extra', Symbol('extra')]) {
      const value = new Array<unknown>(1);
      Object.defineProperty(value, key, { enumerable: true, value: 1 });
      expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
    }
  });

  it('cannot create an ordinary array length accessor and rejects a proxy that simulates one', () => {
    const getter = vi.fn(() => 1);
    expect(() => Object.defineProperty([], 'length', { get: getter })).toThrow(
      TypeError,
    );
    const proxy = new Proxy([1], {
      get: (_target, key) => (key === 'length' ? getter() : undefined),
    });
    expect(() => canonicalJsonStringify(proxy)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'enforces inclusive container depth and initialDepth for arrays=%s',
    (arrays) => {
      for (const [initialDepth, maxDepth] of [
        [0, 0],
        [0, 2],
        [1, 3],
        [4, 6],
      ]) {
        if (initialDepth === undefined || maxDepth === undefined)
          throw new Error('missing depth');
        const levels = maxDepth - initialDepth + 1;
        expect(() =>
          assertExternalJsonValue(
            nestedContainers(levels, arrays),
            initialDepth,
            maxDepth,
          ),
        ).not.toThrow();
        expect(() =>
          assertExternalJsonValue(
            nestedContainers(levels + 1, arrays),
            initialDepth,
            maxDepth,
          ),
        ).toThrow(TypeError);
      }
    },
  );

  it('uses the documented zero-based 512 default and does not count scalar leaves', () => {
    for (const arrays of [false, true]) {
      expect(() =>
        canonicalJsonStringify(nestedContainers(513, arrays)),
      ).not.toThrow();
      expect(() =>
        canonicalJsonStringify(nestedContainers(514, arrays)),
      ).toThrow(TypeError);
    }
    expect(() =>
      assertExternalJsonValue({ value: 'scalar' }, 1, 1),
    ).not.toThrow();
    expect(() => assertExternalJsonValue('scalar', 0, 0)).not.toThrow();
  });

  it.each([
    [-1, 2],
    [0, -1],
    [3, 2],
    [0.5, 2],
    [0, 2.5],
    [NaN, 2],
    [0, NaN],
    [0, Infinity],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid depth configuration %s/%s', (initialDepth, maxDepth) => {
    expect(() => assertExternalJsonValue({}, initialDepth, maxDepth)).toThrow(
      TypeError,
    );
  });

  it.each([
    [
      { z: 1, a: 2 },
      { a: 2, z: 1 },
    ],
    [
      { z: [{ b: 2, a: 1 }], a: {} },
      { a: {}, z: [{ a: 1, b: 2 }] },
    ],
    [
      Object.fromEntries([
        ['10', 10],
        ['2', 2],
      ]),
      Object.fromEntries([
        ['2', 2],
        ['10', 10],
      ]),
    ],
  ])('serializes equivalent nested values identically %#', (left, right) => {
    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
  });

  it('serializes 100 seeded generated values identically after recursive key shuffling', () => {
    const random = seededRandom();
    for (let sample = 0; sample < 100; sample += 1) {
      const value = generatedValue(random, 3);
      const expected = canonicalJsonStringify(value);
      for (let shuffle = 0; shuffle < 4; shuffle += 1) {
        expect(canonicalJsonStringify(shuffledValue(value, random))).toBe(
          expected,
        );
      }
    }
  });

  it('rejects object and array cycles but duplicates a shared acyclic child by value', () => {
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(() => canonicalJsonStringify(cyclicArray)).toThrow(TypeError);
    const shared = { z: 1, a: [true] };
    expect(canonicalJsonStringify({ right: shared, left: shared })).toBe(
      '{"left":{"a":[true],"z":1},"right":{"a":[true],"z":1}}',
    );
  });

  it('rejects an early invalid object value before inspecting a later accessor', () => {
    const getter = vi.fn();
    const value = { z: undefined };
    Object.defineProperty(value, 'a', { enumerable: true, get: getter });
    expect(() => canonicalJsonStringify(value)).toThrow(
      'Non-JSON value or excessive nesting.',
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['object', 'array'])(
    'stops at the first invalid member in a large %s',
    (kind) => {
      const trap = vi.fn(() => {
        throw new Error('later subtree visited');
      });
      const later = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap });
      const value =
        kind === 'array'
          ? [undefined, ...Array.from({ length: 10_000 }, () => later)]
          : Object.fromEntries([
              ['z-first', undefined],
              ...Array.from({ length: 10_000 }, (_, index) => [
                `a-later-${index}`,
                later,
              ]),
            ]);
      expect(() => canonicalJsonStringify(value)).toThrow(
        'Non-JSON value or excessive nesting.',
      );
      expect(trap).not.toHaveBeenCalled();
    },
  );
});
