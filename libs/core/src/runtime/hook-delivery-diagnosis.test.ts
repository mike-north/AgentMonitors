/**
 * Tests for the pure hook-delivery hold-reason classifiers (issue #334).
 *
 * The expected verdicts are derived BY HAND from the delivery-guard spec, not
 * captured from program output:
 *
 *   002 §9.1 — at `turn-interruptible`, a high-urgency event is deliverable
 *              only once it has aged past the 15s claim-time settle window.
 *   002 §9.2 — the normal-urgency reminder fires at `turn-interruptible` ONLY
 *              IF every unread normal event is still unclaimed.
 *   002 §9.3 — the low-urgency reminder fires at `turn-idle` ONLY IF every
 *              unread low event is still unclaimed.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §9.1 (high-urgency settle window)
 * @see ../../../../docs/specs/002-runtime-delivery.md §9.2 (normal reminder)
 * @see ../../../../docs/specs/002-runtime-delivery.md §9.3 (low reminder)
 * @see ../../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */
import { describe, expect, it } from 'vitest';
import {
  classifyCoalescingWithheldHold,
  classifyReminderHold,
  classifySettleWindowHold,
} from './hook-delivery-diagnosis.js';

const SETTLE_MS = 15_000;
const NOW = new Date('2026-07-14T12:00:00.000Z');

describe('classifyReminderHold', () => {
  it('reports no hold when every unread normal event is still unclaimed (the reminder would fire, §9.2)', () => {
    // unread === pending → the §9.2 guard holds → fires → nothing to explain.
    expect(classifyReminderHold('normal', 2, 2)).toBeNull();
  });

  it('reports no hold when there is no unread work for the band', () => {
    expect(classifyReminderHold('normal', 0, 0)).toBeNull();
    expect(classifyReminderHold('low', 0, 0)).toBeNull();
  });

  it('reports `already-claimed` when the only unread normal event is claimed (§9.2)', () => {
    const hold = classifyReminderHold('normal', 1, 0);
    expect(hold).toMatchObject({
      urgency: 'normal',
      reason: 'already-claimed',
      unreadCount: 1,
      pendingCount: 0,
    });
    expect(hold?.message).toContain('turn-interruptible');
    expect(hold?.message).toContain('already claimed');
    expect(hold?.message).toContain('coalesced-until-ack');
    expect(hold?.message).toContain('agentmonitors events ack');
    // Regression (PR #445 review round 8): the guard is ack-only — the
    // message must not promise a fresh/new unclaimed event restores it.
    expect(hold?.message).not.toMatch(/acknowledged.*or a (fresh|new)/);
    expect(hold?.message).toContain('does not restore it');
  });

  it('defaults `claimedEventIds` to an empty array when the caller omits it', () => {
    // The caller (`diagnoseHookDelivery`) always supplies real ids; this
    // default only guards a direct caller of the pure classifier.
    expect(classifyReminderHold('normal', 1, 0)?.claimedEventIds).toEqual([]);
  });

  it('threads explicit `claimedEventIds` through unchanged (issue #425 review, round 6)', () => {
    const hold = classifyReminderHold('normal', 1, 0, ['evt-1']);
    expect(hold?.claimedEventIds).toEqual(['evt-1']);
  });

  it('reports `coalesced-until-ack` when unread normal events mix claimed and unclaimed (§9.2)', () => {
    // unread=3, pending=1 → 2 claimed, 1 unclaimed — the claimed rows hold the
    // coalesced reminder back even though a fresh unclaimed event exists.
    const hold = classifyReminderHold('normal', 3, 1);
    expect(hold).toMatchObject({
      urgency: 'normal',
      reason: 'coalesced-until-ack',
      unreadCount: 3,
      pendingCount: 1,
    });
    expect(hold?.message).toContain('2 of 3');
  });

  it('diagnoses the low band at turn-idle (§9.3)', () => {
    const hold = classifyReminderHold('low', 1, 0);
    expect(hold).toMatchObject({
      urgency: 'low',
      reason: 'already-claimed',
    });
    expect(hold?.message).toContain('turn-idle');
    expect(hold?.message).toContain('Low-urgency reminder');
  });

  // Regression (PR #445 review round 10, issue #300): a row LEASED by an
  // in-flight channel-push reservation is not durably claimed — it resolves
  // itself (commit → claimed, or release/expiry → pending again). Conflating
  // it with `already-claimed` was proven unsafe: the round-8 shared vocabulary
  // recommended `events ack`, but acknowledging a leased-but-unseen row before
  // the push resolves can permanently lose it if the push then fails. A pure
  // lease (claimedCount === 0, leasedCount > 0) must get the distinct
  // `reserved-in-flight` reason and never mention ack.
  it('reports `reserved-in-flight` (never ack) when the only held normal event is leased, not claimed (issue #300, round 10)', () => {
    // unreadCount=1, pendingCount=0 (excluded because leased), no claimed ids,
    // leasedCount=1.
    const hold = classifyReminderHold('normal', 1, 0, [], 1);
    expect(hold).toMatchObject({
      urgency: 'normal',
      reason: 'reserved-in-flight',
      unreadCount: 1,
      pendingCount: 0,
      leasedCount: 1,
    });
    expect(hold?.message).toContain('turn-interruptible');
    expect(hold?.message).toContain('in-flight channel-push reservation');
    expect(hold?.message).not.toContain('agentmonitors events ack');
    expect(hold?.message).not.toMatch(/\back\b/i);
  });

  it('reports `coalesced-until-ack` (not `already-claimed`) when a normal band mixes a durable claim with a live lease (issue #300, round 10)', () => {
    // unreadCount=2, pendingCount=0, one claimed id, leasedCount=1 →
    // claimedCount=1: a real claim is present, but the ack remedy must not
    // claim to cover the leased row too.
    const hold = classifyReminderHold('normal', 2, 0, ['evt-claimed'], 1);
    expect(hold).toMatchObject({
      urgency: 'normal',
      reason: 'coalesced-until-ack',
      unreadCount: 2,
      pendingCount: 0,
      claimedEventIds: ['evt-claimed'],
      leasedCount: 1,
    });
    expect(hold?.message).toContain('1 of 2');
    expect(hold?.message).toContain('agentmonitors events ack');
    expect(hold?.message).toContain('in-flight channel-push reservation');
  });

  it('reports no hold when a leased normal row coexists with a genuinely unclaimed one (nothing claimed, nothing leased-only-blocking)', () => {
    // This case cannot actually occur through the runtime (a lease always
    // suppresses per the guard), but pins the boundary: claimedCount=0 and
    // leasedCount=0 together still means "fires".
    expect(classifyReminderHold('normal', 1, 1, [], 0)).toBeNull();
  });
});

describe('classifySettleWindowHold', () => {
  it('reports no hold when there is no pending high-urgency work', () => {
    expect(classifySettleWindowHold([], 0, NOW, SETTLE_MS)).toBeNull();
  });

  it('reports no hold when at least one pending event is already settled (claimDelivery would deliver it)', () => {
    const createdAt = new Date(NOW.getTime() - SETTLE_MS); // exactly settled
    expect(classifySettleWindowHold([createdAt], 1, NOW, SETTLE_MS)).toBeNull();
  });

  it('reports `settle-window` when pending high-urgency work is entirely unsettled', () => {
    // Fired 5s ago; needs 15s → 10s remaining.
    const createdAt = new Date(NOW.getTime() - 5_000);
    const hold = classifySettleWindowHold([createdAt], 1, NOW, SETTLE_MS);
    expect(hold).toMatchObject({
      urgency: 'high',
      reason: 'settle-window',
      unreadCount: 1,
      pendingCount: 1,
      settleRemainingMs: 10_000,
    });
    expect(hold?.message).toContain('15s settle window');
    expect(hold?.message).toContain('~10s remaining');
  });

  it('reports remaining time from the OLDEST unsettled event when several are pending', () => {
    const newer = new Date(NOW.getTime() - 2_000); // 13s remaining
    const older = new Date(NOW.getTime() - 8_000); // 7s remaining (governs)
    const hold = classifySettleWindowHold([newer, older], 2, NOW, SETTLE_MS);
    expect(hold?.settleRemainingMs).toBe(7_000);
    expect(hold?.pendingCount).toBe(2);
  });
});

// Issue #441 cross-monitor coalescing (PR #456 review findings 1 & 3):
// `decideDelivery` now withholds a fully-due normal reminder while a
// concurrent high-urgency event is pending but unsettled, so it can coalesce
// into that delivery once it settles instead of firing standalone first.
describe('classifyCoalescingWithheldHold', () => {
  it('reports a `settle-window` hold on the normal band when the reminder is fully due but high-urgency work is pending and unsettled', () => {
    const hold = classifyCoalescingWithheldHold(1, 1, 1, 0);
    expect(hold).toMatchObject({
      urgency: 'normal',
      reason: 'settle-window',
      unreadCount: 1,
      pendingCount: 1,
    });
    expect(hold?.message).toContain('settle window');
    expect(hold?.message).toContain('coalesced');
  });

  it('reports no hold when there is no pending high-urgency work (the reminder fires standalone)', () => {
    expect(classifyCoalescingWithheldHold(1, 1, 0, 0)).toBeNull();
  });

  it('reports no hold once high-urgency work has settled (it coalesces the reminder instead of withholding it)', () => {
    expect(classifyCoalescingWithheldHold(1, 1, 1, 1)).toBeNull();
  });

  it('reports no hold when the reminder is not otherwise fully due (a claimed row already blocks it — classifyReminderHold explains that case)', () => {
    // unread=2, pending=1: some claimed. classifyCoalescingWithheldHold defers
    // to classifyReminderHold's coalesced-until-ack for this shape.
    expect(classifyCoalescingWithheldHold(2, 1, 1, 0)).toBeNull();
  });

  it('reports no hold when the reminder’s only unread row is leased (pending < unread) — defers to classifyReminderHold’s reserved-in-flight (issue #441 × #300)', () => {
    // unread=1, pending=0 (the single unread normal row is lease-excluded from
    // `pendingForClaim`), pendingHigh=1, settledHigh=0. reminderDue is false
    // (0 ≠ 1), so this classifier returns null and the lease is diagnosed by
    // classifyReminderHold as reserved-in-flight instead — matching
    // `decideDelivery`, which does not coalesce a leased normal row.
    expect(classifyCoalescingWithheldHold(1, 0, 1, 0)).toBeNull();
  });

  it('reports no hold when there is no unread normal work at all', () => {
    expect(classifyCoalescingWithheldHold(0, 0, 1, 0)).toBeNull();
  });
});
