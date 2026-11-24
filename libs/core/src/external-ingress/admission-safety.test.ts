/**
 * Envelope-only safety constraints from 002 sections 2.6 and 16.1.
 * JSON encoding remains a general plain-data operation; producer admission owns
 * prototype-key refusal and the RFC 3339 calendar contract.
 */
import { describe, expect, it } from 'vitest';
import { validateExternalEventEnvelope } from './contract.js';
import { envelope, expectError } from './contract.fixtures.js';

describe('external envelope admission safety', () => {
  it('refuses own __proto__ keys from JSON transport at every scope/state depth', () => {
    const inputs: unknown[] = [
      { ...envelope(), scope: JSON.parse('{"__proto__":"x"}') },
      { ...envelope(), state: JSON.parse('{"__proto__":{"polluted":true}}') },
      { ...envelope(), state: JSON.parse('{"nested":{"__proto__":null}}') },
      { ...envelope(), state: JSON.parse('{"items":[{"__proto__":{}}]}') },
    ];
    for (const input of inputs) {
      const error = expectError(input, 'invalid_envelope');
      expect(error.message).not.toContain('polluted');
    }
    // These names are ordinary data: only the legacy prototype setter is refused.
    expect(
      validateExternalEventEnvelope(
        envelope({
          scope: { constructor: 'build', prototype: 'v1' },
          state: { constructor: { prototype: 'data' } },
        }),
      ).success,
    ).toBe(true);
  });

  it('accepts leap-second syntax at every UTC month end including offset spellings', () => {
    const monthEnds = [
      '01-31',
      '02-29',
      '03-31',
      '04-30',
      '05-31',
      '06-30',
      '07-31',
      '08-31',
      '09-30',
      '10-31',
      '11-30',
      '12-31',
    ];
    for (const end of monthEnds) {
      for (const occurredAt of [
        `2028-${end}T23:59:60Z`,
        `2028-${end}t18:59:60.123456789012z`.replace('z', '-05:00'),
      ]) {
        expect(
          validateExternalEventEnvelope(envelope({ occurredAt })).success,
          occurredAt,
        ).toBe(true);
      }
    }
    expect(
      validateExternalEventEnvelope(
        envelope({ occurredAt: '2028-04-01T05:29:60+05:30' }),
      ).success,
    ).toBe(true);
    for (const occurredAt of [
      '2028-03-30T23:59:60Z',
      '2028-09-30T22:59:60Z',
      '2028-03-31T23:59:60+01:00',
    ]) {
      expectError(envelope({ occurredAt }), 'invalid_envelope');
    }
  });
});
