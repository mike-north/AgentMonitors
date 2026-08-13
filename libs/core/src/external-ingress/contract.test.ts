import { describe, expect, it } from 'vitest';
import {
  canonicalJsonStringify,
  externalEventLimits,
  externalEventReservedScopeKeys,
  validateExternalEventEnvelope,
} from './contract.js';
import type { ExternalJsonObject } from './contract.js';
import { envelope, expectError } from './contract.fixtures.js';

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
        monitorId: 'x'.repeat(externalEventLimits.identifierBytes + 1),
      }),
      'invalid_envelope',
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
      Array.from({ length: externalEventLimits.scopeKeys }, (_, index) => [
        `key${String(index)}`,
        'value',
      ]),
    );
    expect(
      validateExternalEventEnvelope(envelope({ scope: maxKeys })).success,
    ).toBe(true);
    expectError(
      envelope({ scope: { ...maxKeys, overflow: 'value' } }),
      'invalid_envelope',
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
    expectError(envelope({ state: nestedObjectState(33) }), 'invalid_envelope');
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
