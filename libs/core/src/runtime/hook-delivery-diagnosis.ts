import type { Urgency } from '../schema/types.js';
import type { DeliveryLifecycle, SessionUnreadCounts } from './types.js';

/**
 * Diagnosis for "why did `hook deliver` surface nothing this turn?" (issue
 * #334). `hook deliver`'s stdout contract is deliberately silent-on-idle
 * (006 §5.1) — a real host hook must never inject noise — but that silence is
 * indistinguishable, from the outside, between "correctly idle" and
 * "misconfigured" (unknown session, disabled workspace, unreachable daemon) or
 * "genuinely held" (settle window, coalesced reminder). This module computes
 * the READ-ONLY, pure verdict for the latter case — events that exist and are
 * unread but are not yet deliverable at the requested lifecycle — so the
 * `--debug` flag can name it on stderr without touching stdout.
 *
 * Reminder vocabulary agrees with monitor explain: a prior claim suppresses
 * repetition of that work only; fresh work remains eligible. An in-flight
 * reservation temporarily serializes generic reminders for the urgency band.
 * Historical `coalesced-until-ack` values remain accepted for older daemons.
 *
 * @see ../../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 * @see ../../../../docs/specs/002-runtime-delivery.md §9 (delivery lifecycles)
 */

/**
 * Why a band of unread events is not deliverable right now:
 * - `settle-window` — high-urgency: pending (unclaimed) events exist but
 *   none has aged past the claim-time settle threshold yet (002 §9.1). Also
 *   emitted for a normal-urgency reminder (issue #441 cross-monitor
 *   coalescing; {@link classifyCoalescingWithheldHold}) that is due but held
 *   back by concurrent, still-unsettled high-urgency work it will be
 *   coalesced into once that work settles.
 * - `no-new-work` — current policy: no fresh unclaimed work remains; future batches can surface.
 * - `already-claimed` — legacy policy: old claims block future batches until acknowledgment.
 * - `coalesced-until-ack` — legacy value retained for older daemon responses;
 *   the current policy never emits it because old claims cannot block new work.
 * - `reserved-in-flight` — a live same-band reservation temporarily holds a
 *   reminder. Commit, release or expiry resolves it; acknowledgment cannot.
 */
export type HookDeliveryHoldReason =
  | 'settle-window'
  | 'no-new-work'
  | 'already-claimed'
  | 'coalesced-until-ack'
  | 'reserved-in-flight';

/** A named, human-readable verdict for one urgency band's held state. */
export interface HookDeliveryHold {
  urgency: Urgency;
  reason: HookDeliveryHoldReason;
  /** Unacknowledged events of this band for the session (claimed, leased, or neither). */
  unreadCount: number;
  /** Unacknowledged, unclaimed, AND unleased events of this band. */
  pendingCount: number;
  /**
   * Unacknowledged AND unclaimed events of this band currently LEASED by an
   * in-flight channel-push reservation (issue #300, round 10) — a subset
   * already excluded from `pendingCount`. Absent/`0` when nothing is leased.
   */
  leasedCount?: number;
  /**
   * `settle-window` only: milliseconds remaining until the oldest unsettled
   * pending event reaches the claim-time settle threshold.
   */
  settleRemainingMs?: number;
  /**
   * `no-new-work` / legacy `already-claimed` / `coalesced-until-ack`: the exact ids of this
   * band's unread-but-already-claimed events. These describe old unread work,
   * not a blocker for a fresh batch under the current policy. Threaded through so a consumer (e.g. `doctor`'s
   * remediation) can acknowledge PRECISELY these rows rather than every
   * unread event on the session, which would also clear unrelated,
   * never-surfaced work (issue #425 review, round 6). Empty for
   * `settle-window`, where nothing is claimed yet.
   *
   * Optional — not just "possibly empty" — because a `HookDeliveryDiagnosis`
   * can arrive over the daemon IPC boundary from a build that predates this
   * field (issue #425 review, round 7): an older daemon serializes a
   * `HookDeliveryHold` with no `claimedEventIds` key at all, and this type
   * only describes what THIS build produces, not what a remote peer actually
   * sent. Making it required would also have been a breaking change to this
   * already-published `@agentmonitors/core` interface with no accompanying
   * major/minor changeset. A consumer must treat `undefined` the same as any
   * other untrustworthy shape — never assume it means "nothing claimed" (that
   * is what an empty array means).
   */
  claimedEventIds?: string[];
  /** Human-readable explanation naming the mechanism and the remedy. */
  message: string;
}

/** The full diagnosis for one session at one delivery lifecycle. */
export interface HookDeliveryDiagnosis {
  sessionId: string;
  lifecycle: DeliveryLifecycle;
  unreadCounts: SessionUnreadCounts;
  holds: HookDeliveryHold[];
}

const REMINDER_LIFECYCLE: Record<'normal' | 'low', DeliveryLifecycle> = {
  normal: 'turn-interruptible',
  low: 'turn-idle',
};

function reminderLabel(urgency: 'normal' | 'low'): string {
  return urgency === 'normal' ? 'Normal' : 'Low';
}

/**
 * Classify why a coalesced normal/low reminder (002 §9.2/§9.3) is currently
 * withheld for one band. Returns `null` when the reminder would actually fire
 * (fresh work exists and no same-band reservation is active) or there is no unread work for the band —
 * neither case is a "hold" worth reporting.
 */
export function classifyReminderHold(
  urgency: 'normal' | 'low',
  unreadCount: number,
  pendingCount: number,
  claimedEventIds: string[] = [],
  leasedCount = 0,
): HookDeliveryHold | null {
  if (unreadCount <= 0 || (pendingCount > 0 && leasedCount <= 0)) return null;

  const lifecycle = REMINDER_LIFECYCLE[urgency];
  const label = reminderLabel(urgency);
  const ackHint = 'agentmonitors events ack';

  if (leasedCount > 0) {
    // The live lease is the blocker even if older claimed rows coexist.
    // Acknowledging those rows cannot resolve a transport operation.
    return {
      urgency,
      reason: 'reserved-in-flight',
      unreadCount,
      pendingCount,
      leasedCount,
      message: `${label}-urgency reminder at ${lifecycle} is held: ${String(leasedCount)} of ${String(unreadCount)} unread ${urgency} event(s) are being surfaced by an in-flight channel-push reservation (reserved-in-flight). No action needed — it will be claimed shortly, or become claimable again if that push fails.`,
    };
  }

  const reason: HookDeliveryHoldReason = 'no-new-work';
  const message = `${label}-urgency reminder at ${lifecycle} is suppressed: all ${String(unreadCount)} unread ${urgency} event(s) are already claimed. They remain unread until explicitly acknowledged (\`${ackHint}\`). A fresh unclaimed ${urgency} event will trigger a new reminder; previously claimed events are not repeated.`;

  return {
    urgency,
    reason,
    unreadCount,
    pendingCount,
    claimedEventIds,
    leasedCount,
    message,
  };
}

/**
 * Classify the high-urgency band at `turn-interruptible`: held by the
 * claim-time settle window (002 §9.1, 006 §5.5) when pending (unclaimed)
 * high-urgency work exists but NONE of it has aged past `settleMs` yet —
 * `claimDelivery` surfaces only settled events, so an all-unsettled pending set
 * delivers nothing this turn. Returns `null` when at least one pending event is
 * already settled (claimDelivery would deliver it — nothing held) or there is
 * no pending high-urgency work at all.
 */
export function classifySettleWindowHold(
  pendingHighCreatedAt: readonly Date[],
  unreadCount: number,
  now: Date,
  settleMs: number,
): HookDeliveryHold | null {
  const pendingCount = pendingHighCreatedAt.length;
  if (pendingCount === 0) return null;

  const ages = pendingHighCreatedAt.map(
    (createdAt) => now.getTime() - createdAt.getTime(),
  );
  const alreadySettled = ages.some((age) => age >= settleMs);
  if (alreadySettled) return null; // some pending work is already deliverable

  const oldestAge = Math.max(...ages);
  const settleRemainingMs = Math.max(0, settleMs - oldestAge);
  const settleSeconds = Math.round(settleMs / 1000);
  const remainingSeconds = Math.ceil(settleRemainingMs / 1000);

  return {
    urgency: 'high',
    reason: 'settle-window',
    unreadCount,
    pendingCount,
    settleRemainingMs,
    // Nothing is claimed at `settle-window`: it holds because pending
    // (unclaimed) work simply has not aged into its settle threshold yet.
    claimedEventIds: [],
    message:
      `High-urgency delivery at turn-interruptible is held: ${String(pendingCount)} ` +
      `pending event(s) are within the ${String(settleSeconds)}s settle window ` +
      `(~${String(remainingSeconds)}s remaining before the oldest becomes deliverable).`,
  };
}

/**
 * Classify whether a due normal-urgency reminder is currently withheld
 * because concurrent high-urgency work is still inside its settle window
 * (issue #441 cross-monitor coalescing; PR #456 review findings 1 & 3).
 * `decideDelivery`'s `turn-interruptible` branch no longer fires a due normal
 * reminder standalone while ANY high-urgency work is genuinely pending and
 * unsettled — it withholds the reminder so it can be folded into the SAME
 * call once that high-urgency work settles, instead of firing separately now
 * and preempting a later, separate high-urgency interrupt (the exact
 * two-interrupt failure #441 fixes).
 *
 * This hold applies only to an otherwise-ready fresh normal batch. Older
 * claims do not affect readiness. A live normal reservation takes precedence
 * and is explained by classifyReminderHold instead. No pending high work, or
 * any settled high work, means no hold: delivery is standalone or coalesced.
 */
export function classifyCoalescingWithheldHold(
  unreadCount: number,
  pendingCount: number,
  pendingHighCount: number,
  settledHighCount: number,
  leasedCount = 0,
): HookDeliveryHold | null {
  const reminderDue = pendingCount > 0 && leasedCount === 0;
  if (!reminderDue) return null;
  if (pendingHighCount === 0 || settledHighCount > 0) return null;

  return {
    urgency: 'normal',
    reason: 'settle-window',
    unreadCount,
    pendingCount,
    message:
      `Normal-urgency reminder at turn-interruptible is withheld: concurrent ` +
      `high-urgency work is still inside its settle window (issue #441 ` +
      `cross-monitor coalescing). It will be coalesced into that delivery ` +
      `once the high-urgency work settles, rather than firing separately now.`,
  };
}
