/**
 * Correlate verify's observation stage with recording activity in the same live
 * daemon. History timestamps lose milliseconds in persistence; monotonic record
 * identities distinguish rows across a trigger without widening the time window.
 * This is recording order, not proof that an arbitrary source change was caused
 * by the trigger. It is not a cross-process-restart or multi-writer sequence.
 */
import type { ObservationHistoryRecord } from '@agentmonitors/core';

/** Decisive observation result, or null from the resolver while evidence is incomplete. */
export type ObserveVerdict = 'triggered' | 'no-change' | 'no-files-matched';

/**
 * Recording boundaries and accumulated evidence for one verification attempt.
 * Keep this object across bounded history polls: rereading a row is not a new
 * observation, and losing an older row must not erase settling or gap evidence.
 * @internal
 */
export interface ObserveWindow {
  /** Latest known record before starting the trigger or prompting a manual change. */
  readonly positiveAfterId: string;
  /** Latest known record at trigger completion; earlier idle rows cannot prove failure. */
  readonly negativeAfterId: string;
  /** Last visible frontier used to verify that consecutive history windows overlap. */
  latestSeenId: string;
  /** Distinct eligible no-change records; two cycles are needed to exclude one stale in-flight result. */
  readonly noChangeIds: Set<string>;
  /** A missing frontier means a success/settling row might have fallen out of the bounded window. */
  hasGap: boolean;
  /** Settling evidence remains meaningful after its history row leaves the window. */
  sawSuppressed: boolean;
}

/**
 * Start evidence collection from two snapshots of the same daemon's history.
 * A command may already have produced a positive observation before it returns;
 * negative observations during that command cannot prove its final effect.
 * @internal
 */
export function createObserveWindow(
  positiveAfterId: string,
  negativeAfterId: string,
): ObserveWindow {
  return {
    positiveAfterId,
    negativeAfterId,
    latestSeenId: positiveAfterId,
    noChangeIds: new Set(),
    hasGap: negativeAfterId < positiveAfterId,
    sawSuppressed: false,
  };
}

/**
 * Resolve an outcome using newly recorded identities, independent of timestamp
 * precision and wire Date revival. Positive evidence wins immediately. Negative
 * evidence requires a continuous history window after trigger completion and
 * is disabled for manual runs. Two distinct no-change rows guard against a scan
 * already in flight at the trigger; a retained suppression keeps waiting for
 * its eventual flush. A history gap can only resolve positively or time out.
 */
export function resolveObserveVerdict(
  rows: readonly ObservationHistoryRecord[],
  window: ObserveWindow,
  manual: boolean,
): ObserveVerdict | null {
  const post = rows.filter(({ id }) => id > window.positiveAfterId);
  if (post.some(({ result }) => result === 'triggered')) {
    return 'triggered';
  }

  const latestId = rows.reduce(
    (latest, { id }) => (id > latest ? id : latest),
    window.latestSeenId,
  );
  if (
    latestId > window.latestSeenId &&
    !rows.some(({ id }) => id === window.latestSeenId)
  ) {
    window.hasGap = true;
  }
  window.latestSeenId = latestId;
  window.sawSuppressed ||= post.some(({ result }) => result === 'suppressed');
  if (manual || window.hasGap) {
    return null;
  }

  const negative = post.filter(({ id }) => id > window.negativeAfterId);
  if (negative.some(({ result }) => result === 'no-files-matched')) {
    return 'no-files-matched';
  }
  if (window.sawSuppressed) {
    return null;
  }
  for (const row of negative) {
    if (row.result === 'no-change') {
      window.noChangeIds.add(row.id);
    }
  }
  return window.noChangeIds.size >= 2 ? 'no-change' : null;
}

/**
 * Resolve the deadline (epoch ms) `verify`'s observe stage polls until.
 *
 * `resolveObserveVerdict`'s two-distinct-row `no-change` discriminator needs
 * roughly two full monitor-poll intervals of wall time to legitimately
 * resolve (`budget.noChangeConfirmMs`) — longer than the single-interval
 * `detectDeadline` the rest of the detect phase (materialize, deliver) uses.
 * The observe deadline is extended to fit it, but ONLY when using the
 * DEFAULT derived budget (`timeoutOverridden === false`): an explicit
 * `--timeout-ms` is the operator's real cap and must be honored as given — a
 * timeout shorter than one interval still fails fast with `budget-exceeded`
 * rather than being silently stretched past what was asked for.
 */
export function resolveObserveDeadline(
  observeFrom: number,
  detectDeadline: number,
  noChangeConfirmMs: number,
  timeoutOverridden: boolean,
): number {
  return timeoutOverridden
    ? detectDeadline
    : Math.max(detectDeadline, observeFrom + noChangeConfirmMs);
}
