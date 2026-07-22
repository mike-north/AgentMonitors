/**
 * Tests for `AgentMonitorRuntime.diagnoseHookDelivery` (issue #334) — the
 * read-only diagnosis behind `hook deliver --debug`. These drive the real
 * runtime + store (not hand-built counts) so the precedence between the
 * high-urgency settle window and the normal-reminder coalescing guard matches
 * `claimDelivery` exactly, and assert the diagnosis never mutates state.
 *
 * @see ./hook-delivery-diagnosis.test.ts (pure classifier unit tests)
 * @see ../../../../docs/specs/002-runtime-delivery.md §9 (delivery lifecycles)
 * @see ../../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type { Urgency } from '../schema/types.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  workspace: string;
}

function setup(): Harness {
  const workspace = mkdtempSync(path.join(tmpdir(), 'agentmon-diag-'));
  tempDirs.push(workspace);
  const store = new RuntimeStore(createDb(path.join(workspace, 'agentmon.db')));
  const runtime = new AgentMonitorRuntime(store, new SourceRegistry(), [
    claudeCodeAdapter,
  ]);
  return { runtime, store, workspace };
}

function openLead(h: Harness, hostSessionId: string): string {
  return h.runtime.openSession({
    adapter: 'claude-code',
    hostSessionId,
    agentIdentity: hostSessionId,
    role: 'lead',
    workspacePath: h.workspace,
    hookStatePath: path.join(h.workspace, `${hostSessionId}.json`),
  }).id;
}

let seq = 0;

/** Materialize one shared event and project it into the workspace's lead sessions. */
function materialize(
  h: Harness,
  urgency: Urgency,
  monitorId: string,
  objectKey: string,
  createdAt: Date,
): string {
  seq += 1;
  const body = `body-${String(seq)}`;
  return h.store.insertEvent({
    workspacePath: h.workspace,
    monitorId,
    sourceName: 'manual',
    urgency,
    title: `${monitorId} fired`,
    body,
    summary: body,
    payload: {},
    snapshotMetadata: {},
    snapshotText: null,
    diffText: null,
    objectKey,
    baselineStrategy: 'incremental',
    queryScope: {},
    tags: [],
    createdAt,
  }).id;
}

const SETTLE_MS = 15_000;
const NOW = new Date('2026-07-14T12:00:00.000Z');

describe('diagnoseHookDelivery', () => {
  it('reports empty unread counts and no holds for a session with nothing pending', () => {
    const h = setup();
    const session = openLead(h, 'sess-empty');
    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    expect(diagnosis).toMatchObject({
      sessionId: session,
      lifecycle: 'turn-interruptible',
      unreadCounts: { low: 0, normal: 0, high: 0, total: 0 },
      holds: [],
    });
  });

  it('reports a `settle-window` hold for high-urgency work that has not aged past the claim-time threshold (002 §9.1)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = setup();
    const session = openLead(h, 'sess-settle');
    // Fired 5s ago — well short of the 15s claim-time settle threshold.
    materialize(h, 'high', 'mon', 'obj-a', new Date(NOW.getTime() - 5_000));

    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    expect(diagnosis.unreadCounts).toMatchObject({ high: 1, total: 1 });
    expect(diagnosis.holds).toHaveLength(1);
    expect(diagnosis.holds[0]).toMatchObject({
      urgency: 'high',
      reason: 'settle-window',
      unreadCount: 1,
      pendingCount: 1,
      settleRemainingMs: 10_000,
      // Nothing is claimed yet — the hold is purely "not aged in".
      claimedEventIds: [],
    });

    // Read-only: nothing was claimed by diagnosing.
    expect(h.store.pendingEventsForSession(session, 'high')).toHaveLength(1);
    expect(h.runtime.claimDelivery(session, 'turn-interruptible')).toBeNull(); // still unsettled — a real claim would ALSO surface nothing.
  });

  it('reports no hold once the high-urgency event has aged past the settle window (would deliver)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = setup();
    const session = openLead(h, 'sess-settled');
    materialize(h, 'high', 'mon', 'obj-a', new Date(NOW.getTime() - SETTLE_MS));

    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    expect(diagnosis.holds).toEqual([]);
  });

  it('reports `already-claimed` for the normal reminder once its only unread event is claimed, and diagnosing never claims it itself (002 §9.2)', () => {
    const h = setup();
    const session = openLead(h, 'sess-normal');
    const eventId = materialize(h, 'normal', 'mon', 'obj-a', new Date());

    // Diagnosing BEFORE any claim: the reminder would fire, so no hold.
    expect(
      h.runtime.diagnoseHookDelivery(session, 'turn-interruptible').holds,
    ).toEqual([]);
    // Diagnosis is read-only — it must not have claimed the event.
    expect(h.store.pendingEventsForSession(session, 'normal')).toHaveLength(1);

    // A real claim fires the reminder and claims the event (§9.2).
    const claim = h.runtime.claimDelivery(session, 'turn-interruptible');
    expect(claim?.mode).toBe('delivery');
    expect(claim?.urgency).toBe('normal');

    // NOW diagnosing explains the suppressed second claim.
    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    expect(diagnosis.unreadCounts).toMatchObject({ normal: 1, total: 1 });
    expect(diagnosis.holds).toHaveLength(1);
    expect(diagnosis.holds[0]).toMatchObject({
      urgency: 'normal',
      reason: 'already-claimed',
      unreadCount: 1,
      pendingCount: 0,
      // Regression (issue #425 review, round 6): the exact claimed event id
      // must be named, not merely a count, so a caller can acknowledge
      // precisely this row instead of every unread event on the session.
      claimedEventIds: [eventId],
    });
    expect(h.runtime.claimDelivery(session, 'turn-interruptible')).toBeNull(); // matches the diagnosis
  });

  it('reports `coalesced-until-ack` when unread normal events mix claimed and unclaimed', () => {
    const h = setup();
    const session = openLead(h, 'sess-mixed');
    const claimedId = materialize(h, 'normal', 'mon', 'obj-a', new Date());
    h.runtime.claimDelivery(session, 'turn-interruptible'); // claims obj-a
    const unclaimedId = materialize(h, 'normal', 'mon', 'obj-b', new Date()); // fresh, unclaimed

    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    expect(diagnosis.unreadCounts).toMatchObject({ normal: 2, total: 2 });
    expect(diagnosis.holds).toHaveLength(1);
    expect(diagnosis.holds[0]).toMatchObject({
      urgency: 'normal',
      reason: 'coalesced-until-ack',
      unreadCount: 2,
      pendingCount: 1,
      // Only the CLAIMED event is named — the fresh unclaimed one must not
      // be swept into a remediation scoped to "the events holding this
      // reminder back".
      claimedEventIds: [claimedId],
    });
    expect(diagnosis.holds[0]?.claimedEventIds).not.toContain(unclaimedId);
  });

  // PR #456 review finding 3: a prior version of this diagnosis SUPPRESSED
  // the normal-reminder hold check entirely whenever settled high-urgency
  // work existed, on the theory that settled-high work always preempts the
  // normal reminder — true only when the reminder is otherwise fully due (it
  // then coalesces INTO the settled-high delivery, issue #441). It is false
  // whenever the coalesced-until-ack guard (#333) is already blocking the
  // reminder on its OWN — that hold is independent of any concurrent
  // high-urgency work, and the settled-high delivery does not claim (or even
  // touch) the blocked normal rows. This reproduces exactly that case:
  // settled high-urgency work is pending AND a normal event is
  // claimed-but-unacknowledged alongside a fresh unclaimed one — the
  // `coalesced-until-ack` hold on the normal band must still be reported.
  it('reports a `coalesced-until-ack` normal hold even while settled high-urgency work is ALSO pending (issue #441 review finding 3)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = setup();
    const session = openLead(h, 'sess-mixed-with-high');

    // A normal event, claimed while no high-urgency work exists yet (fires
    // standalone).
    materialize(h, 'normal', 'mon-n', 'obj-n', NOW);
    h.runtime.claimDelivery(session, 'turn-interruptible');
    // A second, fresh normal event — unclaimed. Guard (#333) now blocks the
    // reminder: not every unread normal event is unclaimed.
    materialize(h, 'normal', 'mon-n2', 'obj-n2', NOW);
    // A settled high event arrives too — `claimDelivery` would deliver it
    // ALONE (the guard above blocks coalescing the normal rows into it).
    materialize(
      h,
      'high',
      'mon-h',
      'obj-h',
      new Date(NOW.getTime() - SETTLE_MS),
    );

    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    const normalHold = diagnosis.holds.find(
      (hold) => hold.urgency === 'normal',
    );
    expect(normalHold).toMatchObject({
      urgency: 'normal',
      reason: 'coalesced-until-ack',
      unreadCount: 2,
      pendingCount: 1,
    });
  });

  // PR #456 review finding 1: a normal reminder that WOULD otherwise fire
  // standalone (every unread event still unclaimed) is now withheld while
  // sibling high-urgency work is pending but has not yet settled — it is
  // coalesced into that delivery once it settles, in the SAME call, instead
  // of firing separately now. The diagnosis must report this as a hold too
  // (a NEW `settle-window` reason on the `normal` band, distinct from the
  // `coalesced-until-ack` case above), or `--debug` would claim nothing is
  // held while `claimDelivery` is genuinely withholding the reminder.
  it('reports a `settle-window` normal hold when a fully-due reminder is withheld by a concurrent unsettled high-urgency event (issue #441 review finding 1/3)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = setup();
    const session = openLead(h, 'sess-withheld');

    // Both fire together, unsettled: the reminder is fully due (every unread
    // normal event unclaimed) but must be withheld until the high settles.
    materialize(h, 'normal', 'mon-n', 'obj-n', NOW);
    materialize(h, 'high', 'mon-h', 'obj-h', NOW);

    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    const normalHold = diagnosis.holds.find(
      (hold) => hold.urgency === 'normal',
    );
    expect(normalHold).toMatchObject({
      urgency: 'normal',
      reason: 'settle-window',
      unreadCount: 1,
      pendingCount: 1,
    });
    expect(normalHold?.message).toContain('settle window');

    // Confirms `claimDelivery` genuinely agrees: nothing surfaces yet.
    expect(h.runtime.claimDelivery(session, 'turn-interruptible')).toBeNull();
  });

  // Reconciliation regression (issue #441 × #300/#445): the coalescing-window
  // fire gate (`normalPending.length === unreadNormal.length`) is LEASE-AWARE —
  // `pendingForClaim` excludes a normal row reserved by an in-flight channel
  // push. So when a normal reminder's only unread row is LEASED and a sibling
  // high-urgency event is concurrently pending-and-unsettled, the reminder is
  // NOT due (pending 0 ≠ unread 1): it is deferred by the lease, not withheld
  // for coalescing. Both surfaces must agree — `decideDelivery` surfaces
  // nothing, and the diagnosis names the normal band `reserved-in-flight`
  // (NOT the `settle-window`/coalescing-withheld reason of the finding-1 case
  // above, which requires a fully-due, unleased reminder). Once the lease
  // resolves and the high settles, the SAME reminder coalesces normally.
  it('defers a leased normal row to `reserved-in-flight` (not coalescing-withheld) while a sibling high-urgency event is unsettled, then coalesces once the lease resolves and the high settles (issue #441 × #300 reconciliation)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = setup();
    const session = openLead(h, 'sess-leased-coalesce');

    // A normal reminder becomes fully due with no high work yet, so reserving
    // it leases its only unread normal row (the in-flight channel-push state).
    materialize(h, 'normal', 'mon-n', 'obj-n', NOW);
    const reservation = h.runtime.reserveDelivery(
      session,
      'turn-interruptible',
    );
    expect(reservation).not.toBeNull();
    if (!reservation) throw new Error('expected a reservation to be created');

    // A sibling high-urgency event arrives, still inside its settle window.
    materialize(h, 'high', 'mon-h', 'obj-h', NOW);

    // Fire decision: nothing surfaces — the leased normal row is not due, and
    // the high is unsettled, so there is nothing to coalesce.
    expect(h.runtime.claimDelivery(session, 'turn-interruptible')).toBeNull();

    // Diagnosis: the normal band is `reserved-in-flight` (the lease defers it),
    // NOT the coalescing-withheld `settle-window` reason — and it never
    // recommends ack for a merely-leased row. The high band is `settle-window`.
    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    const normalHold = diagnosis.holds.find(
      (hold) => hold.urgency === 'normal',
    );
    expect(normalHold).toMatchObject({
      urgency: 'normal',
      reason: 'reserved-in-flight',
      unreadCount: 1,
      pendingCount: 0,
      leasedCount: 1,
    });
    expect(normalHold?.message).not.toContain('events ack');
    const highHold = diagnosis.holds.find((hold) => hold.urgency === 'high');
    expect(highHold?.reason).toBe('settle-window');

    // Once the push fails/releases and the high settles, the SAME reminder
    // coalesces into the now-settled high delivery in ONE call.
    h.runtime.releaseDelivery(reservation.reservationId);
    vi.setSystemTime(new Date(NOW.getTime() + SETTLE_MS));
    const claim = h.runtime.claimDelivery(session, 'turn-interruptible');
    expect(claim?.urgency).toBe('high');
    expect(claim?.events).toHaveLength(1);
    expect(claim?.coalescedReminder).toBe('Monitored changes are pending.');
  });

  it('diagnoses the low band at turn-idle only (002 §9.3)', () => {
    const h = setup();
    const session = openLead(h, 'sess-low');
    const eventId = materialize(h, 'low', 'mon', 'obj-a', new Date());
    h.runtime.claimDelivery(session, 'turn-idle'); // fires + claims the low reminder

    const idle = h.runtime.diagnoseHookDelivery(session, 'turn-idle');
    expect(idle.holds).toHaveLength(1);
    expect(idle.holds[0]).toMatchObject({
      urgency: 'low',
      reason: 'already-claimed',
      claimedEventIds: [eventId],
    });

    // turn-interruptible has no low-band guard to report.
    const interruptible = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    expect(interruptible.holds).toEqual([]);
  });

  it('post-compact reports counts but no band-specific holds (recap has no coalescing guard)', () => {
    const h = setup();
    const session = openLead(h, 'sess-recap');
    materialize(h, 'normal', 'mon', 'obj-a', new Date());

    const diagnosis = h.runtime.diagnoseHookDelivery(session, 'post-compact');
    expect(diagnosis.unreadCounts).toMatchObject({ normal: 1, total: 1 });
    expect(diagnosis.holds).toEqual([]);
  });
});
