import type { DeliveryLifecycle } from './types.js';

/**
 * Reminder diagnosis (issue #333, 002 §9.2–§9.3).
 *
 * The coalesced generic inbox reminder for `normal` (at `turn-interruptible`,
 * §9.2) and `low` (at `turn-idle`, §9.3) urgency is delivered **only if all
 * unread events of that urgency are still unclaimed**. Once any unread event of
 * that urgency has been claimed (its `firstNotifiedAt` is set) but not yet
 * acknowledged, the reminder is suppressed — it does not re-fire until the
 * claimed events are acknowledged or a fresh unclaimed event arrives.
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
 * - `already-claimed` — every unread event of the band is already claimed
 *   (the classic single-monitor case: the reminder fired once, claiming the
 *   event, and will not fire again until it is acknowledged).
 * - `coalesced-until-ack` — a mix of claimed and unclaimed unread events exists;
 *   because the reminder coalesces until acknowledgment, the presence of a
 *   claimed-but-unacknowledged event holds it back even though a newer unclaimed
 *   event is also pending.
 */
export type ReminderSuppressionReason =
  | 'already-claimed'
  | 'coalesced-until-ack';

/**
 * Session-scoped unread/pending counts for one urgency band, as read from the
 * runtime store (`unreadEventsForSession` / `pendingEventsForSession`). Both
 * counts already exclude net-suppressed and Interpret-suppressed rows, exactly
 * as the delivery guard does.
 */
export interface ReminderSessionCounts {
  sessionId: string;
  urgency: ReminderUrgency;
  /** Unacknowledged events of this band (claimed or not). */
  unreadCount: number;
  /** Unacknowledged AND unclaimed events of this band (`firstNotifiedAt IS NULL`). */
  pendingCount: number;
}

/** A named verdict explaining why a coalesced reminder is currently suppressed. */
export interface ReminderSuppressionFinding {
  sessionId: string;
  urgency: ReminderUrgency;
  /** The lifecycle at which this band's reminder would be delivered. */
  lifecycle: DeliveryLifecycle;
  /** Unacknowledged events of this band for the session. */
  unreadCount: number;
  /** Unacknowledged-but-claimed events of this band (`unreadCount - pendingCount`). */
  claimedCount: number;
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
  reason: ReminderSuppressionReason,
): string {
  const lifecycle = REMINDER_LIFECYCLE[urgency];
  const ackCmd = `agentmonitors events ack --session ${sessionId}`;
  const head = `${bandLabel(urgency)}-urgency reminder at ${lifecycle} is suppressed for session ${sessionId}:`;
  if (reason === 'already-claimed') {
    return (
      `${head} all ${String(unreadCount)} unread ${urgency} event(s) are already claimed ` +
      `(coalesced-until-ack). The generic inbox reminder does not re-fire until they are ` +
      `acknowledged (\`${ackCmd}\`) or a new unclaimed ${urgency} event arrives.`
    );
  }
  return (
    `${head} ${String(claimedCount)} of ${String(unreadCount)} unread ${urgency} event(s) are ` +
    `already claimed (coalesced-until-ack). The coalesced reminder re-fires only when every ` +
    `unread ${urgency} event is unclaimed — acknowledge the claimed ones (\`${ackCmd}\`).`
  );
}

/**
 * Diagnose, per session-and-band, whether the coalesced reminder is currently
 * suppressed and why.
 *
 * The delivery guard (§9.2/§9.3) fires the reminder iff
 * `pendingCount > 0 && pendingCount === unreadCount` — i.e. at least one unread
 * event exists and **every** unread event is unclaimed. Equivalently, with
 * `claimedCount = unreadCount - pendingCount`, it fires iff
 * `unreadCount > 0 && claimedCount === 0`. So the reminder is SUPPRESSED exactly
 * when `unreadCount > 0 && claimedCount > 0`; every other state either delivers
 * the reminder (nothing to explain) or has no unread work at all.
 *
 * Bands with no unread work, or whose reminder would fire, produce no finding.
 */
export function diagnoseReminderSuppression(
  counts: readonly ReminderSessionCounts[],
): ReminderSuppressionFinding[] {
  const findings: ReminderSuppressionFinding[] = [];
  for (const c of counts) {
    const claimedCount = c.unreadCount - c.pendingCount;
    // Guard for the reminder firing: unread > 0 AND every unread event unclaimed.
    // Suppressed iff there is unread work AND at least one is already claimed.
    if (c.unreadCount <= 0 || claimedCount <= 0) continue;
    const reason: ReminderSuppressionReason =
      c.pendingCount <= 0 ? 'already-claimed' : 'coalesced-until-ack';
    findings.push({
      sessionId: c.sessionId,
      urgency: c.urgency,
      lifecycle: REMINDER_LIFECYCLE[c.urgency],
      unreadCount: c.unreadCount,
      claimedCount,
      reason,
      message: buildMessage(
        c.sessionId,
        c.urgency,
        c.unreadCount,
        claimedCount,
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
