/** Effective pacing identity, independent of captured delivery content and source execution. */
import { z } from 'zod';
import { notifySchema } from '../schema/monitor-schema.js';
import type { Urgency, MonitorDefinition } from '../schema/types.js';
import type { NotifyRuntimeState } from './types.js';
import { defaultNotifyConfigForUrgency } from './types.js';
import { parseDuration } from '../notify/notifier.js';

/** Persisted private metadata lets retired suppression/window guards reset after restart. @internal */
export type PolicyNotifyState = NotifyRuntimeState & { policyKey?: string };

/**
 * Compare the effective policy over every possible salience, including omission.
 * This distinguishes changes to urgency-dependent defaults without treating a
 * body/title edit or equivalent duration spelling as a pacing change.
 * @internal
 */
export function notifyPolicyKey(monitor: {
  frontmatter: Pick<MonitorDefinition['frontmatter'], 'urgency' | 'notify'> & {
    urgencyMax?: Urgency;
  };
}): string {
  const levels = ['low', 'normal', 'high'] as const;
  const lo = levels.indexOf(monitor.frontmatter.urgency);
  const hi = levels.indexOf(
    monitor.frontmatter.urgencyMax ?? monitor.frontmatter.urgency,
  );
  if (lo < 0 || hi < lo) {
    throw new Error('Captured monitor has no valid urgency band.');
  }
  return JSON.stringify(
    [lo, 0, 1, 2].map((rank) => {
      const urgency = levels[Math.max(lo, Math.min(hi, rank))];
      if (!urgency) {
        throw new Error('Captured monitor has no effective urgency.');
      }
      const policy = defaultNotifyConfigForUrgency(
        urgency,
        monitor.frontmatter.notify,
      );
      if (!policy) {
        return ['immediate'];
      }
      switch (policy.strategy) {
        case 'debounce':
          // Escalation is also pacing: while a debounce batch exists, this
          // grant flushes it early even when the explicit duration is unchanged.
          return [
            'debounce',
            parseDuration(policy['settle-for']),
            Math.max(lo, Math.min(hi, rank)) > lo,
          ];
        case 'throttle':
          return ['throttle', parseDuration(policy['suppress-for'])];
        case 'rollup':
          return [
            'rollup',
            policy.window.trim().replace(/\s+/g, ' '),
            policy.timezone ?? 'UTC',
          ];
      }
    }),
  );
}

/** Only the persisted semantics needed for a truthful edit drain are required. */
const capturedEnvelopeSchema = z.object({
  monitor: z.object({
    id: z.string(),
    filePath: z.string(),
    instructions: z.string(),
    frontmatter: z.object({
      watch: z.object({ type: z.string().min(1) }),
      urgency: z.enum(['low', 'normal', 'high']),
      urgencyMax: z.enum(['low', 'normal', 'high']).optional(),
      notify: notifySchema.optional(),
    }),
  }),
  observation: z.object({ title: z.string() }),
  observedAt: z
    .union([z.date(), z.string()])
    .refine((value) => Number.isFinite(new Date(value).getTime())),
  effectiveUrgency: z.enum(['low', 'normal', 'high']).optional(),
});

/** Validate older-version data without repairing it from a current definition. @internal */
export function validateCapturedNotifyEnvelope(
  envelope: unknown,
  monitorId: string,
): void {
  const parsed = capturedEnvelopeSchema.safeParse(envelope);
  if (!parsed.success || parsed.data.monitor.id !== monitorId) {
    throw new Error('Held observation has incomplete captured semantics.');
  }
}

/** Read diagnostic provenance independently of a damaged envelope's content. */
const capturedRouteSchema = z.object({
  monitor: z.object({
    filePath: z.string(),
    frontmatter: z.object({ watch: z.object({ type: z.string() }) }),
  }),
});

/** Missing provenance is reported as unknown, never used to materialize an event. @internal */
export function capturedNotifyRoute(envelope: unknown): {
  filePath?: string;
  sourceName?: string;
} {
  const parsed = capturedRouteSchema.safeParse(envelope);
  return parsed.success
    ? {
        filePath: parsed.data.monitor.filePath,
        sourceName: parsed.data.monitor.frontmatter.watch.type,
      }
    : {};
}
