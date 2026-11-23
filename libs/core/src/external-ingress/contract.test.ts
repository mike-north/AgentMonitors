/** Contract examples pin resource admission, producer authority and canonical identity. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as json from './json.js';
import * as budget from './envelope-budget.js';
import {
  canonicalJsonStringify,
  externalEventLimits,
  externalEventReservedScopeKeys,
  validateExternalEventEnvelope,
} from './contract.js';
import type { ExternalJsonObject } from './contract.js';
import { envelope, expectError } from './contract.fixtures.js';

/** Count the state root as the first container, independently of scalar leaves. */
function nestedObjectState(levels: number): ExternalJsonObject {
  let result: ExternalJsonObject = { value: true };
  for (let level = 1; level < levels; level += 1) result = { child: result };
  return result;
}

describe('external ingress envelope validation', () => {
  it('accepts a synthetic non-PR current-state event and returns canonical JSON', () => {
    const input = envelope({
      state: { z: 1, nested: { z: false, a: true }, a: 2 },
    });
    const result = validateExternalEventEnvelope(input);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error.message);
    expect(result.envelope).toEqual(input);
    expect(canonicalJsonStringify(result.envelope)).toBe(result.canonicalJson);
    expect(result.canonicalJson).toContain(
      '"state":{"a":2,"nested":{"a":true,"z":false},"z":1}',
    );
    expect(result.envelopeBytes).toBe(
      Buffer.byteLength(result.canonicalJson, 'utf8'),
    );
  });

  it('pins the complete inclusive limits to 002 section 16.1', () => {
    expect(externalEventLimits).toEqual({
      envelopeBytes: 262_144,
      identifierBytes: 512,
      resumeTokenBytes: 2_048,
      scopeKeys: 32,
      scopeBytes: 32_768,
      scopeKeyBytes: 64,
      scopeValuesPerKey: 16,
      scopeValueBytes: 512,
      stateDepth: 32,
    });
  });

  it('keeps exported enforcement metadata immutable at runtime', () => {
    expect(Object.isFrozen(externalEventLimits)).toBe(true);
    expect(Object.isFrozen(externalEventReservedScopeKeys)).toBe(true);
    expect(
      Reflect.set(
        externalEventLimits as unknown as Record<string, number>,
        'identifierBytes',
        999_999,
      ),
    ).toBe(false);
    expectError(
      envelope({
        monitorId: 'x'.repeat(512 + 1),
      }),
      'payload_too_large',
    );
  });

  it('rejects missing and unknown top-level fields without echoing payloads', () => {
    const missing = { ...envelope() } as Record<string, unknown>;
    delete missing['monitorId'];
    expectError(missing, 'invalid_envelope');

    const extra = { ...envelope(), instructions: 'SECRET-INSTRUCTION' };
    const error = expectError(extra, 'invalid_envelope');
    expect(error.message).not.toContain('SECRET-INSTRUCTION');
    expectError(null, 'invalid_envelope');
    expectError([], 'invalid_envelope');
  });

  it('distinguishes unsupported schemas from malformed schema fields', () => {
    expectError(
      envelope({ schema: 'agentmonitors.external-event.v2' as never }),
      'unsupported_schema',
    );
    expectError({ ...envelope(), schema: 1 }, 'invalid_envelope');
  });

  it('validates identifier, sequence, and change-kind fundamentals', () => {
    for (const field of [
      'monitorId',
      'source',
      'upstreamEventId',
      'objectId',
      'eventKind',
    ] as const) {
      expectError(envelope({ [field]: '' }), 'invalid_envelope');
    }
    expect(
      validateExternalEventEnvelope(envelope({ objectSequence: 0 })).success,
    ).toBe(true);
    expect(
      validateExternalEventEnvelope(
        envelope({ objectSequence: Number.MAX_SAFE_INTEGER }),
      ).success,
    ).toBe(true);
    for (const objectSequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectError(envelope({ objectSequence }), 'invalid_envelope');
    }
    expectError(
      envelope({ changeKind: 'updated' as never }),
      'invalid_envelope',
    );
  });

  it('accepts RFC 3339 case variants, arbitrary fractions, offsets, and leap seconds', () => {
    for (const occurredAt of [
      '2026-08-13t18:00:00z',
      '2026-08-13T18:00:00.123456789012345Z',
      '1937-01-01T12:00:27.87+00:20',
      '1990-12-31T23:59:60Z',
      '1990-12-31T18:59:60-05:00',
    ]) {
      expect(
        validateExternalEventEnvelope(envelope({ occurredAt })).success,
      ).toBe(true);
    }
    for (const occurredAt of [
      '',
      '2026-08-13 18:00:00Z',
      '2026-02-30T18:00:00Z',
      '2026-08-13T24:00:00Z',
      '2026-08-13T18:00:00',
      '2026-08-13T18:00:60Z',
      '1990-12-31T23:59:60+01:00',
      '2026-08-13T18:00:00+24:00',
    ]) {
      expectError(envelope({ occurredAt }), 'invalid_envelope');
    }
  });

  it('enforces scope shape, cardinality, and reserved names', () => {
    const maxKeys = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `key${String(index)}`,
        'value',
      ]),
    );
    expect(
      validateExternalEventEnvelope(envelope({ scope: maxKeys })).success,
    ).toBe(true);
    expectError(
      envelope({ scope: { ...maxKeys, overflow: 'value' } }),
      'payload_too_large',
    );
    for (const key of externalEventReservedScopeKeys) {
      expectError(envelope({ scope: { [key]: 'value' } }), 'invalid_envelope');
    }
    expectError(envelope({ scope: { '': 'value' } }), 'invalid_envelope');
    expectError(envelope({ scope: { key: [1] as never } }), 'invalid_envelope');
  });

  it('requires a finite JSON object state with at most 32 container levels', () => {
    expect(validateExternalEventEnvelope(envelope({ state: {} })).success).toBe(
      true,
    );
    expect(
      validateExternalEventEnvelope(envelope({ state: nestedObjectState(32) }))
        .success,
    ).toBe(true);
    expectError(
      envelope({ state: nestedObjectState(33) }),
      'payload_too_large',
    );
    expectError(envelope({ state: [] as never }), 'invalid_envelope');
    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
      1n,
    ]) {
      expectError(envelope({ state: { value } as never }), 'invalid_envelope');
    }
    expectError(envelope({ state: new Date() as never }), 'invalid_envelope');
  });

  it('returns a structured error without invoking nested accessors', () => {
    let calls = 0;
    const values: unknown[] = [];
    Object.defineProperty(values, '0', {
      enumerable: true,
      get: () => {
        calls += 1;
        return 'secret';
      },
    });
    expectError(envelope({ state: { values } as never }), 'invalid_envelope');
    expect(calls).toBe(0);
  });
});

/** Produce strings with an exact UTF-8 size, including odd multibyte boundaries. */
function byteString(bytes: number, multibyte: boolean): string {
  return multibyte
    ? 'é'.repeat(Math.floor(bytes / 2)) + 'x'.repeat(bytes % 2)
    : 'x'.repeat(bytes);
}

/** Keep individual fields valid while filling the independent canonical scope budget. */
function scopeAtBytes(
  bytes: number,
  multibyte = false,
): Record<string, string[]> {
  const scope: Record<string, string[]> = {};
  let remaining = bytes - 2;
  for (let key = 0; remaining > 0; key += 1) {
    const name = `k${String(key)}`;
    const overhead = (key === 0 ? 0 : 1) + name.length + 5;
    remaining -= overhead;
    const values: string[] = [];
    while (remaining > 0 && values.length < 16) {
      const overhead = values.length === 0 ? 2 : 3;
      const size = Math.min(512, remaining - overhead);
      values.push(byteString(size, multibyte));
      remaining -= size + overhead;
    }
    scope[name] = values;
  }
  return scope;
}

describe('external envelope enforcement boundaries', () => {
  for (const multibyte of [false, true]) {
    for (const field of [
      'monitorId',
      'source',
      'upstreamEventId',
      'objectId',
      'eventKind',
      'resumeToken',
    ] as const) {
      it(`bounds ${field} in ${multibyte ? 'multibyte' : 'ASCII'} bytes`, () => {
        const limit = field === 'resumeToken' ? 2_048 : 512;
        expect(
          validateExternalEventEnvelope(
            envelope({ [field]: byteString(limit, multibyte) }),
          ).success,
        ).toBe(true);
        expectError(
          envelope({ [field]: byteString(limit + 1, multibyte) }),
          'payload_too_large',
        );
      });
    }
    for (const field of ['key', 'value'] as const) {
      it(`bounds scope ${field} in ${multibyte ? 'multibyte' : 'ASCII'} bytes`, () => {
        const limit = field === 'key' ? 64 : 512;
        const scope = (bytes: number) =>
          field === 'key'
            ? { [byteString(bytes, multibyte)]: 'value' }
            : { key: byteString(bytes, multibyte) };
        expect(
          validateExternalEventEnvelope(envelope({ scope: scope(limit) }))
            .success,
        ).toBe(true);
        expectError(envelope({ scope: scope(limit + 1) }), 'payload_too_large');
        if (field === 'value') {
          expect(
            validateExternalEventEnvelope(
              envelope({ scope: { key: [byteString(limit, multibyte)] } }),
            ).success,
          ).toBe(true);
          expectError(
            envelope({ scope: { key: [byteString(limit + 1, multibyte)] } }),
            'payload_too_large',
          );
        }
      });
    }
  }
  it('bounds values per scope key', () => {
    expect(
      validateExternalEventEnvelope(
        envelope({
          scope: {
            key: Array.from({ length: 16 }, () => ''),
          },
        }),
      ).success,
    ).toBe(true);
    expectError(
      envelope({
        scope: {
          key: Array.from({ length: 16 + 1 }, () => ''),
        },
      }),
      'payload_too_large',
    );
  });
  for (const multibyte of [false, true]) {
    it(`bounds canonical scope bytes exactly with ${multibyte ? 'multibyte' : 'ASCII'} values`, () => {
      for (const extra of [0, 1]) {
        const scope = scopeAtBytes(32_768 + extra, multibyte);
        expect(Buffer.byteLength(canonicalJsonStringify(scope))).toBe(
          32_768 + extra,
        );
        if (extra === 0)
          expect(
            validateExternalEventEnvelope(envelope({ scope })).success,
          ).toBe(true);
        else expectError(envelope({ scope }), 'payload_too_large');
      }
    });
  }
  for (const escape of ['\n', '"', '\u0001']) {
    it(`bounds canonical scope bytes with ${JSON.stringify(escape)} escapes`, () => {
      for (const bytes of [32_768, 32_769]) {
        // Fill independently with ASCII, then exchange raw bytes for encoded escapes.
        const scope = scopeAtBytes(bytes);
        const values = scope['k0'];
        if (!values) throw new Error('Missing scope fixture values');
        const cost = escape === '\u0001' ? 6 : 2;
        values[0] = escape + 'x'.repeat(512 - cost);
        expect(Buffer.byteLength(canonicalJsonStringify(scope))).toBe(bytes);
        const input = envelope({ scope });
        // The envelope budget cannot mask an off-by-one in its smaller scope budget.
        expect(Buffer.byteLength(canonicalJsonStringify(input))).toBeLessThan(
          262_144,
        );
        if (bytes === 32_768) {
          expect(validateExternalEventEnvelope(input).success).toBe(true);
        } else {
          expectError(input, 'payload_too_large');
        }
      }
    });
  }
  it('bounds canonical envelope bytes including escaping and UTF-8', () => {
    for (const prefix of ['', 'é😀\\\n\u0000\ud800']) {
      const base = envelope({ state: { value: prefix } });
      const padding = 262_144 - Buffer.byteLength(canonicalJsonStringify(base));
      expect(
        validateExternalEventEnvelope(
          envelope({ state: { value: prefix + 'x'.repeat(padding) } }),
        ).success,
      ).toBe(true);
      expectError(
        envelope({ state: { value: prefix + 'x'.repeat(padding + 1) } }),
        'payload_too_large',
      );
    }
  });
  for (const kind of ['object', 'array', 'alternating'] as const) {
    it(`bounds inclusive state container depth through ${kind} paths`, () => {
      const stateAtDepth = (depth: number): ExternalJsonObject => {
        let child: json.ExternalJsonValue = true;
        for (let level = depth; level >= 1; level -= 1)
          child =
            level > 1 &&
            (kind === 'array' || (kind === 'alternating' && level % 2 === 0))
              ? [child]
              : { child };
        return child as ExternalJsonObject;
      };
      expect(
        validateExternalEventEnvelope(envelope({ state: stateAtDepth(32) }))
          .success,
      ).toBe(true);
      expectError(
        envelope({ state: stateAtDepth(32 + 1) }),
        'payload_too_large',
      );
    });
  }
  // Valid policy values pin the authority boundary independently of value syntax.
  for (const [field, value] of Object.entries({
    instructions: 'Report failed builds',
    urgency: 'high',
    notify: { strategy: 'immediate' },
    notifyPolicy: { strategy: 'immediate' },
    workspacePath: '/tmp/producer-workspace',
    monitorPath: '/tmp/producer-monitor',
    path: '/tmp/producer-state',
  })) {
    it(`refuses producer control of ${field}`, () => {
      expectError({ ...envelope(), [field]: value }, 'invalid_envelope');
    });
  }
  it('normalizes ordered equivalents to identical canonical bytes and fingerprints repeatedly', () => {
    const inputs = [
      envelope({
        scope: { z: ['b', 'a'], a: 'x' },
        state: { z: -0, a: { y: 1, x: 'é' } },
      }),
      envelope({
        state: { a: { x: 'é', y: 1 }, z: 0 },
        scope: { a: 'x', z: ['b', 'a'] },
      }),
    ];
    const results = [...inputs, ...inputs].map((input) =>
      validateExternalEventEnvelope(input),
    );
    for (const result of results) {
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected accepted event');
      const first = results[0];
      if (!first?.success) throw new Error('Expected accepted baseline');
      expect(result.envelope).toEqual(first.envelope);
      expect(result.canonicalJson).toBe(first.canonicalJson);
      expect(
        createHash('sha256').update(result.canonicalJson).digest('hex'),
      ).toBe(createHash('sha256').update(first.canonicalJson).digest('hex'));
    }
  });
  it('refuses root proxies without running traps, including revoked proxies', () => {
    const trap = vi.fn(() => Object.prototype);
    expectError(
      new Proxy(envelope(), { getPrototypeOf: trap }),
      'invalid_envelope',
    );
    expect(trap).not.toHaveBeenCalled();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectError(revoked.proxy, 'invalid_envelope');
  });
  it('inherits canonical array, prototype, accessor and numeric policies', () => {
    const sparse = new Array(2);
    const custom = Object.setPrototypeOf([], null);
    const hidden = Object.defineProperty({}, 'secret', { value: true });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('Proxy trap must not run');
        },
      },
    );
    for (const value of [
      sparse,
      custom,
      hidden,
      cyclic,
      proxy,
      new Date(),
      { toJSON: () => ({}) },
      { value: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expectError(envelope({ state: { value } as never }), 'invalid_envelope');
    expect(
      validateExternalEventEnvelope(
        envelope({
          state: { array: Object.freeze([1, { valid: true }]) } as never,
        }),
      ).success,
    ).toBe(true);
  });
});

describe('external envelope budget before canonicalization', () => {
  it('checks actual canonical bytes even if preflight undercounts', () => {
    const count = vi.spyOn(budget, 'envelopeJsonBytes').mockReturnValue(0);
    try {
      expectError(
        envelope({ state: { value: 'é'.repeat(160_000) } }),
        'payload_too_large',
      );
    } finally {
      count.mockRestore();
    }
  });
  it('stops an oversized string before encoding, parsing or visiting its later sibling', () => {
    const encode = vi.spyOn(json, 'canonicalJsonStringify');
    const parse = vi.spyOn(JSON, 'parse');
    const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    const state = {
      first: 'x'.repeat(262_144 + 1),
      later: true,
    };
    try {
      expectError(envelope({ state }), 'payload_too_large');
      expect(encode).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(
        descriptor.mock.calls.some(
          ([value, key]) => value === state && key === 'later',
        ),
      ).toBe(false);
    } finally {
      encode.mockRestore();
      parse.mockRestore();
      descriptor.mockRestore();
    }
  });
  it('stops wide object and array traversal at the first overrun', () => {
    for (const value of [
      Object.fromEntries(
        Array.from({ length: 1000 }, (_, index) => [
          `key${String(index)}`,
          'x'.repeat(512),
        ]),
      ),
      Array.from({ length: 1000 }, () => 'x'.repeat(512)),
    ]) {
      const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');
      const encode = vi.spyOn(json, 'canonicalJsonStringify');
      try {
        expectError(envelope({ state: { value } }), 'payload_too_large');
        expect(encode).not.toHaveBeenCalled();
        expect(
          descriptor.mock.calls.filter(([object]) => object === value).length,
        ).toBeLessThan(520);
      } finally {
        descriptor.mockRestore();
        encode.mockRestore();
      }
    }
  });
  it('refuses excessive depth before canonical encoding', () => {
    const encode = vi.spyOn(json, 'canonicalJsonStringify');
    try {
      expectError(
        envelope({ state: nestedObjectState(1000) }),
        'payload_too_large',
      );
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });
});

/** Subprocesses isolate prototype replacements and cap pathological allocation regressions. */
describe('external envelope isolated admission guarantees', () => {
  for (const scenario of [
    'early-string',
    'early-wide',
    'allocation',
    'iterator-getter',
    'iterator-throw',
    'string-bypass',
    'semantic-intrinsics',
    'error-membership-count',
    'error-membership-throw',
    'refusal-constructors',
    'scope-prototype-hole',
    'dag',
  ]) {
    it(`preserves admission under ${scenario}`, () => {
      const result = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=512',
          '--expose-gc',
          fileURLToPath(
            new URL('./contract-probe.fixture.mjs', import.meta.url),
          ),
          scenario,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }, 35_000);
  }
});

/**
 * Admission catch sites contain anything thrown inside them. Child processes install
 * a throwing descriptor intrinsic before import and cap heap and wall time.
 */
describe('external envelope foreign exception containment', () => {
  for (const scenario of [
    'foreign-envelope-preflight',
    'foreign-scope-preflight',
    'foreign-canonical',
    'getters-envelope-preflight',
    'getters-scope-preflight',
    'getters-canonical',
    'recursion-envelope-preflight',
    'recursion-scope-preflight',
    'recursion-canonical',
  ]) {
    it(`returns invalid_envelope under ${scenario}`, () => {
      const result = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=512',
          fileURLToPath(
            new URL('./contract-probe.fixture.mjs', import.meta.url),
          ),
          scenario,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      // A successful probe prints nothing; output means the caught value was logged.
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    }, 35_000);
  }
});
