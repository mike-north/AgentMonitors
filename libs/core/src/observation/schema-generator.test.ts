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
    expect(schema.required).toContain('watch');
    expect(schema.required).toContain('urgency');
    expect(schema.required).not.toContain('source');
    expect(schema.required).not.toContain('scope');
    expect(schema.required).not.toContain('event-kind');
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty('event-kind');
    expect(properties).not.toHaveProperty('source');
    expect(properties).not.toHaveProperty('scope');
    expect(properties).toHaveProperty('watch');
    expect(schema.required).toEqual(['watch', 'urgency']);
  });

  it('enumerates source names in watch.type property', () => {
    const schema = generateMonitorSchema([
      makeSource('file-fingerprint', { type: 'object' }),
      makeSource('api-poll', { type: 'object' }),
      makeSource('schedule', { type: 'object' }),
    ]);

    const properties = schema.properties as Record<string, unknown>;
    const watchProp = properties.watch as Record<string, unknown>;
    const watchProperties = watchProp.properties as Record<string, unknown>;
    const typeProp = watchProperties.type as Record<string, unknown>;
    expect(typeProp.enum).toEqual(['file-fingerprint', 'api-poll', 'schedule']);
  });

  it('generates if/then conditionals for each source keyed on watch.type', () => {
    const fpSchema = {
      type: 'object',
      properties: { globs: { type: 'array' } },
      required: ['globs'],
    };
    const schema = generateMonitorSchema([
      makeSource('file-fingerprint', fpSchema),
    ]);

    const allOf = schema.allOf as {
      if: {
        properties: { watch: { properties: { type: { const: string } } } };
      };
      then: { properties: { watch: Record<string, unknown> } };
    }[];
    expect(allOf).toHaveLength(1);

    const conditional = allOf[0];
    expect(conditional?.if.properties.watch.properties.type.const).toBe(
      'file-fingerprint',
    );
    expect(conditional?.then.properties.watch).toEqual(fpSchema);
  });

  it('requires watch.type inside each conditional if (typeless watch must not match every branch)', () => {
    // Regression: without `required: ['type']` on the inner `watch`, JSON
    // Schema `properties` is vacuously satisfied when `watch.type` is absent,
    // so `watch: {}` would match every `if` and apply every `then` — yielding
    // noisy, conflicting per-source errors instead of a clean "type required".
    const schema = generateMonitorSchema([
      makeSource('file-fingerprint', { type: 'object' }),
      makeSource('api-poll', { type: 'object' }),
    ]);

    const allOf = schema.allOf as {
      if: { properties: { watch: { required?: string[] } } };
    }[];
    expect(allOf).toHaveLength(2);
    for (const conditional of allOf) {
      expect(conditional.if.properties.watch.required).toContain('type');
    }
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
    const watchProp = properties.watch as Record<string, unknown>;
    const watchProperties = watchProp.properties as Record<string, unknown>;
    const typeProp = watchProperties.type as Record<string, unknown>;
    expect(typeProp.enum).toEqual([]);
    expect(schema.allOf).toEqual([]);
  });
});
