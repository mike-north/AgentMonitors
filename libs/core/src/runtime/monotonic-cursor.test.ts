/**
 * Per-recipient object cursors never move backward (issue #298).
 *
 * A recipient's `session_object_cursor` is its durable "last shown" baseline:
 * the next per-recipient delta spans FROM it (002 §1.1.2). Delivery surfaces
 * events out of materialization order — `high` at `turn-interruptible`,
 * `normal`/`low` at idle, a recap at `post-compact` — so a claim can include
 * only events OLDER than one an earlier claim already showed. The cursor must
 * then stay where it is: it advances only to an event later in the stable event
 * order (persisted `created_at`, then the private `monitor_events.sequence`
 * tie-break, 002 §1.1.7 "Event order and equal-time endpoints").
 *
 * A repeat claim also keeps the projection's first claim time
 * (`firstNotifiedAt`) and updates only the last-claim metadata.
 *
 * Every expected delta is written by hand from the 002 §5.2 line-diff format
 * (`- <n>: <before>` / `+ <n>: <after>`), never captured from program output.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.2 (per-recipient cursor)
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.7 (event order and equal-time endpoints)
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2 (diff format)
 * @see ../../../../docs/specs/002-runtime-delivery.md §9 (delivery lifecycles)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { buildTextDiff } from './diff.js';
import { RuntimeStore } from './store.js';
import type { Urgency as MonitorUrgency } from '../schema/types.js';
import type { MonitorEventRecord } from './types.js';

const tempDirs: string[] = [];

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
const BASE_MS = Date.UTC(2026, 0, 1);

/** A whole-second observation time `seconds` after {@link BASE_MS}. */
function at(seconds: number): Date {
  return new Date(BASE_MS + seconds * 1_000);
}

function freshDbPath(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-cursor-'));
  tempDirs.push(rootDir);
  return path.join(rootDir, 'agentmon.db');
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
 * Materialize one shared event for {@link OBJECT_KEY} the way
 * `materializeObservation` does: shared diff against the latest snapshot, then
 * the snapshot itself. Returns the event id.
 */
function materialize(
  store: RuntimeStore,
  artifact: string,
  urgency: MonitorUrgency,
  createdAt: Date,
): string {
  const previous = store.latestSnapshot(MONITOR_ID, OBJECT_KEY, WORKSPACE);
  const event = store.insertEvent(
    {
      workspacePath: WORKSPACE,
      monitorId: MONITOR_ID,
      sourceName: 'manual',
      urgency,
      title: artifact,
      body: '',
      summary: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: artifact,
      diffText: previous ? buildTextDiff(previous.content, artifact) : null,
      objectKey: OBJECT_KEY,
      queryScope: {},
      tags: [],
      createdAt,
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

/** Claim exactly `events`, collapsing `net` first, as `claimDelivery` does. */
function claim(
  store: RuntimeStore,
  sessionId: string,
  events: MonitorEventRecord[],
  lifecycle: string,
): void {
  store.collapseNetForClaim(sessionId, events);
  store.markClaimed(
    sessionId,
    events.map((event) => event.id),
    lifecycle,
  );
}

function recipientDelta(
  store: RuntimeStore,
  sessionId: string,
  eventId: string,
): string | undefined {
  return store.perRecipientDiffsForSession(sessionId, [eventId]).get(eventId);
}

function projection(store: RuntimeStore, sessionId: string, eventId: string) {
  return store
    .listDeliveryProjectionsForMonitor(MONITOR_ID, WORKSPACE)
    .find((row) => row.sessionId === sessionId && row.eventId === eventId);
}

describe('per-recipient cursors are monotonic (issue #298)', () => {
  it('high-before-normal: claiming older normal A after newer high B keeps the cursor at B', () => {
    const store = new RuntimeStore(createDb(freshDbPath()));
    const lead = openLead(store, 'sess-1');

    materialize(store, 'a0', 'normal', at(0));
    claim(store, lead, store.pendingEventsForSession(lead), 'turn-idle');

    const eventA = materialize(store, 'a1', 'normal', at(1));
    materialize(store, 'a2', 'high', at(2));

    // turn-interruptible surfaces only the newer high event B.
    claim(
      store,
      lead,
      store.pendingEventsForSession(lead, 'high'),
      'turn-interruptible',
    );
    // A later idle claim surfaces the OLDER normal event A.
    const pendingNormal = store.pendingEventsForSession(lead, 'normal');
    expect(pendingNormal.map((event) => event.id)).toEqual([eventA]);
    claim(store, lead, pendingNormal, 'turn-idle');

    // The greatest event surfaced is B (a2), so C's delta spans a2 → a3, not
    // a1 → a3 (which would replay B's change).
    const eventC = materialize(store, 'a3', 'normal', at(3));
    expect(recipientDelta(store, lead, eventC)).toBe('- 1: a2\n+ 1: a3');
  });

  it('low and recap after newer claims never move the cursor back', () => {
    const store = new RuntimeStore(createDb(freshDbPath()));
    const lead = openLead(store, 'sess-1');

    materialize(store, 'a0', 'normal', at(0));
    claim(store, lead, store.pendingEventsForSession(lead), 'turn-idle');
    store.acknowledgeEvents(
      lead,
      store.unreadEventsForSession(lead).map((event) => event.id),
    );

    const eventLow = materialize(store, 'a1', 'low', at(1));
    const eventHigh = materialize(store, 'a2', 'high', at(2));

    claim(
      store,
      lead,
      store.pendingEventsForSession(lead, 'high'),
      'turn-interruptible',
    );
    store.acknowledgeEvents(lead, [eventHigh]);

    // The low event is surfaced after the newer high claim.
    claim(store, lead, store.pendingEventsForSession(lead, 'low'), 'turn-idle');

    // A post-compact recap re-claims what is still unread: only the older low
    // event, since the high one was acknowledged.
    const recap = store.unreadEventsForSession(lead);
    expect(recap.map((event) => event.id)).toEqual([eventLow]);
    claim(store, lead, recap, 'post-compact');

    const eventC = materialize(store, 'a3', 'normal', at(3));
    expect(recipientDelta(store, lead, eventC)).toBe('- 1: a2\n+ 1: a3');
  });

  it('repeated claims keep firstNotifiedAt and update only the last-claim metadata', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(10));
    const store = new RuntimeStore(createDb(freshDbPath()));
    const lead = openLead(store, 'sess-1');

    materialize(store, 'a0', 'normal', at(0));
    const eventA = materialize(store, 'a1', 'normal', at(1));
    const eventB = materialize(store, 'a2', 'normal', at(2));

    vi.setSystemTime(at(20));
    claim(store, lead, store.pendingEventsForSession(lead), 'turn-idle');

    vi.setSystemTime(at(30));
    claim(store, lead, store.unreadEventsForSession(lead), 'post-compact');

    for (const eventId of [eventA, eventB]) {
      const row = projection(store, lead, eventId);
      expect(row?.firstNotifiedAt).toEqual(at(20));
      expect(row?.lastClaimAt).toEqual(at(30));
      expect(row?.lastClaimLifecycle).toBe('post-compact');
    }

    // A recap that re-claims only the older event A leaves the cursor at B.
    vi.setSystemTime(at(40));
    claim(
      store,
      lead,
      store.unreadEventsForSession(lead).filter((event) => event.id === eventA),
      'post-compact',
    );
    expect(projection(store, lead, eventA)?.firstNotifiedAt).toEqual(at(20));
    expect(projection(store, lead, eventA)?.lastClaimAt).toEqual(at(40));

    const eventC = materialize(store, 'a3', 'normal', at(3));
    expect(recipientDelta(store, lead, eventC)).toBe('- 1: a2\n+ 1: a3');
  });

  it('a restart between claims keeps the cursor at the greatest surfaced event', () => {
    const dbPath = freshDbPath();
    const first = new RuntimeStore(createDb(dbPath));
    const lead = openLead(first, 'sess-1');

    materialize(first, 'a0', 'normal', at(0));
    claim(first, lead, first.pendingEventsForSession(lead), 'turn-idle');
    materialize(first, 'a1', 'normal', at(1));
    materialize(first, 'a2', 'high', at(2));
    claim(
      first,
      lead,
      first.pendingEventsForSession(lead, 'high'),
      'turn-interruptible',
    );

    // Daemon restart: a fresh store over the same database file.
    const restarted = new RuntimeStore(createDb(dbPath));
    claim(
      restarted,
      lead,
      restarted.pendingEventsForSession(lead, 'normal'),
      'turn-idle',
    );

    const eventC = materialize(restarted, 'a3', 'normal', at(3));
    expect(recipientDelta(restarted, lead, eventC)).toBe('- 1: a2\n+ 1: a3');
  });

  it('same-second events order by the materialization sequence tie-break', () => {
    const store = new RuntimeStore(createDb(freshDbPath()));
    const lead = openLead(store, 'sess-1');

    materialize(store, 'a0', 'normal', at(0));
    claim(store, lead, store.pendingEventsForSession(lead), 'turn-idle');

    // A and B share one persisted second; B was materialized after A, so B is
    // later in the stable order.
    materialize(store, 'a1', 'normal', at(5));
    materialize(store, 'a2', 'high', at(5));

    claim(
      store,
      lead,
      store.pendingEventsForSession(lead, 'high'),
      'turn-interruptible',
    );
    claim(
      store,
      lead,
      store.pendingEventsForSession(lead, 'normal'),
      'turn-idle',
    );

    const eventC = materialize(store, 'a3', 'normal', at(6));
    expect(recipientDelta(store, lead, eventC)).toBe('- 1: a2\n+ 1: a3');
  });

  it('a later-materialized event with an earlier observation time is older in the stable order', () => {
    const store = new RuntimeStore(createDb(freshDbPath()));
    const lead = openLead(store, 'sess-1');

    materialize(store, 'a0', 'normal', at(0));
    claim(store, lead, store.pendingEventsForSession(lead), 'turn-idle');

    // B is observed at t=5 and committed first; A is committed afterwards but
    // observed at t=4, so A precedes B in the stable order.
    materialize(store, 'b', 'high', at(5));
    materialize(store, 'a', 'normal', at(4));

    claim(
      store,
      lead,
      store.pendingEventsForSession(lead, 'high'),
      'turn-interruptible',
    );
    claim(
      store,
      lead,
      store.pendingEventsForSession(lead, 'normal'),
      'turn-idle',
    );

    const eventC = materialize(store, 'c', 'normal', at(6));
    expect(recipientDelta(store, lead, eventC)).toBe('- 1: b\n+ 1: c');
  });
});
