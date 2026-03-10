import { describe, expect, it } from 'vitest';
import { generateMonitorSchema } from './schema-generator.js';
import type { ObservationSource } from './types.js';

function makeSource(
  name: string,
  scopeSchema: Record<string, unknown>,
): ObservationSource {
  return {
    name,
    scopeSchema,
    observe: () => Promise.resolve([]),
  };
}

describe('generateMonitorSchema', () => {
  it('produces a valid JSON Schema structure', () => {
    const schema = generateMonitorSchema([
      makeSource('file-fingerprint', {
        type: 'object',
        properties: { globs: { type: 'array', items: { type: 'string' } } },
        required: ['globs'],
      }),
    ]);

    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('source');
    expect(schema.required).toContain('scope');
  });

  it('enumerates source names in the source property', () => {
    const schema = generateMonitorSchema([
      makeSource('file-fingerprint', { type: 'object' }),
      makeSource('api-poll', { type: 'object' }),
      makeSource('schedule', { type: 'object' }),
    ]);

    const properties = schema.properties as Record<string, unknown>;
    const sourceProp = properties.source as Record<string, unknown>;
    expect(sourceProp.enum).toEqual([
      'file-fingerprint',
      'api-poll',
      'schedule',
    ]);
  });

  it('generates if/then conditionals for each source', () => {
    const fpSchema = {
      type: 'object',
      properties: { globs: { type: 'array' } },
      required: ['globs'],
    };
    const schema = generateMonitorSchema([
      makeSource('file-fingerprint', fpSchema),
    ]);

    const allOf = schema.allOf as {
      if: { properties: { source: { const: string } } };
      then: { properties: { scope: Record<string, unknown> } };
    }[];
    expect(allOf).toHaveLength(1);

    const conditional = allOf[0];
    expect(conditional?.if.properties.source.const).toBe('file-fingerprint');
    expect(conditional?.then.properties.scope).toEqual(fpSchema);
  });

  it('includes notify schema with debounce and throttle', () => {
    const schema = generateMonitorSchema([]);

    const properties = schema.properties as Record<string, unknown>;
    const notify = properties.notify as Record<string, unknown>;
    expect(notify.type).toBe('object');
    expect(notify.oneOf).toHaveLength(2);
  });

  it('handles empty sources list', () => {
    const schema = generateMonitorSchema([]);

    const properties = schema.properties as Record<string, unknown>;
    const sourceProp = properties.source as Record<string, unknown>;
    expect(sourceProp.enum).toEqual([]);
    expect(schema.allOf).toEqual([]);
  });
});
