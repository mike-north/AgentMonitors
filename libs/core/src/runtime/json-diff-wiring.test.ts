/**
 * Tests for the PRODUCTION WIRING of the `json-diff` structural renderer
 * (issue #437 review, comment 3608965102): the `diff.test.ts` suite exercises
 * `buildDiff`/`buildJsonDiff` directly, but not the actual call sites that
 * decide `strategy` from persisted `snapshotMetadata` and materialize the
 * result — `AgentMonitorRuntime.processObservation` (`service.ts`),
 * `RuntimeStore.insertEvent` (per-recipient projection), and
 * `RuntimeStore.collapseNetForClaim` (net-collapse recomputation).
 *
 * These exercise the durable substrate directly through {@link RuntimeStore},
 * mirroring `processObservation`'s materialize flow (`changeDetectionStrategyOf`
 * read off `snapshotMetadata`, then `buildDiff(previous, current, strategy)`)
 * rather than re-deriving the diff by hand, so a regression in the actual
 * strategy-selection wiring — not just the renderer itself — is caught.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2 (diff renderer selection)
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.7 (net-collapse recomputation)
 * @see ../../../../docs/specs/003-source-plugins.md §4.2, §11.3 (json-diff strategy)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { buildDiff, changeDetectionStrategyOf } from './diff.js';
import { RuntimeStore } from './store.js';
import type { MonitorEventRecord } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const MONITOR_ID = 'watcher';
const OBJECT_KEY = 'obj-1';
const WORKSPACE = '/ws';

/** Deterministic, strictly-increasing event timestamps (no real clock). */
let clock = 0;
function nextTime(): Date {
  clock += 1_000;
  return new Date(Date.UTC(2026, 0, 1) + clock);
}

function freshStore(): { store: RuntimeStore; dbPath: string } {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-jsondiffwire-'));
  tempDirs.push(rootDir);
  const dbPath = path.join(rootDir, 'agentmon.db');
  return { store: new RuntimeStore(createDb(dbPath)), dbPath };
}

function openLead(store: RuntimeStore, hostSessionId: string): string {
  return store.openSession({
    adapter: 'claude-code',
    hostSessionId,
    agentIdentity: hostSessionId,
    role: 'lead',
    workspacePath: WORKSPACE,
    hookStatePath: path.join(WORKSPACE, `${hostSessionId}.json`),
  }).id;
}

/**
 * Materialize ONE shared `json-diff` event for {@link OBJECT_KEY}, replicating
 * `processObservation`'s ACTUAL wiring (`service.ts` ~3215–3221): read the
 * `snapshotMetadata.strategy` back off via `changeDetectionStrategyOf`, then
 * render the shared diff via `buildDiff(previous, current, strategy)` — never
 * a hand-picked renderer — so this test would catch a regression in the
 * production strategy-selection wiring itself, not just the renderer.
 */
function materializeJsonDiff(
  store: RuntimeStore,
  artifact: string,
  baselineStrategy: 'incremental' | 'net' = 'incremental',
): MonitorEventRecord {
  const snapshotMetadata = { strategy: 'json-diff' };
  const strategy = changeDetectionStrategyOf(snapshotMetadata);
  const previous = store.latestSnapshot(MONITOR_ID, OBJECT_KEY, WORKSPACE);
  const sharedDiff = previous
    ? buildDiff(previous.content, artifact, strategy)
    : null;
  const event = store.insertEvent(
    {
      workspacePath: WORKSPACE,
      monitorId: MONITOR_ID,
      sourceName: 'manual',
      urgency: 'normal',
      title: 'change',
      body: '',
      summary: '',
      payload: {},
      snapshotMetadata,
      snapshotText: artifact,
      diffText: sharedDiff,
      objectKey: OBJECT_KEY,
      baselineStrategy,
      queryScope: {},
      tags: [],
      createdAt: nextTime(),
    },
    { previousContent: previous?.content ?? null },
  );
  store.saveSnapshot({
    workspacePath: WORKSPACE,
    monitorId: MONITOR_ID,
    objectKey: OBJECT_KEY,
    eventId: event.id,
    content: artifact,
  });
  return event;
}

function recipientDelta(
  store: RuntimeStore,
  sessionId: string,
  eventId: string,
): string | undefined {
  return store.perRecipientDiffsForSession(sessionId, [eventId]).get(eventId);
}

const ARRAY_V1 = JSON.stringify([
  { id: 1, title: 'first' },
  { id: 2, title: 'second' },
]);
const ARRAY_V2_REMOVE_2 = JSON.stringify([{ id: 1, title: 'first' }]);
const ARRAY_V3_ADD_3 = JSON.stringify([
  { id: 1, title: 'first' },
  { id: 3, title: 'third' },
]);

describe('json-diff production wiring — shared monitor_events.diff_text', () => {
  it('renders a structural diff (not a compact-JSON line diff) via the real strategy-selection path', () => {
    const { store } = freshStore();
    materializeJsonDiff(store, ARRAY_V1);
    const event2 = materializeJsonDiff(store, ARRAY_V2_REMOVE_2);

    expect(event2.diffText).toBeDefined();
    expect(event2.diffText).toContain('removed[id=2]');
    // The structural renderer never degrades to a whole-line remove-all/
    // add-all of the compact single-line JSON (issue #437's original bug).
    expect(event2.diffText).not.toContain(ARRAY_V1);
    expect(event2.diffText).not.toContain(ARRAY_V2_REMOVE_2);
  });
});

describe('json-diff production wiring — divergent per-recipient session_event_state.diff_text', () => {
  it('two recipients at divergent baselines each receive their OWN structural per-recipient diff from one shared event', () => {
    const { store } = freshStore();
    const a = openLead(store, 'sess-A');
    const b = openLead(store, 'sess-B');

    // obs1: baseline event for both A and B (no prior snapshot).
    const e1 = materializeJsonDiff(store, ARRAY_V1);
    // A claims through obs1 -> A's cursor advances to ARRAY_V1.
    store.markClaimed(a, [e1.id], 'turn-interruptible');
    // B never claims -> B's cursor stays seeded at its pre-event baseline
    // (there was none, so B is seeded to ARRAY_V1 too on first projection).

    // obs2: ONE shared event, projected into both A and B.
    const e2 = materializeJsonDiff(store, ARRAY_V2_REMOVE_2);

    const deltaA = recipientDelta(store, a, e2.id);
    const deltaB = recipientDelta(store, b, e2.id);

    expect(deltaA).toBeDefined();
    expect(deltaB).toBeDefined();
    // Both recipients are anchored at ARRAY_V1 here (A explicitly claimed it;
    // B was seeded to it as its pre-event baseline), so both spans are
    // identical structural diffs — the key assertion is that BOTH are
    // structural (json-diff renderer), not that they differ in this
    // particular scenario.
    expect(deltaA).toBe(deltaB);
    expect(deltaA).toContain('removed[id=2]');
  });

  it('a recipient that claimed further ahead receives a DIFFERENT structural span than one still at the earlier baseline', () => {
    const { store } = freshStore();
    const a = openLead(store, 'sess-A');
    const b = openLead(store, 'sess-B');

    const e1 = materializeJsonDiff(store, ARRAY_V1);
    const e2 = materializeJsonDiff(store, ARRAY_V2_REMOVE_2);
    // A claims through e1 AND e2 -> A's cursor advances to ARRAY_V2_REMOVE_2.
    store.markClaimed(a, [e1.id, e2.id], 'turn-interruptible');
    // B never claims -> B's cursor stays at ARRAY_V1 (its seeded baseline).

    // obs3: ONE shared event, projected into both.
    const e3 = materializeJsonDiff(store, ARRAY_V3_ADD_3);

    const deltaA = recipientDelta(store, a, e3.id);
    const deltaB = recipientDelta(store, b, e3.id);

    expect(deltaA).toBeDefined();
    expect(deltaB).toBeDefined();
    expect(deltaA).not.toBe(deltaB);
    // A spans ARRAY_V2_REMOVE_2 -> ARRAY_V3_ADD_3: id 2 stays removed, id 3 added.
    expect(deltaA).toContain('added[id=3]');
    expect(deltaA).not.toContain('removed[id=2]');
    // B spans ARRAY_V1 -> ARRAY_V3_ADD_3 (its own baseline, the whole catch-up):
    // id 2 removed AND id 3 added, in the same structural diff.
    expect(deltaB).toContain('removed[id=2]');
    expect(deltaB).toContain('added[id=3]');
  });
});

describe('json-diff production wiring — net-collapse recomputation after a persistence round-trip', () => {
  it('a net-collapsed recipient receives a structural diff recomputed cursor -> newest artifact, surviving a fresh RuntimeStore over the same DB', () => {
    const { store, dbPath } = freshStore();
    const away = openLead(store, 'sess-away');

    // Baseline event; the recipient claims it so its cursor anchors at ARRAY_V1.
    const e0 = materializeJsonDiff(store, ARRAY_V1, 'net');
    store.markClaimed(away, [e0.id], 'turn-interruptible');

    // Two more `net` events land while the recipient is away.
    materializeJsonDiff(store, ARRAY_V2_REMOVE_2, 'net');
    materializeJsonDiff(store, ARRAY_V3_ADD_3, 'net');

    // Simulate a daemon restart (BP1): a brand-new RuntimeStore over the SAME
    // on-disk SQLite file — the net-collapse recomputation must still find the
    // persisted cursor and re-render structurally, not just in the original
    // in-process instance.
    const restarted = new RuntimeStore(createDb(dbPath));

    const candidates = restarted.pendingEventsForSession(away);
    const delivered = restarted.collapseNetForClaim(away, candidates);
    restarted.markClaimed(
      away,
      candidates.map((event) => event.id),
      'turn-interruptible',
    );

    // Exactly one net-collapsed delivery for the object (the two intermediates
    // are claimed-but-suppressed, per 002 §1.1.7).
    expect(delivered).toHaveLength(1);
    const deliveredDelta = restarted
      .perRecipientDiffsForSession(away, [delivered[0]?.id ?? ''])
      .get(delivered[0]?.id ?? '');

    expect(deliveredDelta).toBeDefined();
    // Recomputed cursor (ARRAY_V1) -> newest artifact (ARRAY_V3_ADD_3):
    // id 2 removed, id 3 added — the WHOLE catch-up span, structurally
    // rendered (not a line diff of the intermediate ARRAY_V2_REMOVE_2 step).
    expect(deliveredDelta).toContain('removed[id=2]');
    expect(deliveredDelta).toContain('added[id=3]');
  });
});
