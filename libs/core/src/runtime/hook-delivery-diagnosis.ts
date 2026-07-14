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
 *   already claimed, so the coalesced reminder (002 §9.2/§9.3) will not re-fire
 *   until acknowledgment or a fresh unclaimed event.
 * - `coalesced-until-ack` — normal/low only: a mix of claimed and unclaimed
 *   unread events exists; the claimed ones hold the coalesced reminder back
 *   even though a newer unclaimed event is also pending.
 */
export type HookDeliveryHoldReason =
  | 'settle-window'
  | 'already-claimed'
  | 'coalesced-until-ack';

/** A named, human-readable verdict for one urgency band's held state. */
export interface HookDeliveryHold {
  urgency: Urgency;
  reason: HookDeliveryHoldReason;
  /** Unacknowledged events of this band for the session (claimed or not). */
  unreadCount: number;
  /** Unacknowledged AND unclaimed events of this band. */
  pendingCount: number;
  /**
   * `settle-window` only: milliseconds remaining until the oldest unsettled
   * pending event reaches the claim-time settle threshold.
   */
  settleRemainingMs?: number;
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
): HookDeliveryHold | null {
  const claimedCount = unreadCount - pendingCount;
  // Fires (not held) when there is unread work and none of it is claimed yet.
  if (unreadCount <= 0 || claimedCount <= 0) return null;

  const lifecycle = REMINDER_LIFECYCLE[urgency];
  const label = reminderLabel(urgency);
  const reason: HookDeliveryHoldReason =
    pendingCount <= 0 ? 'already-claimed' : 'coalesced-until-ack';
  const ackHint = 'agentmonitors events ack';
  const message =
    reason === 'already-claimed'
      ? `${label}-urgency reminder at ${lifecycle} is suppressed: all ${String(unreadCount)} unread ${urgency} event(s) are already claimed (coalesced-until-ack). It re-fires once they are acknowledged (\`${ackHint}\`) or a fresh unclaimed ${urgency} event arrives.`
      : `${label}-urgency reminder at ${lifecycle} is suppressed: ${String(claimedCount)} of ${String(unreadCount)} unread ${urgency} event(s) are already claimed (coalesced-until-ack). It re-fires only once every unread ${urgency} event is unclaimed — acknowledge the claimed ones (\`${ackHint}\`).`;

  return { urgency, reason, unreadCount, pendingCount, message };
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
    message:
      `High-urgency delivery at turn-interruptible is held: ${String(pendingCount)} ` +
      `pending event(s) are within the ${String(settleSeconds)}s settle window ` +
      `(~${String(remainingSeconds)}s remaining before the oldest becomes deliverable).`,
  };
}
