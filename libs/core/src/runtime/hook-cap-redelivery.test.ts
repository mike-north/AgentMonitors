/**
 * Tests for the capped high-urgency delivery claim (issue #299).
 *
 * The defect: a `turn-interruptible` claim marked the FULL settled high-urgency
 * candidate set CLAIMED before a length-bounded transport (the hook-deliver
 * 4000-char `additionalContext`, 006 §5.1/§5.5) rendered and truncated it — so
 * events truncated out of the visible context were claimed
 * (`first_notified_at` set) and NEVER re-delivered at the next context event,
 * even though they stayed unread. This silently loses signal for exactly the
 * sessions with the MOST pending work.
 *
 * The fix: `claimDelivery` accepts `maxEvents`, and the transport sizes how many
 * whole event blocks fit (via `previewSettledHighDelivery`) and passes that
 * count, so the claim-set equals the render-set and the deferred remainder stays
 * pending to re-deliver next context event. These tests drive the core methods
 * directly with deterministic, already-settled events (no real-clock waits).
 *
 * @see ../../../../docs/specs/006-agent-integration.md §5.5 (unread-recoverability, redelivery)
 * @see ../../../../docs/specs/002-runtime-delivery.md §9 (claimed vs unread vs acknowledged)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';

const tempDirs: string[] = [];

afterEach(() => {
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
  const workspace = mkdtempSync(path.join(tmpdir(), 'agentmon-cap-'));
  tempDirs.push(workspace);
  const store = new RuntimeStore(createDb(path.join(workspace, 'agentmon.db')));
  const runtime = new AgentMonitorRuntime(store, new SourceRegistry(), [
    claudeCodeAdapter,
  ]);
  return { runtime, store, workspace };
}

/** Open a lead session in the workspace and return its (internal) id. */
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

// Deterministic timestamps far in the past so every event is already SETTLED
// (older than the 15s high-urgency settle window) without any real-clock wait.
const BASE = Date.UTC(2026, 0, 1);
let seq = 0;
function nextTime(): Date {
  seq += 1;
  return new Date(BASE + seq * 1000);
}

/**
 * Materialize one shared high-urgency event and project it into the workspace's
 * lead sessions (as `processObservation` would). Distinct `objectKey`s keep the
 * default `net` collapse from folding events together unless a test intends it.
 */
function materializeHigh(
  h: Harness,
  monitorId: string,
  objectKey: string,
  body: string,
  baselineStrategy: 'incremental' | 'net' = 'incremental',
): string {
  const previous = h.store.latestSnapshot(monitorId, objectKey, h.workspace);
  const event = h.store.insertEvent(
    {
      workspacePath: h.workspace,
      monitorId,
      sourceName: 'manual',
      urgency: 'high',
      title: `${monitorId} fired`,
      body,
      summary: body.slice(0, 20),
      payload: {},
      snapshotMetadata: {},
      snapshotText: body,
      diffText: null,
      objectKey,
      baselineStrategy,
      queryScope: {},
      tags: [],
      createdAt: nextTime(),
    },
    { previousContent: previous?.content ?? null },
  );
  h.store.saveSnapshot({
    workspacePath: h.workspace,
    monitorId,
    objectKey,
    eventId: event.id,
    content: body,
  });
  return event.id;
}

describe('capped high-urgency claim + preview (issue #299)', () => {
  it('previewSettledHighDelivery returns the delivered set without claiming (non-mutating)', () => {
    const h = setup();
    const session = openLead(h, 'sess-preview');
    materializeHigh(h, 'mon-a', 'a', 'body A');
    materializeHigh(h, 'mon-b', 'b', 'body B');
    materializeHigh(h, 'mon-c', 'c', 'body C');

    const first = h.runtime.previewSettledHighDelivery(session);
    expect(first.map((e) => e.monitorId)).toEqual(['mon-a', 'mon-b', 'mon-c']);

    // Idempotent: a second preview returns the same set, and NOTHING was
    // claimed (all three remain pending for a real claim).
    const second = h.runtime.previewSettledHighDelivery(session);
    expect(second.map((e) => e.eventId)).toEqual(first.map((e) => e.eventId));
    expect(h.store.pendingEventsForSession(session, 'high')).toHaveLength(3);
  });

  // Issue #441 cross-monitor coalescing (PR #456 review finding 4):
  // `previewCoalescedReminder` must agree byte-for-byte with the eventual
  // claim's `coalescedReminder`, so a length-bounded transport can reserve
  // room for it BEFORE sizing how many event blocks fit.
  it('previewCoalescedReminder agrees with the eventual claim, and previewing claims nothing', () => {
    const h = setup();
    const session = openLead(h, 'sess-preview-reminder');
    materializeHigh(h, 'mon-a', 'a', 'body A');
    h.store.insertEvent({
      workspacePath: h.workspace,
      monitorId: 'mon-normal',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Normal fired',
      body: 'normal-body',
      summary: 'normal-body',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'normal-obj',
      queryScope: {},
      tags: [],
      createdAt: nextTime(),
    });

    const previewed = h.runtime.previewCoalescedReminder(session);
    expect(previewed).toBe('AgentMon messages are available. Read the inbox.');

    // Previewing claims nothing — the high event is still pending, and so is
    // the normal event (a real claim then coalesces both).
    expect(h.store.pendingEventsForSession(session, 'high')).toHaveLength(1);
    expect(h.store.pendingEventsForSession(session, 'normal')).toHaveLength(1);

    const claim = h.runtime.claimDelivery(session, 'turn-interruptible');
    expect(claim?.coalescedReminder).toBe(previewed);
  });

  it('previewCoalescedReminder returns undefined when no settled high-urgency work is pending to coalesce into', () => {
    const h = setup();
    const session = openLead(h, 'sess-no-high');
    h.store.insertEvent({
      workspacePath: h.workspace,
      monitorId: 'mon-normal',
      sourceName: 'manual',
      urgency: 'normal',
      title: 'Normal fired',
      body: 'normal-body',
      summary: 'normal-body',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: 'normal-obj',
      queryScope: {},
      tags: [],
      createdAt: nextTime(),
    });

    expect(h.runtime.previewCoalescedReminder(session)).toBeUndefined();
  });

  it('claims ONLY the capped subset; the deferred remainder re-delivers at the next claim', () => {
    const h = setup();
    const session = openLead(h, 'sess-cap');
    const idA = materializeHigh(h, 'mon-a', 'a', 'body A');
    const idB = materializeHigh(h, 'mon-b', 'b', 'body B');
    const idC = materializeHigh(h, 'mon-c', 'c', 'body C');

    // First claim caps at 2 → surfaces the two OLDEST, claims ONLY those two.
    const first = h.runtime.claimDelivery(session, 'turn-interruptible', 2);
    expect(first?.events.map((e) => e.eventId)).toEqual([idA, idB]);

    // The third event was NOT claimed — it is still pending (the bug: it would
    // have been claimed and lost). All three remain UNREAD (claiming ≠ acking).
    expect(
      h.store.pendingEventsForSession(session, 'high').map((e) => e.id),
    ).toEqual([idC]);
    expect(h.store.unreadEventsForSession(session, 'high')).toHaveLength(3);

    // Second claim re-delivers exactly the deferred remainder, in order.
    const second = h.runtime.claimDelivery(session, 'turn-interruptible', 2);
    expect(second?.events.map((e) => e.eventId)).toEqual([idC]);

    // Nothing left to deliver at turn-interruptible.
    expect(
      h.runtime.claimDelivery(session, 'turn-interruptible', 2),
    ).toBeNull();
  });

  it('an uncapped claim still claims the full delivered set (unchanged default)', () => {
    const h = setup();
    const session = openLead(h, 'sess-uncapped');
    materializeHigh(h, 'mon-a', 'a', 'body A');
    materializeHigh(h, 'mon-b', 'b', 'body B');

    const claim = h.runtime.claimDelivery(session, 'turn-interruptible');
    expect(claim?.events).toHaveLength(2);
    expect(h.store.pendingEventsForSession(session, 'high')).toHaveLength(0);
    expect(h.runtime.claimDelivery(session, 'turn-interruptible')).toBeNull();
  });

  it('caps at a minimum of 1 event so a claim always makes forward progress', () => {
    const h = setup();
    const session = openLead(h, 'sess-floor');
    const idA = materializeHigh(h, 'mon-a', 'a', 'body A');
    materializeHigh(h, 'mon-b', 'b', 'body B');

    // maxEvents=1 surfaces and claims exactly one (the oldest).
    const claim = h.runtime.claimDelivery(session, 'turn-interruptible', 1);
    expect(claim?.events.map((e) => e.eventId)).toEqual([idA]);
    expect(h.store.pendingEventsForSession(session, 'high')).toHaveLength(1);
  });

  // (issue #299 review — Copilot 3581228300) The MUTATING net collapse (delta
  // re-anchoring + `net_suppressed_at`) must run ONLY on the groups a capped
  // claim actually surfaces. The pre-fix code ran `collapseNetForClaim` on the
  // FULL settled set BEFORE applying the cap, so a DEFERRED object's older
  // intermediates were marked net-suppressed while their group was never
  // claimed — orphaning them: excluded from pending/unread (both filter
  // `net_suppressed_at IS NULL`) yet lacking a `first_notified_at`. That
  // contradicts the claimed-but-suppressed-AT-CLAIM-TIME contract (002 §1.1.7).
  it('defers a whole net object group untouched: its intermediates stay unsuppressed & pending until the group is surfaced (#299 review)', () => {
    const h = setup();
    const session = openLead(h, 'sess-net');
    const suppressedIds = (): string[] =>
      h.store
        .listDeliveryProjectionsForMonitor('mon', h.workspace)
        .filter((p) => p.sessionId === session && p.netSuppressed)
        .map((p) => p.eventId);
    const recipientDelta = (eventId: string): string | undefined =>
      h.store.perRecipientDiffsForSession(session, [eventId]).get(eventId);

    // Anchor each object's cursor at its baseline (o0, p0) with an uncapped
    // claim, so a later collapse re-anchors against o0 / p0 (a real catch-up).
    materializeHigh(h, 'mon', 'O', 'o0', 'net');
    materializeHigh(h, 'mon', 'P', 'p0', 'net');
    h.runtime.claimDelivery(session, 'turn-interruptible');
    expect(h.store.pendingEventsForSession(session, 'high')).toHaveLength(0);

    // Now, while the recipient is AWAY, two more net edits land on EACH object.
    // Delivered view (newest per object) = [o2, p2]; o1, p1 fold within a claim.
    const o1 = materializeHigh(h, 'mon', 'O', 'o1', 'net');
    const o2 = materializeHigh(h, 'mon', 'O', 'o2', 'net');
    const p1 = materializeHigh(h, 'mon', 'P', 'p1', 'net');
    const p2 = materializeHigh(h, 'mon', 'P', 'p2', 'net');

    // First claim, cap=1: surfaces O's newest only and claims ONLY O's group.
    const first = h.runtime.claimDelivery(session, 'turn-interruptible', 1);
    expect(first?.events.map((e) => e.eventId)).toEqual([o2]);
    // O's delivered delta spans this recipient's cursor (o0) → endpoint (o2) —
    // the re-anchored catch-up, not the last incremental step o1 → o2
    // (002 §5.2 line format).
    expect(recipientDelta(o2)).toBe('- 1: o0\n+ 1: o2');

    // Only O's intermediate (o1) is net-suppressed; the DEFERRED object P is
    // byte-untouched — neither p1 nor p2 is suppressed.
    expect(suppressedIds()).toEqual([o1]);
    // Both of P's events remain PENDING and UNREAD (claiming ≠ acking): p1 was
    // NOT orphaned. Pre-fix, p1 was net-suppressed here and this list was [p2].
    expect(
      h.store.pendingEventsForSession(session, 'high').map((e) => e.id),
    ).toEqual([p1, p2]);
    expect(
      h.store.unreadEventsForSession(session, 'high').map((e) => e.id),
    ).toEqual(expect.arrayContaining([p1, p2]));

    // Second claim, cap=1: NOW surfaces P's newest, folding p1 → p2, and
    // delivers the re-anchored catch-up p0 → p2. Pre-fix, p1 had already been
    // suppressed (and cursor never advanced), so this delta was the wrong
    // incremental step p1 → p2.
    const second = h.runtime.claimDelivery(session, 'turn-interruptible', 1);
    expect(second?.events.map((e) => e.eventId)).toEqual([p2]);
    expect(recipientDelta(p2)).toBe('- 1: p0\n+ 1: p2');

    // Only NOW is p1 suppressed (claimed-but-suppressed at the claim that
    // actually surfaced its group), alongside the earlier o1.
    expect(suppressedIds().sort()).toEqual([o1, p1].sort());
    expect(h.store.pendingEventsForSession(session, 'high')).toHaveLength(0);

    // Nothing left to deliver.
    expect(
      h.runtime.claimDelivery(session, 'turn-interruptible', 1),
    ).toBeNull();
  });
});
