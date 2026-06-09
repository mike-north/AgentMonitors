import type { JsonSchema, ObservationSource } from './types.js';

/**
 * Compose a full JSON Schema from installed plugins' scopeSchema fragments.
 *
 * Produces a schema where the top-level `watch.type` field discriminates
 * which per-source config keys are valid via `if/then` conditional schemas.
 * Each source's `scopeSchema` describes the per-source config keys that live
 * flat inside the `watch:` block alongside `type`.
 */
export function generateMonitorSchema(
  sources: ObservationSource[],
): JsonSchema {
  const sourceNames = sources.map((s) => s.name);

  const conditionals = sources.map((source) => ({
    if: {
      properties: { watch: { properties: { type: { const: source.name } } } },
      required: ['watch'],
    },
    then: {
      properties: { watch: source.scopeSchema },
    },
  }));

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Agent Monitor Definition',
    type: 'object',
    required: ['watch', 'urgency'],
    properties: {
      name: { type: 'string', minLength: 1 },
      watch: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: sourceNames },
        },
      },
      urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      notify: {
        type: 'object',
        required: ['strategy'],
        oneOf: [
          {
            properties: {
              strategy: { const: 'debounce' },
              'settle-for': {
                type: 'string',
                pattern: '^\\d+[smhd]$',
              },
            },
            required: ['strategy', 'settle-for'],
          },
          {
            properties: {
              strategy: { const: 'throttle' },
              'suppress-for': {
                type: 'string',
                pattern: '^\\d+[smhd]$',
              },
            },
            required: ['strategy', 'suppress-for'],
          },
        ],
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    allOf: conditionals,
  };
}
