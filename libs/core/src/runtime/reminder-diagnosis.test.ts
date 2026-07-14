/**
 * Tests for the coalesced-reminder suppression diagnosis (issue #333).
 *
 * The expected verdicts are derived BY HAND from the delivery-guard spec, not
 * captured from program output:
 *
 *   §9.2 — at `turn-interruptible`, normal-urgency events surface a generic
 *          inbox reminder ONLY IF all unread normal events are still unclaimed.
 *   §9.3 — at `turn-idle`, low-urgency events surface a generic reminder ONLY IF
 *          all unread low events are still unclaimed.
 *
 * So the reminder is suppressed exactly when there is unread work AND at least
 * one unread event of that band is already claimed (`firstNotifiedAt` set,
 * `acknowledgedAt` null) — the trap a blind study subject hit when a second
 * `hook claim --lifecycle turn-interruptible` returned `null` after the first
 * had claimed the only normal event.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §9.2 (normal reminder)
 * @see ../../../../docs/specs/002-runtime-delivery.md §9.3 (low reminder)
 * @see ../../../../docs/specs/002-runtime-delivery.md §10.7 (monitor explain)
 */
import { describe, expect, it } from 'vitest';
import {
  diagnoseReminderSuppression,
  type ReminderSessionCounts,
} from './reminder-diagnosis.js';

describe('diagnoseReminderSuppression', () => {
  it('reports no finding when every unread normal event is still unclaimed (reminder would fire, §9.2)', () => {
    // unread === pending → guard `pending === unread && pending > 0` holds → fires.
    const counts: ReminderSessionCounts[] = [
      { sessionId: 's1', urgency: 'normal', unreadCount: 2, pendingCount: 2 },
    ];
    expect(diagnoseReminderSuppression(counts)).toEqual([]);
  });

  it('reports `already-claimed` when the only unread normal event is claimed (the S3 trap, §9.2)', () => {
    // The S3 sequence: reminder fired once (claiming the event), so a second
    // claim finds unread=1 (still unacked), pending=0 (claimed) → suppressed.
    const counts: ReminderSessionCounts[] = [
      { sessionId: 's1', urgency: 'normal', unreadCount: 1, pendingCount: 0 },
    ];
    const findings = diagnoseReminderSuppression(counts);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding).toMatchObject({
      sessionId: 's1',
      urgency: 'normal',
      lifecycle: 'turn-interruptible', // §9.2 delivers at turn-interruptible
      unreadCount: 1,
      claimedCount: 1,
      reason: 'already-claimed',
    });
    // The message must name BOTH the mechanism and the policy, and the remedy.
    expect(finding?.message).toContain('already claimed');
    expect(finding?.message).toContain('coalesced-until-ack');
    expect(finding?.message).toContain('agentmonitors events ack --session s1');
  });

  it('reports `coalesced-until-ack` when unread normal events mix claimed and unclaimed (§9.2)', () => {
    // unread=3, pending=1 → 2 claimed, 1 unclaimed. `pending !== unread` → the
    // coalesced reminder is held back by the claimed rows even though a fresh
    // unclaimed event exists.
    const counts: ReminderSessionCounts[] = [
      { sessionId: 's1', urgency: 'normal', unreadCount: 3, pendingCount: 1 },
    ];
    const findings = diagnoseReminderSuppression(counts);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      urgency: 'normal',
      unreadCount: 3,
      claimedCount: 2,
      reason: 'coalesced-until-ack',
    });
    expect(findings[0]?.message).toContain('2 of 3');
  });

  it('diagnoses the low-urgency reminder at turn-idle (§9.3)', () => {
    const counts: ReminderSessionCounts[] = [
      { sessionId: 's1', urgency: 'low', unreadCount: 1, pendingCount: 0 },
    ];
    const findings = diagnoseReminderSuppression(counts);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      urgency: 'low',
      lifecycle: 'turn-idle', // §9.3 delivers at turn-idle
      reason: 'already-claimed',
    });
    expect(findings[0]?.message).toContain('Low-urgency reminder at turn-idle');
  });

  it('reports no finding when there is no unread work (nothing to explain)', () => {
    const counts: ReminderSessionCounts[] = [
      { sessionId: 's1', urgency: 'normal', unreadCount: 0, pendingCount: 0 },
    ];
    expect(diagnoseReminderSuppression(counts)).toEqual([]);
  });

  it('emits one finding per (session, band) and orders deterministically', () => {
    const counts: ReminderSessionCounts[] = [
      { sessionId: 's2', urgency: 'low', unreadCount: 1, pendingCount: 0 },
      { sessionId: 's1', urgency: 'low', unreadCount: 2, pendingCount: 1 },
      { sessionId: 's1', urgency: 'normal', unreadCount: 1, pendingCount: 0 },
    ];
    const findings = diagnoseReminderSuppression(counts);
    // s1 before s2; within s1, normal before low.
    expect(findings.map((f) => `${f.sessionId}:${f.urgency}`)).toEqual([
      's1:normal',
      's1:low',
      's2:low',
    ]);
  });

  it('does not diagnose bands whose reminder would fire alongside a suppressed sibling band', () => {
    // normal is all-claimed (suppressed); low is fully unclaimed (would fire).
    const counts: ReminderSessionCounts[] = [
      { sessionId: 's1', urgency: 'normal', unreadCount: 1, pendingCount: 0 },
      { sessionId: 's1', urgency: 'low', unreadCount: 1, pendingCount: 1 },
    ];
    const findings = diagnoseReminderSuppression(counts);
    expect(findings.map((f) => f.urgency)).toEqual(['normal']);
  });
});
