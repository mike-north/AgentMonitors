/** Plain-data refusal, traversal order and canonical bytes at the external boundary. */
import { createSecretKey, generateKeyPairSync, webcrypto } from 'node:crypto';
import { inspect, types } from 'node:util';
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

/** Each factory creates fresh intrinsic state before its visible prototype changes. */
const intrinsicFactories: readonly (readonly [string, () => object])[] = [
  ['Date', () => new Date(0)],
  ['RegExp', () => /value/u],
  ['Map', () => new Map([['secret', 1]])],
  ['Set', () => new Set([1])],
  ['WeakMap', () => new WeakMap()],
  ['WeakSet', () => new WeakSet()],
  ['boxed number', () => Object(2)],
  ['boxed boolean', () => Object(true)],
  ['boxed string', () => Object('value')],
  ['boxed bigint', () => Object(2n)],
  ['boxed symbol', () => Object(Symbol('value'))],
  ['typed array', () => new Uint8Array([1, 2])],
  ['ArrayBuffer', () => new ArrayBuffer(2)],
  ['SharedArrayBuffer', () => new SharedArrayBuffer(2)],
  ['DataView', () => new DataView(new ArrayBuffer(2))],
  ['Promise', () => Promise.resolve(1)],
  ['Error', () => new Error('secret')],
  ['Map iterator', () => new Map().entries()],
  ['Set iterator', () => new Set().values()],
  [
    'generator',
    () =>
      (function* () {
        yield 1;
      })(),
  ],
  [
    'arguments',
    () =>
      (function () {
        // eslint-disable-next-line prefer-rest-params -- Needs a genuine arguments object to exercise its native brand.
        return arguments;
      })(),
  ],
  ['KeyObject', () => createSecretKey(new Uint8Array(16))],
  ['array posing as a record', () => [1, 2]],
];

describe('external JSON intrinsic-state refusal', () => {
  describe.each([
    ['null', null],
    ['Object.prototype', Object.prototype],
  ] as const)('replacement prototype %s', (_name, prototype) => {
    it.each(intrinsicFactories)(
      'rejects %s through validation',
      (_brand, create) => {
        const value = Object.setPrototypeOf(create(), prototype);
        expect(() => assertExternalJsonValue(value, 0, 512)).toThrow(TypeError);
      },
    );
    it.each(intrinsicFactories)(
      'rejects %s through encoding',
      (_brand, create) => {
        const value = Object.setPrototypeOf(create(), prototype);
        expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
      },
    );

    it('rejects CryptoKey through both entry points', async () => {
      const key = await webcrypto.subtle.importKey(
        'raw',
        new Uint8Array(16),
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign'],
      );
      Object.setPrototypeOf(key, prototype);
      expect(() => assertExternalJsonValue(key, 0, 512)).toThrow(TypeError);
      expect(() => canonicalJsonStringify(key)).toThrow(TypeError);
    });
  });

  it('rejects intrinsic state without consulting serialization or brand hooks', () => {
    const hook = vi.fn(() => {
      throw new Error('caller code ran');
    });
    const value = Object.setPrototypeOf(new Date(0), null);
    Object.defineProperty(value, Symbol.toStringTag, { get: hook });
    Object.defineProperty(value, 'toJSON', { get: hook });
    expect(() => assertExternalJsonValue(value, 0, 512)).toThrow(TypeError);
    expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('external JSON supported depth range', () => {
  it.each([false, true])(
    'accepts exactly depth 512 and rejects depth 513 for arrays=%s',
    (arrays) => {
      expect(() =>
        assertExternalJsonValue(nestedContainers(513, arrays), 0, 512),
      ).not.toThrow();
      expect(() =>
        assertExternalJsonValue(nestedContainers(514, arrays), 0, 512),
      ).toThrow(TypeError);
      expect(() =>
        assertExternalJsonValue(nestedContainers(2, arrays), 511, 512),
      ).not.toThrow();
      expect(() =>
        assertExternalJsonValue(nestedContainers(3, arrays), 511, 512),
      ).toThrow(TypeError);
    },
  );

  it.each([513, 99_999, Number.MAX_SAFE_INTEGER])(
    'refuses unsupported maximum %s before inspecting input',
    (maxDepth) => {
      const trap = vi.fn(() => {
        throw new Error('input inspected');
      });
      expect(() =>
        assertExternalJsonValue(new Proxy({}, { ownKeys: trap }), 0, maxDepth),
      ).toThrow('Invalid JSON depth bounds.');
      expect(() => assertExternalJsonValue('scalar', 0, maxDepth)).toThrow(
        'Invalid JSON depth bounds.',
      );
      expect(trap).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'refuses a 100,000-container chain with an unsupported maximum without RangeError for arrays=%s',
    (arrays) => {
      const value = nestedContainers(100_000, arrays);
      expect(() => assertExternalJsonValue(value, 0, 99_999)).toThrow(
        'Invalid JSON depth bounds.',
      );
      expect(() => assertExternalJsonValue(value, 0, 99_998)).toThrow(
        'Invalid JSON depth bounds.',
      );
    },
  );

  it('supports envelope depth 34 and state depth 32', () => {
    expect(() =>
      assertExternalJsonValue(nestedContainers(35, false), 0, 32 + 2),
    ).not.toThrow();
    expect(() =>
      assertExternalJsonValue(nestedContainers(36, false), 0, 32 + 2),
    ).toThrow(TypeError);
    expect(() =>
      assertExternalJsonValue(nestedContainers(32, false), 1, 32),
    ).not.toThrow();
  });
});

describe('external JSON canonical byte vectors', () => {
  it.each([
    ['large positive exponent', 1e21],
    ['large negative exponent', -1.5e300],
  ])('refuses %s because it is an unsafe integer', (_name, value) => {
    expect(Number.isInteger(value)).toBe(true);
    expect(Number.isSafeInteger(value)).toBe(false);
    expect(() => canonicalJsonStringify(value)).toThrow('Invalid JSON number.');
    expect(() => assertExternalJsonValue(value, 0, 512)).toThrow(
      'Invalid JSON number.',
    );
  });

  it.each([
    ['minimum safe integer', Number.MIN_SAFE_INTEGER, '-9007199254740991'],
    ['maximum safe integer', Number.MAX_SAFE_INTEGER, '9007199254740991'],
    ['positive fraction', 1.5, '1.5'],
    ['negative fraction', -0.125, '-0.125'],
    ['small exponent', 1e-7, '1e-7'],
    ['smallest positive number', 5e-324, '5e-324'],
    ['negative zero', -0, '0'],
  ])('encodes %s with explicit numeric bytes', (_name, value, expected) => {
    expect(canonicalJsonStringify(value)).toBe(expected);
    expect(() => assertExternalJsonValue(value, 0, 512)).not.toThrow();
  });

  it.each([
    ['quote', '"', '"\\""'],
    ['backslash', '\\', '"\\\\"'],
    ['nul', '\u0000', '"\\u0000"'],
    ['start of heading', '\u0001', '"\\u0001"'],
    ['start of text', '\u0002', '"\\u0002"'],
    ['end of text', '\u0003', '"\\u0003"'],
    ['end of transmission', '\u0004', '"\\u0004"'],
    ['enquiry', '\u0005', '"\\u0005"'],
    ['acknowledge', '\u0006', '"\\u0006"'],
    ['bell', '\u0007', '"\\u0007"'],
    ['backspace', '\b', '"\\b"'],
    ['tab', '\t', '"\\t"'],
    ['newline', '\n', '"\\n"'],
    ['vertical tab', '\u000b', '"\\u000b"'],
    ['form feed', '\f', '"\\f"'],
    ['carriage return', '\r', '"\\r"'],
    ['shift out', '\u000e', '"\\u000e"'],
    ['shift in', '\u000f', '"\\u000f"'],
    ['data link escape', '\u0010', '"\\u0010"'],
    ['device control one', '\u0011', '"\\u0011"'],
    ['device control two', '\u0012', '"\\u0012"'],
    ['device control three', '\u0013', '"\\u0013"'],
    ['device control four', '\u0014', '"\\u0014"'],
    ['negative acknowledge', '\u0015', '"\\u0015"'],
    ['synchronous idle', '\u0016', '"\\u0016"'],
    ['end of transmission block', '\u0017', '"\\u0017"'],
    ['cancel', '\u0018', '"\\u0018"'],
    ['end of medium', '\u0019', '"\\u0019"'],
    ['substitute', '\u001a', '"\\u001a"'],
    ['escape', '\u001b', '"\\u001b"'],
    ['file separator', '\u001c', '"\\u001c"'],
    ['group separator', '\u001d', '"\\u001d"'],
    ['record separator', '\u001e', '"\\u001e"'],
    ['unit separator', '\u001f', '"\\u001f"'],
    ['delete', '\u007f', '"\u007f"'],
    ['non-ASCII Unicode', '雪éΩ', '"雪éΩ"'],
    ['astral character', '😀', '"😀"'],
    ['lone high surrogate', '\ud800', '"\\ud800"'],
    ['lone low surrogate', '\udfff', '"\\udfff"'],
    ['embedded lone surrogates', 'a\ud800b\udfffc', '"a\\ud800b\\udfffc"'],
  ])(
    'encodes %s with explicit string bytes and round-trips',
    (_name, value, expected) => {
      const encoded = canonicalJsonStringify(value);
      expect(encoded).toBe(expected);
      expect(JSON.parse(encoded)).toBe(value);
      expect(() => assertExternalJsonValue(value, 0, 512)).not.toThrow();
    },
  );
});

/** Both public entry points share the same refusal and hook-freedom contract. */
const jsonEntryPoints = [
  ['encoding', canonicalJsonStringify],
  ['validation', (value: unknown) => assertExternalJsonValue(value, 0, 512)],
] as const;

/** These symbols are discoverable by callers and cannot be trusted as brands. */
const cryptoKeyType = Object.getOwnPropertySymbols(
  createSecretKey(new Uint8Array(16)),
).find((symbol) => symbol.description === 'kKeyType');
// Newer Node keys use private slots; symbol-specific cases do not apply there.

describe.each(jsonEntryPoints)('external JSON hook-free %s', (_entry, run) => {
  it.each([false, true])(
    'refuses a proxy prototype without reading it, array=%s',
    (array) => {
      const hook = vi.fn(() => {
        throw new Error('caller code ran');
      });
      const value = Object.setPrototypeOf(
        array ? [] : {},
        new Proxy(
          {},
          {
            get: hook,
            getPrototypeOf: hook,
            ownKeys: hook,
            getOwnPropertyDescriptor: hook,
          },
        ),
      );
      expect(() => run(value)).toThrow(TypeError);
      expect(hook).not.toHaveBeenCalled();
    },
  );

  describe.each([null, Object.prototype])(
    'record prototype %s',
    (prototype) => {
      it.skipIf(!cryptoKeyType)(
        'refuses an own real crypto-symbol accessor without reading it (symbol-backed runtimes only)',
        () => {
          if (!cryptoKeyType)
            throw new Error('Symbol-backed fixture required.');
          const hook = vi.fn(() => {
            throw new Error('caller code ran');
          });
          const value: object = Object.create(prototype);
          Object.defineProperty(value, cryptoKeyType, { get: hook });
          expect(() => run(value)).toThrow(TypeError);
          expect(hook).not.toHaveBeenCalled();
        },
      );

      it.skipIf(!cryptoKeyType).each(['KeyObject', 'CryptoKey'])(
        'refuses %s without reading its own crypto-symbol accessor',
        async (brand) => {
          if (!cryptoKeyType)
            throw new Error('Symbol-backed fixture required.');
          const value =
            brand === 'KeyObject'
              ? createSecretKey(new Uint8Array(16))
              : await webcrypto.subtle.importKey(
                  'raw',
                  new Uint8Array(16),
                  { name: 'HMAC', hash: 'SHA-256' },
                  true,
                  ['sign'],
                );
          Object.setPrototypeOf(value, prototype);
          const hook = vi.fn(() => {
            throw new Error('caller code ran');
          });
          Object.defineProperty(value, cryptoKeyType, { get: hook });
          expect(() => run(value)).toThrow(TypeError);
          expect(hook).not.toHaveBeenCalled();
        },
      );
    },
  );
});

/** Read-only witnesses establish that refusal preserves each receiver's state. */
const readOnlyIntrinsicFixtures: readonly (readonly [
  string,
  () => object,
  (value: object) => unknown,
])[] = [
  [
    'WeakRef',
    () => new WeakRef({ secret: 1 }),
    (value) => Reflect.apply(WeakRef.prototype.deref, value, []),
  ],
  [
    'FinalizationRegistry',
    () =>
      new FinalizationRegistry(() => {
        /* Finalization timing is outside the synchronous refusal contract. */
      }),
    () => 'registration checked separately',
  ],
  [
    'URL',
    () => new URL('https://example.test/secret?a=1'),
    (value) => Reflect.apply(URL.prototype.toString, value, []),
  ],
  [
    'URLSearchParams',
    () => new URLSearchParams('secret=one&secret=two'),
    (value) => Reflect.apply(URLSearchParams.prototype.toString, value, []),
  ],
  [
    'Intl.Collator',
    () => new Intl.Collator('de'),
    (value) =>
      Reflect.apply(Intl.Collator.prototype.resolvedOptions, value, []),
  ],
  [
    'Intl.DateTimeFormat',
    () => new Intl.DateTimeFormat('en', { timeZone: 'UTC' }),
    (value) =>
      Reflect.apply(Intl.DateTimeFormat.prototype.resolvedOptions, value, []),
  ],
  [
    'Intl.NumberFormat',
    () => new Intl.NumberFormat('de'),
    (value) =>
      Reflect.apply(Intl.NumberFormat.prototype.resolvedOptions, value, []),
  ],
  [
    'Intl.PluralRules',
    () => new Intl.PluralRules('en'),
    (value) =>
      Reflect.apply(Intl.PluralRules.prototype.resolvedOptions, value, []),
  ],
  [
    'Intl.RelativeTimeFormat',
    () => new Intl.RelativeTimeFormat('en'),
    (value) =>
      Reflect.apply(
        Intl.RelativeTimeFormat.prototype.resolvedOptions,
        value,
        [],
      ),
  ],
  [
    'Intl.ListFormat',
    () => new Intl.ListFormat('en'),
    (value) =>
      Reflect.apply(Intl.ListFormat.prototype.resolvedOptions, value, []),
  ],
  [
    'Intl.Locale',
    () => new Intl.Locale('fr-FR'),
    (value) => Reflect.apply(Intl.Locale.prototype.toString, value, []),
  ],
  [
    'Intl.DisplayNames',
    () => new Intl.DisplayNames('en', { type: 'language' }),
    (value) =>
      Reflect.apply(Intl.DisplayNames.prototype.resolvedOptions, value, []),
  ],
  [
    'Intl.Segmenter',
    () => new Intl.Segmenter('en'),
    (value) =>
      Reflect.apply(Intl.Segmenter.prototype.resolvedOptions, value, []),
  ],
  [
    'Intl.DurationFormat',
    () => new Intl.DurationFormat('en'),
    (value) =>
      Reflect.apply(Intl.DurationFormat.prototype.resolvedOptions, value, []),
  ],
];

describe.each(jsonEntryPoints)(
  'external JSON read-only intrinsic refusal through %s',
  (_entry, run) => {
    describe.each([null, Object.prototype])(
      'replacement prototype %s',
      (prototype) => {
        it.each(readOnlyIntrinsicFixtures)(
          'refuses %s while preserving its state',
          (_brand, create, witness) => {
            const value = Object.setPrototypeOf(create(), prototype);
            const before = witness(value);
            expect(() => run(value)).toThrow(TypeError);
            expect(witness(value)).toEqual(before);
          },
        );
        it.each(readOnlyIntrinsicFixtures)(
          'refuses %s without consulting caller hooks',
          (_brand, create) => {
            const value = Object.setPrototypeOf(create(), prototype);
            const hook = vi.fn(() => {
              throw new Error('caller code ran');
            });
            for (const key of [
              Symbol.toStringTag,
              Symbol.toPrimitive,
              'toJSON',
              'constructor',
            ]) {
              Object.defineProperty(value, key, {
                enumerable: true,
                get: hook,
              });
            }
            expect(() => run(value)).toThrow(TypeError);
            expect(hook).not.toHaveBeenCalled();
          },
        );
        it('preserves existing finalization registrations', () => {
          const registry = new FinalizationRegistry(() => {
            /* Finalization timing is outside the synchronous refusal contract. */
          });
          const target = {};
          const token = {};
          registry.register(target, 'held', token);
          Object.setPrototypeOf(registry, prototype);
          expect(() => run(registry)).toThrow(TypeError);
          expect(
            Reflect.apply(FinalizationRegistry.prototype.unregister, registry, [
              token,
            ]),
          ).toBe(true);
        });
        it('does not synchronize pending URL query changes', () => {
          const value = new URL('https://example.test/?before=1');
          value.searchParams.set('after', '2');
          Object.setPrototypeOf(value, prototype);
          expect(() => run(value)).toThrow(TypeError);
          expect(Reflect.apply(URL.prototype.toString, value, [])).toBe(
            'https://example.test/?before=1&after=2',
          );
        });
      },
    );

    it('accepts records with method-shaped data without calling them', () => {
      const value = {
        deref: 'data',
        unregister: true,
        resolvedOptions: 1,
        protocol: 'data',
        size: 2,
      };
      expect(() => run(value)).not.toThrow();
    });
  },
);

/** Genuine keys exercise native/private state independently of visible symbols. */
const realKeyFixtures: readonly (readonly [string, () => Promise<object>])[] = [
  ['secret KeyObject', async () => createSecretKey(new Uint8Array(16))],
  ...(['rsa', 'ec', 'ed25519'] as const).flatMap((algorithm) =>
    (['publicKey', 'privateKey'] as const).map(
      (part) =>
        [
          `${algorithm} ${part} KeyObject`,
          async () => {
            const pair =
              algorithm === 'rsa'
                ? generateKeyPairSync('rsa', { modulusLength: 1024 })
                : algorithm === 'ec'
                  ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
                  : generateKeyPairSync('ed25519');
            return pair[part];
          },
        ] as const,
    ),
  ),
  [
    'HMAC CryptoKey',
    async () =>
      webcrypto.subtle.importKey(
        'raw',
        new Uint8Array(16),
        { name: 'HMAC', hash: 'SHA-256' },
        true,
        ['sign'],
      ),
  ],
  ...(
    [
      { name: 'ECDSA', namedCurve: 'P-256' },
      { name: 'Ed25519' },
      {
        name: 'RSA-PSS',
        hash: 'SHA-256',
        modulusLength: 1024,
        publicExponent: new Uint8Array([1, 0, 1]),
      },
    ] as const
  ).flatMap((algorithm) =>
    (['publicKey', 'privateKey'] as const).map(
      (part) =>
        [
          `${algorithm.name} ${part} CryptoKey`,
          async () => {
            // Sign/verify generation always produces a pair for these algorithms.
            const pair = await webcrypto.subtle.generateKey(algorithm, true, [
              'sign',
              'verify',
            ]);
            if (!('publicKey' in pair)) throw new Error('Key pair required.');
            return pair[part];
          },
        ] as const,
    ),
  ),
];

describe.each(jsonEntryPoints)(
  'external JSON genuine keys through %s',
  (_entry, run) => {
    describe.each([null, Object.prototype])(
      'replacement prototype %s',
      (prototype) => {
        it.each(realKeyFixtures)(
          'refuses %s on every runtime',
          async (_name, create) => {
            const key = await create();
            const original = Object.getPrototypeOf(key) as unknown;
            Object.setPrototypeOf(key, prototype);
            try {
              expect(() => run(key)).toThrow(TypeError);
            } finally {
              Object.setPrototypeOf(key, original);
            }
            if (types.isKeyObject(key)) {
              const bytes =
                key.type === 'secret'
                  ? key.export()
                  : key.export({
                      format: 'der',
                      type: key.type === 'private' ? 'pkcs8' : 'spki',
                    });
              expect(bytes.byteLength).toBeGreaterThan(0);
            } else if (types.isCryptoKey(key)) {
              const bytes = await webcrypto.subtle.exportKey(
                key.type === 'secret'
                  ? 'raw'
                  : key.type === 'private'
                    ? 'pkcs8'
                    : 'spki',
                key,
              );
              expect(bytes.byteLength).toBeGreaterThan(0);
            } else {
              throw new Error('Genuine crypto fixture required.');
            }
          },
        );
      },
    );
  },
);

/** Each witness observes data and an already-started cursor after refusal. */
const additionalIntrinsicFixtures: readonly (readonly [
  string,
  () => { value: object; witness: () => void },
])[] = [
  [
    'Intl.Segments',
    () => {
      const value = new Intl.Segmenter('en', { granularity: 'word' }).segment(
        'one two',
      );
      const original = Object.getPrototypeOf(value) as unknown;
      const cursor = value[Symbol.iterator]();
      const containing = value.containing.bind(value);
      expect(cursor.next().value?.segment).toBe('one');
      return {
        value,
        witness: () => {
          Object.setPrototypeOf(value, original);
          expect(containing(0)?.segment).toBe('one');
          expect(cursor.next().value?.segment).toBe(' ');
          expect(cursor.next().value?.segment).toBe('two');
        },
      };
    },
  ],
];

describe.each(jsonEntryPoints)(
  'external JSON additional intrinsic refusal through %s',
  (_entry, run) => {
    describe.each([null, Object.prototype])(
      'replacement prototype %s',
      (prototype) => {
        it.each(additionalIntrinsicFixtures)(
          'refuses %s and preserves state and existing cursor',
          (_name, create) => {
            const { value, witness } = create();
            Object.setPrototypeOf(value, prototype);
            expect(() => run(value)).toThrow(TypeError);
            witness();
          },
        );
        it.each(additionalIntrinsicFixtures)(
          'refuses %s without calling receiver hooks',
          (_name, create) => {
            const { value, witness } = create();
            const hook = vi.fn(() => {
              throw new Error('caller code ran');
            });
            Object.setPrototypeOf(value, prototype);
            for (const key of [
              inspect.custom,
              Symbol.toStringTag,
              Symbol.iterator,
              'toJSON',
              'constructor',
              'containing',
              'entries',
            ]) {
              Object.defineProperty(value, key, {
                get: hook,
                configurable: true,
              });
            }
            expect(() => run(value)).toThrow(TypeError);
            expect(hook).not.toHaveBeenCalled();
            witness();
          },
        );
      },
    );

    it('refuses a non-record prototype before invoking intrinsic-state probes', () => {
      for (const make of [
        () => new WeakRef({}),
        () => new URL('https://example.test/'),
        () => new Intl.Collator('en'),
      ]) {
        expect(() => run(Object.setPrototypeOf(make(), {}))).toThrow(
          'Non-plain JSON object.',
        );
      }
    });
    it('rejects an own descriptor before crypto predicates can read it', () => {
      const hook = vi.fn(() => {
        throw new Error('caller code ran');
      });
      const value = {};
      Object.defineProperty(value, Symbol('untrusted'), { get: hook });
      expect(() => run(value)).toThrow('Non-JSON object key.');
      expect(hook).not.toHaveBeenCalled();
    });
  },
);

/** Post-import prototype changes must not make record validation execute hooks. */
describe.each(jsonEntryPoints)(
  'external JSON crypto representation through %s',
  (_entry, run) => {
    it('ignores post-load inherited crypto-symbol getters (symbol-backed runtimes only)', async ({
      skip,
    }) => {
      const keys = [
        createSecretKey(new Uint8Array(16)),
        await webcrypto.subtle.importKey(
          'raw',
          new Uint8Array(16),
          { name: 'HMAC', hash: 'SHA-256' },
          true,
          ['sign'],
        ),
      ];
      const symbols = [
        ...new Set(keys.flatMap(Object.getOwnPropertySymbols)),
      ].filter((symbol) =>
        ['kKeyType', 'kKeyObject'].includes(symbol.description ?? ''),
      );
      if (symbols.length === 0) {
        skip(
          'Private-brand runtimes expose no crypto symbols for inherited getters.',
        );
        return;
      }
      let calls = 0;
      for (const symbol of symbols) {
        const original = Object.getOwnPropertyDescriptor(
          Object.prototype,
          symbol,
        );
        Object.defineProperty(Object.prototype, symbol, {
          configurable: true,
          get() {
            calls += 1;
            return undefined;
          },
        });
        try {
          for (const prototype of [null, Object.prototype]) {
            const value: object = Object.assign(Object.create(prototype), {
              safe: 1,
            });
            run(value);
          }
        } finally {
          if (original) {
            Object.defineProperty(Object.prototype, symbol, original);
          } else {
            Reflect.deleteProperty(Object.prototype, symbol);
          }
        }
      }
      expect(calls).toBe(0);
    });

    it('refuses the first bad child before crypto key refusal', () => {
      const key = Object.setPrototypeOf(
        createSecretKey(new Uint8Array(16)),
        Object.prototype,
      );
      Object.defineProperty(key, 'first', { enumerable: true, value: NaN });
      expect(() => run(key)).toThrow('Invalid JSON number.');
    });

    it('refuses the first bad descriptor before crypto key refusal', () => {
      const key = Object.setPrototypeOf(
        createSecretKey(new Uint8Array(16)),
        Object.prototype,
      );
      const hook = vi.fn(() => {
        throw new Error('caller code ran');
      });
      Object.defineProperty(key, 'first', { enumerable: true, get: hook });
      expect(() => run(key)).toThrow('Accessor or hidden property.');
      expect(hook).not.toHaveBeenCalled();
    });
  },
);

describe.each(jsonEntryPoints)(
  'external JSON unsupported FormData through %s',
  (_entry, run) => {
    it.each([null, Object.prototype])(
      'does not inspect stored array methods with prototype %s',
      (prototype) => {
        // FormData accepts arrays with File.prototype. Its inspector can mistake
        // an already-stored array for its own temporary duplicate-value array.
        const file: object = Object.setPrototypeOf([], File.prototype);
        const hook = vi.fn(() => {
          throw new Error('stored caller code ran');
        });
        Object.defineProperty(file, 'push', { get: hook });
        const value = new FormData();
        value.append('file', file as Blob);
        value.append('file', file as Blob);
        const original = Object.getPrototypeOf(value) as unknown;
        Object.setPrototypeOf(value, prototype);
        // No detection outcome is promised outside the plain-data domain.
        try {
          run(value);
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
        }
        expect(hook).not.toHaveBeenCalled();
        Object.setPrototypeOf(value, original);
        const stored = value.getAll('file');
        expect(stored).toHaveLength(2);
        expect(stored[0]).toBe(file);
        expect(stored[1]).toBe(file);
      },
    );
  },
);

/** Prototype edits are confined to synchronous calls and always restored before assertions. */
describe.each(jsonEntryPoints)(
  'external JSON post-load descriptor fields through %s',
  (_entry, run) => {
    describe.each(['record', 'array'] as const)('container %s', (kind) => {
      describe.each(['value', 'enumerable', 'get', 'set'] as const)(
        'ignores inherited %s when refusing accessors',
        (field) => {
          it.each([false, true])('inherited getter=%s', (inheritedGetter) => {
            let inputCalls = 0;
            let inheritedCalls = 0;
            const value = kind === 'record' ? {} : [];
            const accessor = {
              __proto__: null,
              enumerable: true,
              configurable: true,
              get() {
                inputCalls += 1;
                return 123;
              },
              set(_value: unknown) {
                inputCalls += 1;
              },
            };
            Object.defineProperty(
              value,
              kind === 'record' ? 'x' : '0',
              accessor,
            );
            const original = Object.getOwnPropertyDescriptor(
              Object.prototype,
              field,
            );
            // Null-prototype descriptor arguments remain valid even while the
            // descriptor vocabulary itself is present on Object.prototype.
            const poison = inheritedGetter
              ? {
                  __proto__: null,
                  configurable: true,
                  get() {
                    inheritedCalls += 1;
                    return 7;
                  },
                }
              : { __proto__: null, configurable: true, value: 7 };
            let error: unknown;
            try {
              Object.defineProperty(Object.prototype, field, poison);
              try {
                run(value);
              } catch (caught) {
                error = caught;
              }
            } finally {
              Reflect.deleteProperty(Object.prototype, field);
              if (original)
                Object.defineProperty(Object.prototype, field, original);
            }
            expect(error).toBeInstanceOf(TypeError);
            if (error instanceof Error) {
              expect(error.message).toBe('Accessor or hidden property.');
            }
            expect(inputCalls).toBe(0);
            expect(inheritedCalls).toBe(0);
          });
        },
      );

      it.each(['enumerable', 'get', 'set'] as const)(
        'accepts data properties without reading inherited %s',
        (field) => {
          let calls = 0;
          const value = kind === 'record' ? { x: 7 } : [7];
          const original = Object.getOwnPropertyDescriptor(
            Object.prototype,
            field,
          );
          let error: unknown;
          let result: unknown;
          try {
            const poison = {
              __proto__: null,
              configurable: true,
              get() {
                calls += 1;
                throw new Error('inherited descriptor hook');
              },
            };
            Object.defineProperty(Object.prototype, field, poison);
            try {
              result = run(value);
            } catch (caught) {
              error = caught;
            }
          } finally {
            Reflect.deleteProperty(Object.prototype, field);
            if (original)
              Object.defineProperty(Object.prototype, field, original);
          }
          expect(error).toBeUndefined();
          if (_entry === 'encoding') {
            expect(result).toBe(kind === 'record' ? '{"x":7}' : '[7]');
          }
          expect(calls).toBe(0);
        },
      );
    });
  },
);

/** Headers is outside the plain-data domain; its inspector must never execute. */
describe.each(jsonEntryPoints)(
  'external JSON unsupported Headers through %s',
  (_entry, run) => {
    describe.each([null, Object.prototype])(
      'record prototype %s',
      (prototype) => {
        it.each([false, true])(
          'never invokes an inherited header setter throwing=%s',
          (throws) => {
            const name = 'x-review-499';
            const value = new Headers([[name, 'one']]);
            const originalPrototype = Object.getPrototypeOf(value) as unknown;
            const original = Object.getOwnPropertyDescriptor(
              Object.prototype,
              name,
            );
            let calls = 0;
            let error: unknown;
            Object.setPrototypeOf(value, prototype);
            try {
              Object.defineProperty(Object.prototype, name, {
                configurable: true,
                set() {
                  calls += 1;
                  if (throws) throw new Error('inherited header setter');
                },
              });
              // Unsupported inputs have no promised detection result, but probing
              // them must not execute caller code or alter their stored contents.
              try {
                run(value);
              } catch (caught) {
                error = caught;
              }
            } finally {
              Reflect.deleteProperty(Object.prototype, name);
              if (original)
                Object.defineProperty(Object.prototype, name, original);
              Object.setPrototypeOf(value, originalPrototype);
            }
            if (error !== undefined) expect(error).toBeInstanceOf(TypeError);
            expect(calls).toBe(0);
            expect(value.get(name)).toBe('one');
          },
        );
      },
    );
  },
);
