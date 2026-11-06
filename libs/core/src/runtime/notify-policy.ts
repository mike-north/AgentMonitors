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
        // The dispatcher grants escalation before its immediate/throttle branches too.
        return ['immediate', Math.max(lo, Math.min(hi, rank)) > lo];
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
          return [
            'throttle',
            parseDuration(policy['suppress-for']),
            Math.max(lo, Math.min(hi, rank)) > lo,
          ];
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

/** Private key entries carry only deterministic pacing primitives. */
const policyKeyEntriesSchema = z.array(
  z.array(z.union([z.string(), z.number(), z.boolean()])),
);

/**
 * Preserve clocks when reading the older private encoding, which omitted the
 * immediate/throttle escalation bit. Captured held definitions are compared
 * independently with complete keys, so compatibility cannot hide a real edit's
 * effect on accepted work. With no debounce hold, this grant has no batch to
 * flush and must not reset an otherwise unchanged suppression clock.
 * @internal
 */
export function storedNotifyPolicyMatches(
  stored: string,
  current: string,
): boolean {
  if (stored === current) return true;
  try {
    const previous = policyKeyEntriesSchema.parse(JSON.parse(stored));
    const next = policyKeyEntriesSchema.parse(JSON.parse(current));
    return (
      previous.length === next.length &&
      previous.every((entry, index) => {
        const candidate = next[index];
        if (!candidate) return false;
        const legacyLength =
          entry[0] === 'immediate'
            ? 1
            : entry[0] === 'throttle'
              ? 2
              : undefined;
        // Ignore only a bit absent from the older representation, never an
        // explicitly recorded grant or a change to another pacing parameter.
        const comparable =
          legacyLength !== undefined && entry.length === legacyLength
            ? candidate.slice(0, legacyLength)
            : candidate;
        return JSON.stringify(entry) === JSON.stringify(comparable);
      })
    );
  } catch {
    return false;
  }
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
