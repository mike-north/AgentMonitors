/**
 * Read-only descriptions of accepted notify batches. Callers supply the same
 * scoped notify state release uses; current definitions never replace captured
 * pacing semantics. Throttle suppression contains no accepted work to count.
 */
import type {
  HeldNotifyWork,
  MonitorExplainStage,
  NotifyRuntimeState,
} from './types.js';

/** Describe each nonempty durable batch without evaluating or changing release. @internal */
export function describeHeldNotifyWork(
  monitorId: string,
  state: NotifyRuntimeState,
  blockedByDefinition: boolean,
  now: Date,
): HeldNotifyWork[] {
  const holds: HeldNotifyWork[] = [];
  const repair = blockedByDefinition
    ? ' Fix the definition so the runtime can release this work under its notify policy.'
    : '';
  const debounce = state.pendingDebounce;
  if (debounce && debounce.observations.length > 0) {
    const overdue = new Date(debounce.dueAt) <= now;
    holds.push({
      monitorId,
      strategy: 'debounce',
      observations: debounce.observations.length,
      blockedByDefinition,
      dueAt: debounce.dueAt,
      overdue,
      reason: blockedByDefinition
        ? `debounce is holding ${String(debounce.observations.length)} observation(s); release is blocked by the rejected definition.${repair}`
        : overdue
          ? `debounce settle window has elapsed; ${String(debounce.observations.length)} observation(s) will be flushed on the next daemon tick.`
          : `debounce is holding ${String(debounce.observations.length)} observation(s) until ${debounce.dueAt}.`,
    });
  }
  const rollup = state.pendingRollup;
  if (rollup && rollup.observations.length > 0) {
    // Captured envelopes survive definition rejection and effective policy edits.
    // An absent legacy window stays unknown rather than borrowing a new policy.
    const notify = rollup.observations[0]?.monitor.frontmatter.notify;
    const window = notify?.strategy === 'rollup' ? notify.window : 'unknown';
    const timezone =
      notify?.strategy === 'rollup' ? (notify.timezone ?? 'UTC') : 'unknown';
    holds.push({
      monitorId,
      strategy: 'rollup',
      observations: rollup.observations.length,
      blockedByDefinition,
      window,
      timezone,
      reason: `rollup is holding ${String(rollup.observations.length)} observation(s) until the next window (${window}).${repair}`,
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
