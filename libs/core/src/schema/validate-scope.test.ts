import { describe, expect, it } from 'vitest';
import {
  invalidTimezoneError,
  isValidIanaTimeZone,
  validateScope,
  validateWatchScope,
} from './validate-scope.js';
import type { JsonSchema } from '../observation/types.js';

const fileFingerprintScope: JsonSchema = {
  type: 'object',
  properties: {
    globs: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
  },
  required: ['globs'],
};

// Mirrors plugins/source-schedule's scopeSchema (`cron` required, `timezone`
// optional) — libs/core cannot import the plugin package (plugins depend on
// core, not vice versa), so the shape is reproduced here as it is elsewhere in
// this file for other sources.
const scheduleScope: JsonSchema = {
  type: 'object',
  properties: {
    cron: { type: 'string' },
    timezone: { type: 'string' },
    label: { type: 'string' },
  },
  required: ['cron'],
};

describe('validateScope', () => {
  it('accepts a scope that satisfies the schema', () => {
    expect(validateScope({ globs: ['*.ts'] }, fileFingerprintScope)).toEqual(
      [],
    );
  });

  it('accepts a scope with valid optional fields', () => {
    expect(
      validateScope({ globs: ['*.ts'], cwd: '/repo' }, fileFingerprintScope),
    ).toEqual([]);
  });

  // The pre-G2 validator only checked field *presence*; these are the cases it
  // silently accepted and full JSON Schema validation must now reject.
  it('rejects a missing required field', () => {
    const errors = validateScope({}, fileFingerprintScope);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/globs/);
  });

  it('rejects a present-but-wrong-typed field', () => {
    const errors = validateScope({ globs: 42 }, fileFingerprintScope);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ').toLowerCase()).toMatch(/array|type/);
  });

  it('rejects a wrong item type within an array', () => {
    const errors = validateScope({ globs: [42] }, fileFingerprintScope);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-enum value', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        strategy: { enum: ['text-diff', 'json-diff', 'status-code'] },
      },
    };
    const errors = validateScope({ strategy: 'magic' }, schema);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('isValidIanaTimeZone', () => {
  it('accepts a real IANA zone name', () => {
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
  });

  it("rejects a typo'd/non-IANA zone name", () => {
    expect(isValidIanaTimeZone('America/New_Yrok')).toBe(false);
    expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
    expect(isValidIanaTimeZone('')).toBe(false);
  });
});

describe('invalidTimezoneError', () => {
  it('returns undefined when timezone is absent', () => {
    expect(
      invalidTimezoneError({ cron: '* * * * *' }, scheduleScope),
    ).toBeUndefined();
  });

  it('returns undefined for a valid IANA timezone', () => {
    expect(
      invalidTimezoneError(
        {
          cron: '* * * * *',
          timezone: 'America/Los_Angeles',
        },
        scheduleScope,
      ),
    ).toBeUndefined();
  });

  it('returns an actionable error for an invalid timezone', () => {
    const error = invalidTimezoneError(
      {
        cron: '* * * * *',
        timezone: 'Not/AZone',
      },
      scheduleScope,
    );
    expect(error).toContain('Not/AZone');
    expect(error).toMatch(/valid IANA time zone name/);
  });

  it('defers to the JSON Schema type check for a non-string timezone', () => {
    // A wrong-typed value is validateScope()'s job to report; this helper must
    // not double-report it under a different message.
    expect(
      invalidTimezoneError({ cron: '* * * * *', timezone: 42 }, scheduleScope),
    ).toBeUndefined();
  });

  // PR #433 review: a source whose scopeSchema does NOT declare a `timezone`
  // property must never have an unrelated extra `timezone` key rejected as an
  // invalid IANA name — that key isn't governed by this source's contract at
  // all, and most scopeSchemas don't set `additionalProperties: false` (AP4),
  // so JSON Schema itself silently accepts it.
  it('returns undefined when scopeSchema does not declare a timezone property, even for a bogus value', () => {
    expect(
      invalidTimezoneError(
        { globs: ['*.ts'], timezone: 'not even a real value' },
        fileFingerprintScope,
      ),
    ).toBeUndefined();
  });
});

// Regression test for issue #297: a schedule monitor's `scope.timezone` must be
// rejected at authoring time (surfaced by `validate` and `watch declare`, both
// of which call validateWatchScope) instead of only failing much later when
// Intl.DateTimeFormat throws deep inside runtime cron matching.
describe('validateWatchScope — schedule timezone (issue #297)', () => {
  it('accepts a schedule scope with a valid timezone', () => {
    expect(
      validateWatchScope(
        { cron: '0 9 * * 1-5', timezone: 'America/New_York' },
        scheduleScope,
      ),
    ).toEqual([]);
  });

  it('accepts a schedule scope with no timezone (defaults to UTC at runtime)', () => {
    expect(validateWatchScope({ cron: '0 9 * * 1-5' }, scheduleScope)).toEqual(
      [],
    );
  });

  it('rejects a schedule scope with an invalid IANA timezone', () => {
    const errors = validateWatchScope(
      { cron: '0 9 * * 1-5', timezone: 'Not/AZone' },
      scheduleScope,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('Not/AZone');
  });

  // Regression test for PR #433 review (discussion_r3608549682): the
  // supplemental timezone check must be gated on the SOURCE'S OWN scopeSchema
  // declaring a `timezone` property — not applied unconditionally to every
  // source. Without the gate, a monitor for an unrelated source (here
  // file-fingerprint, whose scopeSchema has no `timezone` field) that happens
  // to carry an extra `timezone` key — previously silently accepted, since
  // most scopeSchemas don't set `additionalProperties: false` — would be
  // wrongly rejected with a schedule-specific "not a valid IANA time zone
  // name" error. This test must FAIL pre-fix.
  it('accepts a non-schedule source scope with a bogus extra `timezone` field (PR #433 review)', () => {
    expect(
      validateWatchScope(
        { globs: ['*.ts'], timezone: 'not even a real value' },
        fileFingerprintScope,
      ),
    ).toEqual([]);
  });
});
