/**
 * Regression tests for issue #293: snapshots written within one epoch-SECOND
 * must retain a total materialization order so `latestSnapshot()` returns the
 * NEWEST snapshot (the correct diff predecessor), not an arbitrary/older row.
 *
 * `monitor_snapshots.created_at` is stored at second precision, so several
 * snapshots for one `(workspace, monitor, object)` saved in immediate
 * succession all tie on `created_at`. Before the fix `latestSnapshot()` ordered
 * ONLY by `created_at DESC` and could return the OLDEST tied snapshot, which
 * corrupts the shared diff chain (`v1, v2, v3` returned `v1` as "latest"). The
 * fix mirrors the `monitor_events` precedent: a monotonic ULID `id` establishes
 * insertion order and `latestSnapshot()` breaks ties with `id DESC`.
 *
 * The clock is frozen (`vi.useFakeTimers`) so `saveSnapshot`'s internal
 * `new Date()` — and the event `created_at` passed here — all land in the same
 * second, reproducing the tie deterministically. Expected diff strings are
 * written BY HAND from the `buildTextDiff` format spec (002 §5.2: line-level
 * `- <n>: <before>` / `+ <n>: <after>`), never captured from program output.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2 (snapshot ordering & diff format)
 * @see ../../../../docs/specs/002-runtime-delivery.md §15 (monitor_snapshots schema)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { buildTextDiff } from './diff.js';
import { RuntimeStore } from './store.js';

const tempDirs: string[] = [];

/** A single instant; every write in a test lands in THIS second (the tie). */
const FROZEN = new Date('2026-07-16T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN);
});

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const MONITOR_ID = 'watcher';
const OBJECT_KEY = 'obj-1';
const WORKSPACE = '/ws';

function freshStore(): RuntimeStore {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-snaptie-'));
  tempDirs.push(rootDir);
  return new RuntimeStore(createDb(path.join(rootDir, 'agentmon.db')));
}

/**
 * Materialize ONE shared event carrying `artifact`, exactly as
 * `processObservation` does: read the latest stored snapshot, diff against it
 * for the shared `monitor_events.diff_text`, `insertEvent`, then persist the new
 * snapshot. Returns the new event id and the predecessor content that
 * `latestSnapshot()` resolved to (the diff base). All timestamps come from the
 * frozen clock, so successive calls tie on `created_at`.
 */
function materialize(
  store: RuntimeStore,
  artifact: string,
): { eventId: string; predecessor: string | null } {
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
      baselineStrategy: 'incremental',
      queryScope: {},
      tags: [],
      createdAt: new Date(),
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
  return { eventId: event.id, predecessor: previous?.content ?? null };
}

describe('snapshot tie ordering (issue #293)', () => {
  it('latestSnapshot returns the newest of snapshots saved in the same second', () => {
    // Criterion 1 (total materialization order) + 2 (latestSnapshot picks the
    // newest under identical timestamps). Save three snapshots directly, back to
    // back under the frozen clock, so all three share one second.
    const store = freshStore();
    for (const [i, content] of ['a1', 'a2', 'a3'].entries()) {
      store.saveSnapshot({
        workspacePath: WORKSPACE,
        monitorId: MONITOR_ID,
        objectKey: OBJECT_KEY,
        eventId: `evt-${String(i)}`,
        content,
      });
    }
    expect(store.latestSnapshot(MONITOR_ID, OBJECT_KEY, WORKSPACE)).toEqual({
      content: 'a3',
    });
  });

  it('a1->a2->a3 within one second keeps adjacent diffs a1->a2 then a2->a3', () => {
    // Criterion 3 (frozen-clock diff-chain regression). Pre-fix, materializing
    // a3 read an OLDER snapshot as "latest", so the chain diffed a1->a3 instead
    // of a2->a3. Each expected diff is one changed line 1 (002 §5.2 format).
    const store = freshStore();

    const first = materialize(store, 'a1');
    expect(first.predecessor).toBeNull(); // baseline: nothing to diff against

    const second = materialize(store, 'a2');
    expect(second.predecessor).toBe('a1');
    expect(store.getEventById(second.eventId).diffText).toBe(
      '- 1: a1\n+ 1: a2',
    );

    const third = materialize(store, 'a3');
    // The regression: the predecessor MUST be a2 (the newest tied snapshot).
    expect(third.predecessor).toBe('a2');
    expect(store.getEventById(third.eventId).diffText).toBe('- 1: a2\n+ 1: a3');

    // And the final "latest" is a3, not a stale earlier version.
    expect(store.latestSnapshot(MONITOR_ID, OBJECT_KEY, WORKSPACE)).toEqual({
      content: 'a3',
    });
  });

  it('observation-history audit lists same-second rows newest-first (issue #293 criterion 4)', () => {
    // The audit trail (`monitor explain`) is ordered newest-first by
    // second-precision `created_at`; rows recorded in one second must still
    // surface in a stable, materialization-reverse order via the monotonic id.
    const store = freshStore();
    for (const seq of [0, 1, 2]) {
      store.recordObservationHistory({
        monitorId: MONITOR_ID,
        workspacePath: WORKSPACE,
        sourceName: 'manual',
        result: 'triggered',
        observationData: { seq },
      });
    }
    const rows = store.listObservationHistory({
      monitorId: MONITOR_ID,
      workspacePath: WORKSPACE,
    });
    // Newest-first: the last-recorded row (seq 2) leads.
    expect(rows.map((row) => row.observationData['seq'])).toEqual([2, 1, 0]);
  });

  it('event list orders same-second events newest-first (issue #293 criterion 4)', () => {
    // `events list` / `monitor explain` list newest-first by second-precision
    // `created_at`; same-tick events must order by the monotonic event id.
    const store = freshStore();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const event = store.insertEvent({
        workspacePath: WORKSPACE,
        monitorId: MONITOR_ID,
        sourceName: 'manual',
        urgency: 'normal',
        title: `e${String(n)}`,
        body: '',
        summary: '',
        payload: {},
        snapshotMetadata: {},
        snapshotText: null,
        diffText: null,
        objectKey: OBJECT_KEY,
        baselineStrategy: 'incremental',
        queryScope: {},
        tags: [],
        createdAt: new Date(),
      });
      ids.push(event.id);
    }
    const listed = store.listEvents({
      monitorId: MONITOR_ID,
      workspacePath: WORKSPACE,
    });
    // Newest-first: reverse of insertion order.
    expect(listed.map((event) => event.id)).toEqual([...ids].reverse());
  });

  it('survives a daemon restart: latest is still the newest same-second snapshot', () => {
    // Durability (BP1): the ordering must not depend on in-memory insertion
    // state — a brand-new store over the SAME on-disk DB still resolves a3.
    const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-snaptie-'));
    tempDirs.push(rootDir);
    const dbPath = path.join(rootDir, 'agentmon.db');
    const store = new RuntimeStore(createDb(dbPath));
    materialize(store, 'a1');
    materialize(store, 'a2');
    materialize(store, 'a3');

    const restarted = new RuntimeStore(createDb(dbPath));
    expect(restarted.latestSnapshot(MONITOR_ID, OBJECT_KEY, WORKSPACE)).toEqual(
      {
        content: 'a3',
      },
    );
  });
});
