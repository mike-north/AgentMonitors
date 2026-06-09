import { z } from 'zod';

const durationPattern = /^\d+[smhd]$/;

const debounceNotifySchema = z.object({
  strategy: z.literal('debounce'),
  'settle-for': z
    .string()
    .regex(
      durationPattern,
      'Must be a duration string (e.g., "5m", "30s", "1h")',
    ),
});

const throttleNotifySchema = z.object({
  strategy: z.literal('throttle'),
  'suppress-for': z
    .string()
    .regex(
      durationPattern,
      'Must be a duration string (e.g., "5m", "30s", "1h")',
    ),
});

const notifySchema = z.discriminatedUnion('strategy', [
  debounceNotifySchema,
  throttleNotifySchema,
]);

/**
 * The `watch` block — an intent-first, discriminated description of what to
 * observe. `type` names the observation source (kebab-case, matches a source
 * plugin name); the remaining keys are per-source configuration carried flat
 * alongside `type`.
 */
const watchSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, 'watch.type must be kebab-case'),
  })
  .catchall(z.unknown());

export const monitorFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1, 'Monitor name must be non-empty when present')
    .optional(),
  watch: watchSchema,
  urgency: z.enum(['low', 'normal', 'high']),
  notify: notifySchema.optional(),
  tags: z.array(z.string()).optional(),
});

export type MonitorFrontmatter = z.infer<typeof monitorFrontmatterSchema>;
export type NotifyConfig = z.infer<typeof notifySchema>;

export { notifySchema, debounceNotifySchema, throttleNotifySchema };
