/**
 * Read-only descriptions of accepted notify batches. Callers supply the same
 * scoped notify state release uses; current definitions never replace captured
 * pacing semantics. Throttle suppression contains no accepted work to count.
 */
import { z } from 'zod';
import { notifySchema } from '../schema/monitor-schema.js';
import { EPHEMERAL_MONITOR_ID_PREFIX } from './types.js';

import type {
  HeldNotifyBarrier,
  HeldNotifyWork,
  MonitorExplainStage,
  NotifyRuntimeState,
} from './types.js';

/** Remedies describe existing authority; none can discard or resurrect accepted work. */
const barrierRemedies: Record<HeldNotifyBarrier, string> = {
  none: '',
  'definition-rejected':
    'Release is blocked by the rejected definition. Fix the definition so the runtime can release this work under its notify policy.',
  'source-unavailable':
    'The source is unavailable. Restore the source registration so the runtime can release this work under its notify policy.',
  'owner-inactive':
    'The ephemeral owner is inactive or due for dormancy reaping; no future tick will release this work under this owner. There is no definition file to edit.',
  'declaration-retired':
    'The ephemeral declaration is retired; no future tick will release this work, and there is no definition file to edit.',
  'workspace-mismatch':
    'The ephemeral declaration belongs to another workspace. Inspect this work in its declaring workspace; this workspace cannot release it.',
  'declaration-invalid':
    'The ephemeral declaration cannot be rebuilt or validated. The declaration cannot be edited; restore a compatible source or declare a replacement. A replacement does not release this retained batch.',
  'retained-work':
    'Earlier retained materialization work must complete first. Inspect the materialization retry diagnostics and repair terminal retries before this batch can release.',
  'capture-invalid':
    'Held observation has incomplete or invalid captured semantics. Restore the captured data from a trusted backup; the current definition cannot repair accepted envelopes.',
};

/** Capture is untrusted on reads: legacy holds may lack any nested metadata. */
const capturedNotifySchema = z.object({
  monitor: z.object({ frontmatter: z.object({ notify: notifySchema }) }),
});

/** Describe each nonempty durable batch without evaluating or changing release. @internal */
export function describeHeldNotifyWork(
  monitorId: string,
  state: NotifyRuntimeState,
  barrier: HeldNotifyBarrier,
  now: Date,
): HeldNotifyWork[] {
  const holds: HeldNotifyWork[] = [];
  // Preserve the persistent-definition flag's meaning for unresolved sources;
  // lifecycle and captured-work barriers do not turn into fictitious file errors.
  const blockedByDefinition =
    barrier === 'definition-rejected' ||
    (barrier === 'source-unavailable' &&
      !monitorId.startsWith(EPHEMERAL_MONITOR_ID_PREFIX));
  const remedy = barrierRemedies[barrier];
  const debounce = state.pendingDebounce;
  if (debounce && debounce.observations.length > 0) {
    const overdue = new Date(debounce.dueAt) <= now;
    holds.push({
      monitorId,
      strategy: 'debounce',
      observations: debounce.observations.length,
      blockedByDefinition,
      releaseBarrier: barrier,
      dueAt: debounce.dueAt,
      overdue,
      reason: remedy
        ? `debounce is holding ${String(debounce.observations.length)} observation(s). ${remedy}`
        : overdue
          ? `debounce settle window has elapsed; ${String(debounce.observations.length)} observation(s) await the next daemon tick eligible under the notify policy.`
          : `debounce is holding ${String(debounce.observations.length)} observation(s); its stored settle window ends at ${debounce.dueAt}.`,
    });
  }
  const rollup = state.pendingRollup;
  if (rollup && rollup.observations.length > 0) {
    // Captured envelopes survive definition rejection and effective policy edits.
    // An absent legacy window stays unknown rather than borrowing a new policy.
    const captured = capturedNotifySchema.safeParse(rollup.observations[0]);
    const notify = captured.success
      ? captured.data.monitor.frontmatter.notify
      : undefined;
    const window = notify?.strategy === 'rollup' ? notify.window : 'unknown';
    const timezone =
      notify?.strategy === 'rollup' ? (notify.timezone ?? 'UTC') : 'unknown';
    holds.push({
      monitorId,
      strategy: 'rollup',
      observations: rollup.observations.length,
      blockedByDefinition,
      releaseBarrier: barrier,
      window,
      timezone,
      reason: remedy
        ? `rollup is holding ${String(rollup.observations.length)} observation(s). ${remedy}`
        : `rollup is holding ${String(rollup.observations.length)} observation(s); its captured window is ${window}.`,
    });
  }
  return holds;
}

/** A single notify stage accounts for both batches in mixed legacy state. @internal */
export function heldNotifyStage(
  holds: readonly HeldNotifyWork[],
): MonitorExplainStage | undefined {
  const first = holds[0];
  if (!first) {
    return undefined;
  }
  return {
    id: 'notify',
    label: 'Notify state',
    status: 'pending',
    reason: holds.map((hold) => hold.reason).join(' '),
    details:
      holds.length === 1
        ? { ...first }
        : {
            observations: holds.reduce(
              (count, hold) => count + hold.observations,
              0,
            ),
            holds,
          },
  };
}
