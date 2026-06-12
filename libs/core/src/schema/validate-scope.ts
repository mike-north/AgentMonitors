import { Validator, type Schema } from '@cfworker/json-schema';
import type { JsonSchema } from '../observation/types.js';

/**
 * Validate a monitor's `scope` object against a source's `scopeSchema` fragment
 * using full JSON Schema (draft-07) semantics — types, enums, `required`, `items`,
 * and so on — not just required-field presence.
 *
 * Returns a list of human-readable error messages; an empty array means the scope
 * is valid for that source.
 *
 * Uses `@cfworker/json-schema`, which validates by walking the schema at runtime
 * rather than compiling with the `Function` constructor, so it is safe under
 * restrictive CSP and Workers-style environments.
 *
 * @param scope - The monitor's source-specific `scope` object.
 * @param scopeSchema - The source's `scopeSchema` JSON Schema fragment.
 */
export function validateScope(
  scope: Record<string, unknown>,
  scopeSchema: JsonSchema,
): string[] {
  // `JsonSchema` is an opaque `Record<string, unknown>`; cfworker's `Schema` is the
  // structured draft type. The cast is safe because a source's `scopeSchema` is, by
  // contract (AP4), a JSON Schema object.
  const validator = new Validator(scopeSchema as unknown as Schema, '7', false);
  const result = validator.validate(scope);
  if (result.valid) return [];

  const messages = result.errors.map((unit) => {
    const location =
      unit.instanceLocation && unit.instanceLocation !== '#'
        ? unit.instanceLocation.replace(/^#/, 'watch')
        : 'watch';
    return `${location}: ${unit.error}`;
  });

  // cfworker can emit several units for one underlying failure (a leaf error plus
  // its parent keyword); collapse exact duplicates for a cleaner report.
  return [...new Set(messages)];
}
