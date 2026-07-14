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
    materialize(h, 'normal', 'mon', 'obj-a', new Date());

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
    });
    expect(h.runtime.claimDelivery(session, 'turn-interruptible')).toBeNull(); // matches the diagnosis
  });

  it('reports `coalesced-until-ack` when unread normal events mix claimed and unclaimed', () => {
    const h = setup();
    const session = openLead(h, 'sess-mixed');
    materialize(h, 'normal', 'mon', 'obj-a', new Date());
    h.runtime.claimDelivery(session, 'turn-interruptible'); // claims obj-a
    materialize(h, 'normal', 'mon', 'obj-b', new Date()); // fresh, unclaimed

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
    });
  });

  it('does not evaluate the normal-reminder hold when settled high-urgency work will preempt this turn (matches claimDelivery precedence)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = setup();
    const session = openLead(h, 'sess-preempt');
    // A settled high event WILL deliver...
    materialize(
      h,
      'high',
      'mon-h',
      'obj-h',
      new Date(NOW.getTime() - SETTLE_MS),
    );
    // ...and a normal event is already claimed (would otherwise report a hold).
    materialize(h, 'normal', 'mon-n', 'obj-n', NOW);
    h.runtime.claimDelivery(session, 'turn-interruptible'); // delivers high, claims it
    materialize(h, 'normal', 'mon-n2', 'obj-n2', NOW); // stays pending

    // Re-diagnose: no more settled high work, so normal is now evaluated.
    const diagnosis = h.runtime.diagnoseHookDelivery(
      session,
      'turn-interruptible',
    );
    expect(diagnosis.holds.map((hold) => hold.urgency)).not.toContain('high');
  });

  it('diagnoses the low band at turn-idle only (002 §9.3)', () => {
    const h = setup();
    const session = openLead(h, 'sess-low');
    materialize(h, 'low', 'mon', 'obj-a', new Date());
    h.runtime.claimDelivery(session, 'turn-idle'); // fires + claims the low reminder

    const idle = h.runtime.diagnoseHookDelivery(session, 'turn-idle');
    expect(idle.holds).toHaveLength(1);
    expect(idle.holds[0]).toMatchObject({
      urgency: 'low',
      reason: 'already-claimed',
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
