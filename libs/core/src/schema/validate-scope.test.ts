import { describe, expect, it } from 'vitest';
import { validateScope } from './validate-scope.js';
import type { JsonSchema } from '../observation/types.js';

const fileFingerprintScope: JsonSchema = {
  type: 'object',
  properties: {
    globs: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
  },
  required: ['globs'],
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

  // Regression: error paths must use 'watch' prefix (the real YAML key), not the
  // historical internal 'scope' prefix — so author-facing messages name the actual key.
  it('prefixes error location with "watch" for nested field errors', () => {
    const errors = validateScope({ globs: 42 }, fileFingerprintScope);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.startsWith('watch'))).toBe(true);
    expect(errors.some((e) => e.startsWith('scope'))).toBe(false);
  });

  it('uses "watch" as location for root-level errors', () => {
    const errors = validateScope({}, fileFingerprintScope);
    expect(errors.some((e) => e.startsWith('watch'))).toBe(true);
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
