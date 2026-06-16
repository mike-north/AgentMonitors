/**
 * Tests for the PER-RECIPIENT baseline seam + per-recipient Diff (roadmap G10,
 * PR-A): the Diff is moved to the RIGHT of the Pace→Diff seam so each recipient
 * (lead session) diffs the shared shaped artifact against ITS OWN baseline
 * cursor. Two sessions at divergent last-seen points each receive the correct
 * span from one shared observation.
 *
 * These exercise the durable substrate directly through {@link RuntimeStore}
 * (the persistence/session-isolation seam — the repo's #1 review priority),
 * mirroring `processObservation`'s materialize flow: read the prior object
 * snapshot, compute the shared object-level diff, `insertEvent` (which computes +
 * records each recipient's per-recipient `diff_text`), then `saveSnapshot`.
 *
 * Expected diff text is written BY HAND from the `buildTextDiff` format spec
 * (002 §5.2: line-level `- <n>: <before>` / `+ <n>: <after>`), not captured from
 * program output. No snapshot/gold-master assertions (repo policy).
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.2 (the shared/per-recipient seam)
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2 (diff format)
 * @see ../../../../docs/specs/roadmap.md §G10
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { buildTextDiff } from './diff.js';
import { RuntimeStore } from './store.js';
import type { AgentSessionRecord } from './types.js';

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

/** Deterministic, monotonically-increasing event timestamps (no real clock). */
let clock = 0;
function nextTime(): Date {
  clock += 1_000;
  return new Date(Date.UTC(2026, 0, 1) + clock);
}

/**
 * Materialize ONE shared event for {@link OBJECT_KEY} carrying `artifact`,
 * exactly as `processObservation` does: diff against the latest stored object
 * snapshot for the SHARED `monitor_events.diff_text`, project + compute each
 * recipient's per-recipient `diff_text` inside `insertEvent`, then persist the
 * new snapshot. Returns the event id.
 */
function materialize(store: RuntimeStore, artifact: string): string {
  const previous = store.latestSnapshot(MONITOR_ID, OBJECT_KEY, WORKSPACE);
  const sharedDiff = previous
    ? buildTextDiff(previous.content, artifact)
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
      snapshotMetadata: {},
      snapshotText: artifact,
      diffText: sharedDiff,
      objectKey: OBJECT_KEY,
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
  return event.id;
}

function openLead(
  store: RuntimeStore,
  hostSessionId: string,
): AgentSessionRecord {
  return store.openSession({
    adapter: 'claude-code',
    hostSessionId,
    agentIdentity: hostSessionId,
    role: 'lead',
    workspacePath: WORKSPACE,
    hookStatePath: path.join(WORKSPACE, `${hostSessionId}.json`),
  });
}

/** The per-recipient delta a session recorded for one event (NULL → undefined). */
function recipientDelta(
  store: RuntimeStore,
  sessionId: string,
  eventId: string,
): string | undefined {
  return store.perRecipientDiffsForSession(sessionId, [eventId]).get(eventId);
}

function freshStore(): { store: RuntimeStore; dbPath: string } {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-prdiff-'));
  tempDirs.push(rootDir);
  const dbPath = path.join(rootDir, 'agentmon.db');
  return { store: new RuntimeStore(createDb(dbPath)), dbPath };
}

describe('per-recipient baseline seam (G10 PR-A, 002 §1.1.2)', () => {
  it('1. divergent-baseline fan-out: A spans artifact2→artifact3, B spans artifact1→artifact3 from one shared obs3', () => {
    const { store } = freshStore();
    const a = openLead(store, 'sess-A');
    const b = openLead(store, 'sess-B');

    // obs1 (artifact "a1"): baseline event for both A and B (no prior snapshot).
    const e1 = materialize(store, 'a1');
    // obs2 (artifact "a2"): both still co-registered at the same cursor.
    const e2 = materialize(store, 'a2');

    // A claims through obs2 → A's cursor advances to artifact2 ("a2").
    store.markClaimed(a.id, [e1, e2], 'turn-interruptible');
    // B stays away — never claims — so B's cursor remains where it was seeded at
    // obs1 ("a1"), i.e. B is still anchored at artifact1.

    // obs3 (artifact "a3"): ONE shared event, projected into both.
    const e3 = materialize(store, 'a3');

    // THE proof (002 §1.1.2 / roadmap G10): different spans from one shared obs.
    // buildTextDiff format (002 §5.2): single changed line 1.
    expect(recipientDelta(store, a.id, e3)).toBe('- 1: a2\n+ 1: a3');
    expect(recipientDelta(store, b.id, e3)).toBe('- 1: a1\n+ 1: a3');
  });

  it('2. cursors are restart-safe: per-recipient diffs span from persisted cursors after a fresh runtime over the same DB', () => {
    const { store, dbPath } = freshStore();
    const a = openLead(store, 'sess-A');
    const b = openLead(store, 'sess-B');

    const e1 = materialize(store, 'a1');
    const e2 = materialize(store, 'a2');
    store.markClaimed(a.id, [e1, e2], 'turn-interruptible'); // A → cursor a2
    // B stays at a1.

    // Simulate a daemon restart/reboot: drop the in-memory store + DB handle and
    // recreate a brand-new RuntimeStore over the SAME on-disk SQLite file (BP1).
    const restarted = new RuntimeStore(createDb(dbPath));

    // A new event after restart must span each recipient from its PERSISTED
    // cursor — proving the cursors survived (002 §3, BP1), not reset to a shared
    // baseline.
    const e3 = materialize(restarted, 'a3');
    expect(recipientDelta(restarted, a.id, e3)).toBe('- 1: a2\n+ 1: a3');
    expect(recipientDelta(restarted, b.id, e3)).toBe('- 1: a1\n+ 1: a3');
  });

  it('3. session isolation: advancing one session’s cursor never changes another’s delivered delta', () => {
    const { store } = freshStore();
    const a = openLead(store, 'sess-A');
    const b = openLead(store, 'sess-B');

    const e1 = materialize(store, 'a1');
    const e2 = materialize(store, 'a2');

    // Advance ONLY A's cursor (claim) repeatedly; B is never touched.
    store.markClaimed(a.id, [e1], 'turn-interruptible');
    store.markClaimed(a.id, [e2], 'turn-interruptible'); // A → a2

    // B's cursor is structurally separate — it remains at a1.
    const bCursor = store.getSessionObjectCursor(
      b.id,
      MONITOR_ID,
      OBJECT_KEY,
      WORKSPACE,
    );
    expect(bCursor?.baselineContent).toBe('a1');

    const e3 = materialize(store, 'a3');
    // A's churn left B's delivered delta exactly the full span from artifact1.
    expect(recipientDelta(store, b.id, e3)).toBe('- 1: a1\n+ 1: a3');
    expect(recipientDelta(store, a.id, e3)).toBe('- 1: a2\n+ 1: a3');
  });

  it('4a. backward-compat: a single co-registered session reproduces the pre-G10 shared diff byte-for-byte', () => {
    const { store } = freshStore();
    const only = openLead(store, 'sess-only');

    materialize(store, 'a1'); // baseline
    const e2 = materialize(store, 'a2');

    // The pre-G10 behavior: one diff per object against the latest stored
    // snapshot. With a single session at the shared baseline, the per-recipient
    // delta MUST equal that shared object-level diff exactly.
    const shared = store.getEventById(e2).diffText;
    expect(shared).toBe('- 1: a1\n+ 1: a2');
    expect(recipientDelta(store, only.id, e2)).toBe(shared ?? undefined);
  });

  it('4b. legacy NULL per-recipient diff_text falls back to the shared event-level diff (explain projection)', () => {
    const { store, dbPath } = freshStore();
    const legacy = openLead(store, 'sess-legacy');

    materialize(store, 'a1'); // baseline
    const e2 = materialize(store, 'a2');

    // Simulate a row materialized before G10: NULL out the per-recipient column.
    nullOutPerRecipientDiff(dbPath, legacy.id, e2);
    expect(recipientDelta(store, legacy.id, e2)).toBeUndefined();

    // The explain/delivery projection must fall back to the SHARED diff_text.
    const projection = store
      .listDeliveryProjectionsForMonitor(MONITOR_ID, WORKSPACE)
      .find((p) => p.eventId === e2 && p.sessionId === legacy.id);
    expect(projection?.diffText).toBe('- 1: a1\n+ 1: a2');
  });

  it('5. new-session seed: a session registered after obs1 hears only obs2+ (not the whole current artifact)', () => {
    const { store } = freshStore();

    // obs1 happens with NO session registered yet.
    materialize(store, 'a1');

    // Session registers AFTER obs1 (caught up to the pre-obs2 state = artifact1).
    const late = openLead(store, 'sess-late');

    // obs2: the late session's FIRST projection of this object. It must hear the
    // delta artifact1→artifact2 (decided semantics Q1), NOT a full-current-state
    // first delta of the whole artifact ("" → "a2").
    const e2 = materialize(store, 'a2');
    expect(recipientDelta(store, late.id, e2)).toBe('- 1: a1\n+ 1: a2');
    // It must NOT be the whole-artifact first delta.
    expect(recipientDelta(store, late.id, e2)).not.toBe(
      buildTextDiff('', 'a2'),
    );
  });

  it('baseline event records no per-recipient delta (nothing precedes it), then seeds the cursor for the next obs', () => {
    const { store } = freshStore();
    const s = openLead(store, 'sess-1');

    const e1 = materialize(store, 'a1'); // baseline: no prior snapshot
    expect(recipientDelta(store, s.id, e1)).toBeUndefined();

    // The cursor was seeded to the baseline artifact, so the NEXT event spans
    // from it.
    const e2 = materialize(store, 'a2');
    expect(recipientDelta(store, s.id, e2)).toBe('- 1: a1\n+ 1: a2');
  });
});

/**
 * Force a `session_event_state` row back to the pre-G10 shape (NULL per-recipient
 * `diff_text`) to exercise the legacy fallback path. The store only ever WRITES
 * this column at projection time, so a regression test for the legacy migration
 * case must produce the NULL directly — done over a second raw better-sqlite3
 * connection to the same on-disk DB (WAL mode allows concurrent readers/writers).
 */
function nullOutPerRecipientDiff(
  dbPath: string,
  sessionId: string,
  eventId: string,
): void {
  const raw = new Database(dbPath);
  try {
    raw
      .prepare(
        'UPDATE session_event_state SET diff_text = NULL WHERE session_id = ? AND event_id = ?',
      )
      .run(sessionId, eventId);
  } finally {
    raw.close();
  }
}
