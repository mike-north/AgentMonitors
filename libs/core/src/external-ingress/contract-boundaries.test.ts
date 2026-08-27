import { describe, expect, it } from 'vitest';
import {
  canonicalJsonStringify,
  externalEventLimits,
  validateExternalEventEnvelope,
} from './contract.js';
import type {
  ExternalEventEnvelope,
  ExternalEventScope,
  ExternalJsonObject,
  ExternalJsonValue,
} from './contract.js';
import { envelope, expectError } from './contract.fixtures.js';
import {
  externalEventObjectKey,
  externalEventSemanticHash,
} from './identity.js';

function exactUtf8(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes === 1) return 'x';
  return `${'x'.repeat(bytes - 2)}é`;
}

function scopeWithCanonicalBytes(targetBytes: number): ExternalEventScope {
  const scope: Record<string, string[]> = Object.fromEntries(
    Array.from({ length: 4 }, (_, key) => [
      `k${String(key)}`,
      Array.from({ length: externalEventLimits.scopeValuesPerKey }, () => ''),
    ]),
  );
  let remaining =
    targetBytes - Buffer.byteLength(canonicalJsonStringify(scope), 'utf8');
  for (const values of Object.values(scope)) {
    for (let index = 0; index < values.length && remaining > 0; index += 1) {
      const bytes = Math.min(externalEventLimits.scopeValueBytes, remaining);
      values[index] = exactUtf8(bytes);
      remaining -= bytes;
    }
  }
  if (remaining !== 0) throw new Error('scope target exceeds test capacity');
  expect(Buffer.byteLength(canonicalJsonStringify(scope), 'utf8')).toBe(
    targetBytes,
  );
  return scope;
}

function nestedState(
  levels: number,
  mode: 'object' | 'array' | 'alternating',
): ExternalJsonObject {
  let current: ExternalJsonValue = true;
  for (let level = levels; level > 1; level -= 1) {
    const arrayLevel =
      mode === 'array' || (mode === 'alternating' && level % 2 === 0);
    current = arrayLevel ? [current] : { child: current };
  }
  return { child: current };
}

describe('external ingress exact boundaries', () => {
  it('enforces 511/512/513 UTF-8 bytes for every identifier', () => {
    for (const field of [
      'monitorId',
      'source',
      'upstreamEventId',
      'objectId',
      'eventKind',
    ] as const) {
      for (const bytes of [511, 512]) {
        expect(
          validateExternalEventEnvelope(envelope({ [field]: exactUtf8(bytes) }))
            .success,
        ).toBe(true);
      }
      expectError(envelope({ [field]: exactUtf8(513) }), 'invalid_envelope');
    }
  });

  it('enforces exact multibyte token, scope-key, and scope-value limits', () => {
    expect(
      validateExternalEventEnvelope(
        envelope({
          resumeToken: exactUtf8(externalEventLimits.resumeTokenBytes),
        }),
      ).success,
    ).toBe(true);
    expectError(
      envelope({
        resumeToken: exactUtf8(externalEventLimits.resumeTokenBytes + 1),
      }),
      'invalid_envelope',
    );
    expectError(envelope({ resumeToken: '' }), 'invalid_envelope');

    expect(
      validateExternalEventEnvelope(
        envelope({
          scope: { [exactUtf8(externalEventLimits.scopeKeyBytes)]: 'v' },
        }),
      ).success,
    ).toBe(true);
    expectError(
      envelope({
        scope: { [exactUtf8(externalEventLimits.scopeKeyBytes + 1)]: 'v' },
      }),
      'invalid_envelope',
    );
    expect(
      validateExternalEventEnvelope(
        envelope({
          scope: { key: exactUtf8(externalEventLimits.scopeValueBytes) },
        }),
      ).success,
    ).toBe(true);
    expectError(
      envelope({
        scope: { key: exactUtf8(externalEventLimits.scopeValueBytes + 1) },
      }),
      'invalid_envelope',
    );
  });

  it('returns invalid_envelope without throwing for every scalar field runtime type', () => {
    const fields = [
      'monitorId',
      'source',
      'upstreamEventId',
      'objectId',
      'eventKind',
      'occurredAt',
      'resumeToken',
    ] as const;
    const wrongTypes: unknown[] = [123, true, null, [], {}];
    for (const field of fields) {
      for (const value of wrongTypes) {
        const input = { ...envelope(), [field]: value };
        expect(() => validateExternalEventEnvelope(input)).not.toThrow();
        expectError(input, 'invalid_envelope');
      }
    }
  });

  it('covers both sequence boundaries and non-number inputs', () => {
    for (const objectSequence of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(
        validateExternalEventEnvelope(envelope({ objectSequence })).success,
      ).toBe(true);
    }
    for (const objectSequence of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1',
      null,
    ]) {
      expectError({ ...envelope(), objectSequence }, 'invalid_envelope');
    }
  });

  it('enforces the exact canonical multibyte scope limit', () => {
    const exact = scopeWithCanonicalBytes(externalEventLimits.scopeBytes);
    expect(
      validateExternalEventEnvelope(envelope({ scope: exact })).success,
    ).toBe(true);
    expectError(
      envelope({
        scope: scopeWithCanonicalBytes(externalEventLimits.scopeBytes + 1),
      }),
      'payload_too_large',
    );
  });

  it('counts object, array, and alternating state depth per path', () => {
    for (const mode of ['object', 'array', 'alternating'] as const) {
      expect(
        validateExternalEventEnvelope(
          envelope({ state: nestedState(32, mode) }),
        ).success,
      ).toBe(true);
      expectError(
        envelope({ state: nestedState(33, mode) }),
        'invalid_envelope',
      );
    }
    expect(
      validateExternalEventEnvelope(
        envelope({
          state: {
            left: nestedState(31, 'alternating'),
            right: nestedState(31, 'array'),
          },
        }),
      ).success,
    ).toBe(true);
  });

  it('accepts the exact multibyte envelope limit and rejects one byte more', () => {
    const base = envelope({ state: { padding: '' } });
    const initial = validateExternalEventEnvelope(base);
    expect(initial.success).toBe(true);
    if (!initial.success) throw new Error(initial.error.message);
    const paddingBytes =
      externalEventLimits.envelopeBytes - initial.envelopeBytes;
    const exact = validateExternalEventEnvelope(
      envelope({ state: { padding: exactUtf8(paddingBytes) } }),
    );
    expect(exact.success).toBe(true);
    if (!exact.success) throw new Error(exact.error.message);
    expect(exact.envelopeBytes).toBe(externalEventLimits.envelopeBytes);
    expectError(
      envelope({ state: { padding: exactUtf8(paddingBytes + 1) } }),
      'payload_too_large',
    );
  });
});

describe('external ingress semantic identity', () => {
  it('hashes every field except resumeToken with canonical object-key order', () => {
    const base = envelope({
      scope: { z: 'last', a: ['two', 'one'] },
      state: { z: 1, nested: { z: 2, a: [2, 1] }, a: 0 },
    });
    const reordered = envelope({
      scope: { a: ['two', 'one'], z: 'last' },
      state: { a: 0, nested: { a: [2, 1], z: 2 }, z: 1 },
      resumeToken: 'different-transport-cursor',
    });
    expect(externalEventSemanticHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(externalEventSemanticHash(reordered)).toBe(
      externalEventSemanticHash(base),
    );

    const mutations = {
      schema: envelope({ schema: 'agentmonitors.external-event.v2' as never }),
      monitorId: envelope({ monitorId: 'other-monitor' }),
      source: envelope({ source: 'other-source' }),
      upstreamEventId: envelope({ upstreamEventId: 'other-delivery' }),
      objectId: envelope({ objectId: 'other-object' }),
      objectSequence: envelope({ objectSequence: 43 }),
      eventKind: envelope({ eventKind: 'build.completed' }),
      changeKind: envelope({ changeKind: 'created' }),
      occurredAt: envelope({ occurredAt: '2026-08-13T18:00:01Z' }),
      scope: envelope({ scope: { project: 'other/project' } }),
      state: envelope({ state: { nested: { a: [1, 2], z: 2 }, a: 0, z: 1 } }),
    } satisfies Record<
      Exclude<keyof ExternalEventEnvelope, 'resumeToken'>,
      ExternalEventEnvelope
    >;
    expect(Object.keys(mutations).sort()).toEqual(
      Object.keys(base)
        .filter((field) => field !== 'resumeToken')
        .sort(),
    );
    for (const changed of Object.values(mutations)) {
      expect(externalEventSemanticHash(changed)).not.toBe(
        externalEventSemanticHash(base),
      );
    }
  });

  it('builds a collision-free source/object tuple key', () => {
    expect(externalEventObjectKey('a:b', 'c')).not.toBe(
      externalEventObjectKey('a', 'b:c'),
    );
    expect(externalEventObjectKey('source', 'object')).toBe(
      'external:["source","object"]',
    );
    expect(externalEventObjectKey('a"]', '["b')).not.toBe(
      externalEventObjectKey('a', '"]["b'),
    );
  });
});
