import type { DeliveryLifecycle } from './types.js';

/**
 * Reminder diagnosis (issue #333, 002 §9.2–§9.3).
 *
 * The coalesced generic inbox reminder for `normal` (at `turn-interruptible`,
 * §9.2) and `low` (at `turn-idle`, §9.3) urgency is delivered **only if all
 * unread events of that urgency are still unclaimed**. Once any unread event of
 * that urgency has been claimed (its `firstNotifiedAt` is set) but not yet
 * acknowledged, the reminder is suppressed — it does not re-fire until the
 * claimed events are acknowledged. A fresh unclaimed event of the same band
 * arriving in the meantime does NOT restore it: the band-scoped equality guard
 * (unread count === pending count) stays unequal as long as any claimed row
 * remains in the unread total, regardless of how many new unclaimed rows join it.
 *
 * This is the exact trap a blind study subject hit: a first
 * `hook claim --lifecycle turn-interruptible` surfaced the reminder AND claimed
 * the underlying normal event; a second identical claim then returned `null`
 * (nothing surfaced) with no explanation. Per the silent-failure-honesty
 * invariant (capability C12, and §1.1.8's "why nothing fired" principle), that
 * silence must be inspectable rather than presented as a dead end. This module
 * turns the guard's decision into a named, human-readable verdict surfaced by
 * `monitor explain` (§10.7 projection-and-delivery stage).
 *
 * The reminder guard is a **session-level, cross-monitor** decision (it counts
 * every unread event of the urgency band for the session, regardless of which
 * monitor produced it — see `AgentMonitorRuntime.claimDelivery`), so the counts
 * fed to this function are session-scoped, not monitor-scoped.
 */

/** Urgency bands that surface a coalesced generic reminder (not `high`). */
export type ReminderUrgency = 'normal' | 'low';

/**
 * Why a coalesced reminder is currently suppressed:
 * - `already-claimed` — every unread event of the band is already durably
 *   claimed (the classic single-monitor case: the reminder fired once,
 *   claiming the event, and will not fire again until it is acknowledged).
 * - `coalesced-until-ack` — a mix of claimed and unclaimed unread events exists
 *   (a leased-but-not-yet-claimed row may also be present and is reported
 *   separately via `leasedCount`); because the reminder coalesces until
 *   acknowledgment, the presence of a claimed-but-unacknowledged event holds it
 *   back even though a newer unclaimed event is also pending.
 * - `reserved-in-flight` — NO unread event of the band is durably claimed, but
 *   at least one is currently LEASED by an in-flight channel-push reservation
 *   (issue #300). A lease is not a claim and resolves itself, so this reason
 *   must never recommend `events ack` — acknowledging a leased-but-unseen row
 *   before the push resolves can permanently lose it if the push then fails
 *   (round 10 review).
 */
export type ReminderSuppressionReason =
  | 'already-claimed'
  | 'coalesced-until-ack'
  | 'reserved-in-flight';

/**
 * Session-scoped unread/pending counts for one urgency band, as read from the
 * runtime store (`unreadEventsForSession` / `pendingEventsForSession`). Both
 * counts already exclude net-suppressed and Interpret-suppressed rows, exactly
 * as the delivery guard does.
 */
export interface ReminderSessionCounts {
  sessionId: string;
  urgency: ReminderUrgency;
  /** Unacknowledged events of this band (claimed, leased, or neither). */
  unreadCount: number;
  /** Unacknowledged, unclaimed, AND unleased events of this band (`firstNotifiedAt IS NULL`, not reserved). */
  pendingCount: number;
  /**
   * Unacknowledged AND unclaimed events of this band currently LEASED by an
   * in-flight channel-push reservation (issue #300, round 10) — already
   * excluded from `pendingCount`. Defaults to `0` when omitted.
   */
  leasedCount?: number;
}

/** A named verdict explaining why a coalesced reminder is currently suppressed. */
export interface ReminderSuppressionFinding {
  sessionId: string;
  urgency: ReminderUrgency;
  /** The lifecycle at which this band's reminder would be delivered. */
  lifecycle: DeliveryLifecycle;
  /** Unacknowledged events of this band for the session. */
  unreadCount: number;
  /** Unacknowledged, durably-claimed events of this band (`unreadCount - pendingCount - leasedCount`). */
  claimedCount: number;
  /** Unacknowledged AND unclaimed events of this band currently leased by an in-flight channel-push reservation. */
  leasedCount: number;
  reason: ReminderSuppressionReason;
  /** Human-readable explanation naming the reason and the remedy. */
  message: string;
}

/** The lifecycle each reminder band is delivered at (§9.2/§9.3). */
const REMINDER_LIFECYCLE: Record<ReminderUrgency, DeliveryLifecycle> = {
  normal: 'turn-interruptible',
  low: 'turn-idle',
};

function bandLabel(urgency: ReminderUrgency): string {
  return urgency === 'normal' ? 'Normal' : 'Low';
}

function buildMessage(
  sessionId: string,
  urgency: ReminderUrgency,
  unreadCount: number,
  claimedCount: number,
  leasedCount: number,
  reason: ReminderSuppressionReason,
): string {
  const lifecycle = REMINDER_LIFECYCLE[urgency];
  const ackCmd = `agentmonitors events ack --session ${sessionId}`;
  const head = `${bandLabel(urgency)}-urgency reminder at ${lifecycle} is suppressed for session ${sessionId}:`;
  if (reason === 'reserved-in-flight') {
    // Pure lease: nothing is durably claimed yet, so there is nothing an ack
    // can clear — a lease resolves itself. Never recommend ack here.
    return (
      `${head} ${String(leasedCount)} of ${String(unreadCount)} unread ${urgency} event(s) are ` +
      `being surfaced by an in-flight channel-push reservation (reserved-in-flight). No action ` +
      `needed — it will be claimed shortly, or become claimable again if that push fails.`
    );
  }
  const leasedNote =
    leasedCount > 0
      ? ` (${String(leasedCount)} more of this band are being surfaced by an in-flight channel-push reservation and need no action)`
      : '';
  if (reason === 'already-claimed') {
    return (
      `${head} all ${String(unreadCount)} unread ${urgency} event(s) are already claimed ` +
      `(coalesced-until-ack). The generic inbox reminder does not re-fire until they are ` +
      `acknowledged (\`${ackCmd}\`) — a new unclaimed ${urgency} event arriving in the meantime ` +
      `does not restore it.`
    );
  }
  return (
    `${head} ${String(claimedCount)} of ${String(unreadCount)} unread ${urgency} event(s) are ` +
    `already claimed (coalesced-until-ack)${leasedNote}. The coalesced reminder re-fires only when ` +
    `every unread ${urgency} event is unclaimed — acknowledge the claimed ones (\`${ackCmd}\`).`
  );
}

/**
 * Diagnose, per session-and-band, whether the coalesced reminder is currently
 * suppressed and why.
 *
 * The delivery guard (§9.2/§9.3) fires the reminder iff `pendingCount > 0 &&
 * pendingCount === unreadCount`, where `pendingCount` already excludes rows
 * LEASED by an in-flight channel-push reservation (issue #300) — i.e. at least
 * one unread event exists and **every** unread event is unclaimed AND
 * unleased. Equivalently, with `claimedCount = unreadCount - pendingCount -
 * leasedCount`, it fires iff `unreadCount > 0 && claimedCount === 0 &&
 * leasedCount === 0`. So the reminder is SUPPRESSED exactly when `unreadCount
 * > 0 && (claimedCount > 0 || leasedCount > 0)`; every other state either
 * delivers the reminder (nothing to explain) or has no unread work at all. A
 * pure lease (`claimedCount === 0 && leasedCount > 0`) gets the distinct
 * `reserved-in-flight` reason, which never recommends ack (round 10 review).
 *
 * Bands with no unread work, or whose reminder would fire, produce no finding.
 */
export function diagnoseReminderSuppression(
  counts: readonly ReminderSessionCounts[],
): ReminderSuppressionFinding[] {
  const findings: ReminderSuppressionFinding[] = [];
  for (const c of counts) {
    const leasedCount = c.leasedCount ?? 0;
    const claimedCount = c.unreadCount - c.pendingCount - leasedCount;
    // Guard for the reminder firing: unread > 0 AND every unread event
    // unclaimed AND unleased. Suppressed iff there is unread work AND at
    // least one is already claimed or leased.
    if (c.unreadCount <= 0 || (claimedCount <= 0 && leasedCount <= 0)) continue;
    const reason: ReminderSuppressionReason =
      claimedCount <= 0
        ? 'reserved-in-flight'
        : c.pendingCount <= 0 && leasedCount <= 0
          ? 'already-claimed'
          : 'coalesced-until-ack';
    findings.push({
      sessionId: c.sessionId,
      urgency: c.urgency,
      lifecycle: REMINDER_LIFECYCLE[c.urgency],
      unreadCount: c.unreadCount,
      claimedCount,
      leasedCount,
      reason,
      message: buildMessage(
        c.sessionId,
        c.urgency,
        c.unreadCount,
        claimedCount,
        leasedCount,
        reason,
      ),
    });
  }
  // Deterministic order: by session, then normal before low.
  findings.sort((a, b) =>
    a.sessionId === b.sessionId
      ? a.urgency === b.urgency
        ? 0
        : a.urgency === 'normal'
          ? -1
          : 1
      : a.sessionId < b.sessionId
        ? -1
        : 1,
  );
  return findings;
}
