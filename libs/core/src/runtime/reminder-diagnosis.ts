import type { DeliveryLifecycle } from './types.js';

/**
 * Explains why a normal/low reminder is absent without changing delivery state.
 * A fresh pending batch surfaces independently of older claimed rows. The only
 * band-wide hold is a temporary in-flight reservation, which prevents duplicate
 * generic reminders across transports until commit, release or lease expiry.
 * With no pending work, claimed rows remain unread but are not reminded again.
 * Counts are per session and urgency band, including all matching monitors.
 */

/** Urgency bands that surface a coalesced generic reminder (not `high`). */
export type ReminderUrgency = 'normal' | 'low';

/**
 * Why no fresh reminder can surface. `coalesced-until-ack` is retained only for
 * compatibility with historical diagnostics; new decisions never emit it.
 * `already-claimed` means no fresh pending work remains. `reserved-in-flight`
 * is a temporary lease and must never suggest acknowledgment as a remedy.
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
  return (
    `${head} all ${String(unreadCount)} unread ${urgency} event(s) are already claimed. ` +
    `They remain unread until explicitly acknowledged (\`${ackCmd}\`). ` +
    `A fresh unclaimed ${urgency} event will trigger a new reminder; previously claimed events are not repeated.`
  );
}

/**
 * Diagnose the same pending-work and reservation gates used for actual delivery.
 * A prior claim is not a reason to hold a fresh pending batch; a live lease is.
 * Empty bands and ready batches need no suppression explanation.
 */
export function diagnoseReminderSuppression(
  counts: readonly ReminderSessionCounts[],
): ReminderSuppressionFinding[] {
  const findings: ReminderSuppressionFinding[] = [];
  for (const c of counts) {
    const leasedCount = c.leasedCount ?? 0;
    const claimedCount = c.unreadCount - c.pendingCount - leasedCount;
    if (c.unreadCount <= 0 || (c.pendingCount > 0 && leasedCount <= 0))
      continue;
    const reason: ReminderSuppressionReason =
      leasedCount > 0 ? 'reserved-in-flight' : 'already-claimed';
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
