import type { JsonSchema, ObservationSource } from './types.js';

/**
 * Compose a full JSON Schema from installed plugins' scopeSchema fragments.
 *
 * Produces a schema where the top-level `source` field discriminates
 * which `scope` shape is valid via `if/then` conditional schemas.
 */
export function generateMonitorSchema(
  sources: ObservationSource[],
): JsonSchema {
  const sourceNames = sources.map((s) => s.name);

  const conditionals = sources.map((source) => ({
    if: {
      properties: { source: { const: source.name } },
      required: ['source'],
    },
    then: {
      properties: { scope: source.scopeSchema },
    },
  }));

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Agent Monitor Definition',
    type: 'object',
    required: ['source', 'urgency', 'scope'],
    properties: {
      name: { type: 'string', minLength: 1 },
      source: { type: 'string', enum: sourceNames },
      urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      scope: { type: 'object' },
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
