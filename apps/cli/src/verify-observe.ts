import type { ObservationHistoryRecord } from '@agentmonitors/core';

/**
 * Coerce a record timestamp to epoch ms. Over the daemon socket, `Date` fields
 * are JSON-serialized to ISO strings (the `ObservationHistoryRecord.createdAt:
 * Date` type describes the in-process shape, not the deserialized wire shape),
 * so a bare `.getTime()` would throw. Accept `Date | string | number` — mirrors
 * `verify.ts`'s own `toMs` (duplicated here rather than shared, to keep this
 * module import-free of `verify.ts` and independently unit-testable).
 */
function toMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

/**
 * `verify`'s post-trigger observe-stage verdict: the decisive outcome once a
 * post-trigger tick has run, or `null` to keep polling.
 *
 * @see docs/specs/005-cli-reference.md §16
 */
export type ObserveVerdict = 'triggered' | 'no-change' | 'no-files-matched';

/**
 * Decide the observe-stage verdict from the current observation-history
 * window, given the rows already confirmed as decisive `no-change` evidence
 * on a PRIOR call (`seenNoChangeIds`, mutated in place as an accumulator across
 * polls — see `verify.ts`'s `pollUntil` loop, which calls this once per tick).
 *
 * A `triggered` row always wins immediately — that is the real, non-stale
 * post-trigger tick. `no-files-matched` is likewise always definitive (the
 * glob scope resolved to zero files).
 *
 * `no-change` is more subtle (issue #442 round 19): a daemon tick that was
 * already IN FLIGHT (mid-scan) when the trigger fired can still finish and
 * record its (necessarily stale, pre-trigger) `no-change` row AFTER
 * `observeFrom` — under enough scheduling delay its `createdAt` alone can't be
 * told apart from a genuine post-trigger observation. Requiring that single
 * row to merely PERSIST for a while is not sufficient evidence either: every
 * poll re-reads the SAME retained row, so "persistence" is just the caller's
 * own clock passing, not new information. The only real evidence that a
 * genuinely-late post-trigger tick has run and seen no change is a SECOND,
 * DISTINCT observation-history row (a different `id` — rows are monotonically
 * ID'd and newest-first, so a new id can only come from a tick that started
 * and completed after the first sighting) also reporting `no-change`. Two
 * distinct rows both saying `no-change` means two separate observation cycles
 * ran after the trigger and neither one saw the change — decisive. A single
 * stale row, however long it lingers, never reaches that bar.
 *
 * `no-change` is suppressed entirely while a `suppressed` row is present in
 * the same window — that means the change WAS observed and is settling in a
 * debounce/throttle window (002 §9.2/§9.3); the eventual `triggered` row at
 * flush still wins via the check above.
 */
export function resolveObserveVerdict(
  rows: readonly ObservationHistoryRecord[],
  observeFrom: number,
  manual: boolean,
  seenNoChangeIds: Set<string>,
): ObserveVerdict | null {
  const post = rows.filter((r) => toMs(r.createdAt) > observeFrom);
  if (post.some((r) => r.result === 'triggered')) return 'triggered';
  if (manual) return null;
  if (post.some((r) => r.result === 'no-files-matched')) {
    return 'no-files-matched';
  }
  if (
    post.some((r) => r.result === 'no-change') &&
    !post.some((r) => r.result === 'suppressed')
  ) {
    for (const row of post) {
      if (row.result === 'no-change') seenNoChangeIds.add(row.id);
    }
    return seenNoChangeIds.size >= 2 ? 'no-change' : null;
  }
  return null;
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
