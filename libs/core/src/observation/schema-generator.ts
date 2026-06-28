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
      // `required: ['type']` on the inner `watch` is essential: JSON Schema
      // `properties` constraints are vacuously satisfied when the property is
      // absent, so without it a typeless `watch: {}` would match every `if` and
      // apply every `then` — producing noisy, conflicting per-source errors
      // instead of a clean "watch.type is required".
      properties: {
        watch: {
          properties: { type: { const: source.name } },
          required: ['type'],
        },
      },
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
    // Only `watch` is required. `urgency` is optional and defaults to `normal`
    // in the parser (001 §3.2), so the generated JSON Schema must not mark it
    // required — otherwise editor tooling would flag a valid minimal monitor.
    required: ['watch'],
    properties: {
      name: { type: 'string', minLength: 1 },
      watch: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: sourceNames },
        },
      },
      // A bare level (`normal`) or an authored band `lo..hi` (`normal..high`).
      // This editor-hint schema enforces only the *shape* of each bound; the
      // authoritative parser (`monitorFrontmatterSchema`) additionally rejects
      // an inverted range (`lo > hi`). See 001 §3.2.
      //
      // Leading/trailing whitespace is allowed (`\s*` anchors at both ends)
      // to mirror the Zod parser, which calls `.trim()` on the raw value
      // before validating bounds. Whitespace around `..` was already allowed.
      urgency: {
        type: 'string',
        pattern:
          '^\\s*(low|normal|high)(\\s*\\.\\.\\s*(low|normal|high))?\\s*$',
      },
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
          {
            // Scheduled-rollup Pace mode (001 §3.6). `window` is a five-field
            // cron expression defining the recurring delivery time; `timezone`
            // is an optional IANA zone (defaults to UTC at runtime).
            properties: {
              strategy: { const: 'rollup' },
              window: {
                type: 'string',
                pattern: '^\\s*\\S+(?:\\s+\\S+){4}\\s*$',
              },
              timezone: { type: 'string', minLength: 1 },
            },
            required: ['strategy', 'window'],
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
