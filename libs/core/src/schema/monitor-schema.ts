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

export const monitorFrontmatterSchema = z.object({
  name: z.string().min(1, 'Monitor name is required'),
  source: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'Source must be kebab-case'),
  urgency: z.enum(['low', 'normal', 'high']),
  'event-kind': z.enum(['mutation', 'notification', 'alert']),
  scope: z.record(z.string(), z.unknown()),
  notify: notifySchema.optional(),
  tags: z.array(z.string()).optional(),
});

export type MonitorFrontmatter = z.infer<typeof monitorFrontmatterSchema>;
export type NotifyConfig = z.infer<typeof notifySchema>;

export { notifySchema, debounceNotifySchema, throttleNotifySchema };
