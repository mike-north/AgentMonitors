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
 * The two reminder-suppression reasons (`already-claimed` / `coalesced-until-ack`)
 * intentionally use the SAME vocabulary as `monitor explain`'s reminder-suppression
 * finding (issue #333, `libs/core/src/runtime/reminder-diagnosis.ts`) — both
 * surfaces are explaining the identical underlying guard (a coalesced
 * normal/low reminder fires only while every unread event of the band is still
 * unclaimed, 002 §9.2/§9.3) and must agree on what to call it.
 *
 * @see ../../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 * @see ../../../../docs/specs/002-runtime-delivery.md §9 (delivery lifecycles)
 */

/**
 * Why a band of unread events is not deliverable right now:
 * - `settle-window` — high-urgency only: pending (unclaimed) events exist but
 *   none has aged past the claim-time settle threshold yet (002 §9.1).
 * - `already-claimed` — normal/low only: every unread event of the band is
 *   already durably claimed, so the coalesced reminder (002 §9.2/§9.3) will not
 *   re-fire until acknowledgment. A fresh unclaimed event of the same band
 *   arriving in the meantime does NOT restore it.
 * - `coalesced-until-ack` — normal/low only: a mix of claimed and unclaimed
 *   unread events exists (a leased-but-not-yet-claimed row may also be present
 *   and is reported separately via `leasedCount`); the claimed ones hold the
 *   coalesced reminder back even though a newer unclaimed event is also
 *   pending.
 * - `reserved-in-flight` — normal/low only: NO unread event of the band is
 *   durably claimed, but at least one is currently LEASED by an in-flight
 *   channel-push reservation (issue #300). A lease is not a claim — it
 *   resolves itself (commit → claimed, or release/expiry → pending again) —
 *   so, unlike the other two reasons, this one must never recommend
 *   `events ack`: acknowledging a leased-but-unseen row before the push
 *   resolves can permanently lose it if the push then fails (round 10 review).
 */
export type HookDeliveryHoldReason =
  | 'settle-window'
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
   * `already-claimed` / `coalesced-until-ack` only: the exact ids of this
   * band's unread-but-already-claimed events — the ones actually holding the
   * coalesced reminder back. Threaded through so a consumer (e.g. `doctor`'s
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
 * (every unread event is unclaimed) or there is no unread work for the band —
 * neither case is a "hold" worth reporting.
 */
export function classifyReminderHold(
  urgency: 'normal' | 'low',
  unreadCount: number,
  pendingCount: number,
  claimedEventIds: string[] = [],
  leasedCount = 0,
): HookDeliveryHold | null {
  const claimedCount = unreadCount - pendingCount - leasedCount;
  // Fires (not held) when there is unread work and none of it is claimed or
  // leased yet.
  if (unreadCount <= 0 || (claimedCount <= 0 && leasedCount <= 0)) return null;

  const lifecycle = REMINDER_LIFECYCLE[urgency];
  const label = reminderLabel(urgency);
  const ackHint = 'agentmonitors events ack';

  if (claimedCount <= 0) {
    // Pure lease: nothing is durably claimed, so there is nothing an ack can
    // clear yet — a lease resolves itself. Never recommend ack here (round 10).
    return {
      urgency,
      reason: 'reserved-in-flight',
      unreadCount,
      pendingCount,
      leasedCount,
      message: `${label}-urgency reminder at ${lifecycle} is held: ${String(leasedCount)} of ${String(unreadCount)} unread ${urgency} event(s) are being surfaced by an in-flight channel-push reservation (reserved-in-flight). No action needed — it will be claimed shortly, or become claimable again if that push fails.`,
    };
  }

  const reason: HookDeliveryHoldReason =
    pendingCount <= 0 && leasedCount <= 0
      ? 'already-claimed'
      : 'coalesced-until-ack';
  const leasedNote =
    leasedCount > 0
      ? ` (${String(leasedCount)} more of this band are being surfaced by an in-flight channel-push reservation and need no action)`
      : '';
  const message =
    reason === 'already-claimed'
      ? `${label}-urgency reminder at ${lifecycle} is suppressed: all ${String(unreadCount)} unread ${urgency} event(s) are already claimed (coalesced-until-ack). It re-fires once they are acknowledged (\`${ackHint}\`) — a fresh unclaimed ${urgency} event arriving in the meantime does not restore it.`
      : `${label}-urgency reminder at ${lifecycle} is suppressed: ${String(claimedCount)} of ${String(unreadCount)} unread ${urgency} event(s) are already claimed (coalesced-until-ack)${leasedNote}. It re-fires only once every unread ${urgency} event is unclaimed — acknowledge the claimed ones (\`${ackHint}\`).`;

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
