/**
 * Persisted observation time remains the primary event order. Equal-time events
 * use committed insertion order across processes for delivery, net endpoints
 * and cursor advancement, without exposing private ordering metadata.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { decodeTime } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore, computeNetCollapseView } from './store.js';
import { AgentMonitorRuntime } from './service.js';
import type { MonitorEventRecord } from './types.js';

const roots: string[] = [];
const connections: Database.Database[] = [];
const epoch = Date.parse('2026-11-01T12:00:00.000Z');
const childPath = fileURLToPath(
  new URL('./test-fixtures/event-writer.mjs', import.meta.url),
);

/** Own every probe database so failed assertions cannot leak open file handles. */
function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'event-materialization-'));
  roots.push(root);
  return path.join(root, 'agentmon.db');
}

function open(dbPath: string) {
  const db = createDb(dbPath);
  // InboxDb intentionally hides the native client from the public package API.
  const client = (db as unknown as { $client: Database.Database }).$client;
  connections.push(client);
  return { store: new RuntimeStore(db), client };
}

/** A child response is evidence only after its explicit durable commit barrier. */
function message(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => {
      reject(
        new Error(`Event child exited before its response: ${String(code)}`),
      );
    };
    child.once('exit', onExit);
    child.once('error', reject);
    child.once('message', (value: unknown) => {
      child.off('exit', onExit);
      child.off('error', reject);
      if (typeof value !== 'object' || value === null) {
        reject(new Error('Invalid event child response'));
        return;
      }
      resolve(value as Record<string, unknown>);
    });
  });
}

function writer(dbPath: string) {
  const child = fork(childPath, [dbPath, 'write', String(epoch)], {
    execArgv: [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
    ],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
  return { child, ready: message(child), exited: once(child, 'exit') };
}

afterEach(() => {
  vi.useRealTimers();
  for (const client of connections.splice(0)) {
    if (client.open) client.close();
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Each recipient is durable and projected by the child writers, not by test SQL. */
function lead(store: RuntimeStore, identity: string) {
  return store.openSession({
    adapter: 'claude-code',
    hostSessionId: identity,
    agentIdentity: identity,
    role: 'lead',
    workspacePath: '/workspace',
    hookStatePath: path.join(roots[roots.length - 1] ?? '', `${identity}.json`),
  }).id;
}

function eventInput(
  content: string,
  observedAt: number,
  urgency: 'high' | 'normal' = 'high',
  objectKey = 'object',
): Omit<MonitorEventRecord, 'id'> {
  return {
    workspacePath: '/workspace',
    monitorId: 'monitor',
    sourceName: 'manual',
    urgency,
    title: content,
    body: '',
    summary: content,
    payload: {},
    snapshotMetadata: {},
    snapshotText: content,
    diffText: null,
    objectKey,
    baselineStrategy: 'net',
    queryScope: {},
    tags: [],
    createdAt: new Date(observedAt),
  };
}

/** Choose adverse real ULID order without replacing any generated identity. */
async function commitPair(dbPath: string): Promise<string[]> {
  const workers = [writer(dbPath), writer(dbPath)];
  try {
    const ready = await Promise.all(workers.map((worker) => worker.ready));
    const order = String(ready[0]?.id) > String(ready[1]?.id) ? [0, 1] : [1, 0];
    const ids: string[] = [];
    for (const [position, index] of order.entries()) {
      const worker = workers[index];
      if (!worker) throw new Error('Missing event writer');
      const committed = message(worker.child);
      worker.child.send({ content: position === 0 ? 'A' : 'B' });
      const result = await committed;
      expect(result.kind).toBe('committed');
      ids.push(String(result.id));
      expect(await worker.exited).toEqual([0, null]);
    }
    const [first, second] = ids;
    if (!first || !second) throw new Error('Missing event identities');
    expect(ids.map(decodeTime)).toEqual([epoch, epoch]);
    expect(first > second).toBe(true);
    return ids;
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill('SIGKILL');
    }
    await Promise.allSettled(workers.map((worker) => worker.exited));
  }
}

/** Exact pre-sequence event shape, with its logical references left in place. */
function restoreLegacyEvents(client: Database.Database): void {
  client.exec(`
    CREATE TABLE legacy_events (
      id TEXT PRIMARY KEY, workspace_path TEXT, monitor_id TEXT NOT NULL,
      source_name TEXT NOT NULL, urgency TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}', snapshot_metadata TEXT NOT NULL DEFAULT '{}',
      snapshot_text TEXT, diff_text TEXT, object_key TEXT, baseline_strategy TEXT,
      query_scope TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    INSERT INTO legacy_events SELECT id, workspace_path, monitor_id, source_name,
      urgency, title, body, summary, payload, snapshot_metadata, snapshot_text,
      diff_text, object_key, baseline_strategy, query_scope, tags, created_at
      FROM monitor_events ORDER BY rowid;
    DROP TABLE monitor_events;
    ALTER TABLE legacy_events RENAME TO monitor_events;
    CREATE INDEX legacy_event_object ON monitor_events(monitor_id, object_key);
    CREATE TABLE event_insert_audit (title TEXT NOT NULL);
    CREATE TRIGGER legacy_event_audit AFTER INSERT ON monitor_events
      BEGIN INSERT INTO event_insert_audit VALUES (NEW.title); END;
  `);
}

describe('durable equal-time event order', () => {
  it('aligns real-process query order, preview, capped claim, suppression and cursor', async () => {
    const dbPath = databasePath();
    const { store } = open(dbPath);
    const session = lead(store, 'lead');
    const ids = await commitPair(dbPath);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(epoch + 60_000);
    const laterGroup = store.insertEvent(
      eventInput('other', epoch, 'high', 'other-object'),
    );
    // Read through a separately opened store so no process-local event metadata
    // can explain either the query order or the chosen endpoint.
    const reader = open(dbPath);
    const candidates = reader.store.pendingEventsForSession(session);
    expect(candidates.map((event) => event.id)).toEqual([
      ...ids,
      laterGroup.id,
    ]);
    expect(
      reader.store.unreadEventsForSession(session).map((event) => event.id),
    ).toEqual([...ids, laterGroup.id]);
    expect(reader.store.listEvents().map((event) => event.id)).toEqual([
      laterGroup.id,
      ...ids.toReversed(),
    ]);
    expect(
      computeNetCollapseView(candidates).delivered.map((event) => event.title),
    ).toEqual(['B', 'other']);
    const runtime = new AgentMonitorRuntime(
      reader.store,
      new SourceRegistry(),
      [claudeCodeAdapter],
    );
    expect(
      runtime.previewSettledHighDelivery(session).map((event) => event.eventId),
    ).toEqual([ids[1], laterGroup.id]);
    const claim = runtime.claimDelivery(session, 'turn-interruptible', 1);
    expect(claim?.events.map((event) => event.eventId)).toEqual([ids[1]]);
    expect(
      reader.store.getSessionObjectCursor(
        session,
        'monitor',
        'object',
        '/workspace',
      )?.baselineContent,
    ).toBe('B');
    expect(
      reader.store.pendingEventsForSession(session).map((event) => event.id),
    ).toEqual([laterGroup.id]);
    expect(
      runtime.previewSettledHighDelivery(session).map((event) => event.eventId),
    ).toEqual([laterGroup.id]);
    // The private ordering field must not escape through public records.
    expect(
      Object.keys(reader.store.getEventById(ids[1] ?? 'missing')),
    ).not.toContain('sequence');
  }, 30_000);

  it('canonicalizes mixed-band or reversed claim arrays without changing preview endpoints', () => {
    const { store } = open(databasePath());
    const session = lead(store, 'coalesced');
    const appliedSession = lead(store, 'coalesced-apply');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(epoch + 60_000);
    const normal = store.insertEvent(eventInput('normal-old', epoch, 'normal'));
    const high = store.insertEvent(eventInput('high-new', epoch));
    const runtime = new AgentMonitorRuntime(store, new SourceRegistry(), [
      claudeCodeAdapter,
    ]);
    expect(
      runtime.previewSettledHighDelivery(session).map((event) => event.eventId),
    ).toEqual([high.id]);
    const applied = runtime.claimDelivery(appliedSession, 'turn-interruptible');
    expect(applied?.events.map((event) => event.eventId)).toEqual([high.id]);
    expect(
      store.getSessionObjectCursor(
        appliedSession,
        'monitor',
        'object',
        '/workspace',
      )?.baselineContent,
    ).toBe('high-new');
    expect(store.pendingEventsForSession(appliedSession)).toEqual([]);
    // High+normal coalescing constructs this order; normal must not become the
    // endpoint merely because its band is concatenated last.
    expect(
      store
        .collapseNetForClaim(session, [high, normal])
        .map((event) => event.id),
    ).toEqual([high.id]);
    store.markClaimed(session, [high.id, normal.id], 'turn-interruptible');
    expect(
      store.getSessionObjectCursor(session, 'monitor', 'object', '/workspace')
        ?.baselineContent,
    ).toBe('high-new');
  });

  it('preserves persisted observed-time priority when insertion order disagrees', () => {
    const { store } = open(databasePath());
    const session = lead(store, 'observed-time');
    const first = store.insertEvent(
      eventInput('newer-observation', epoch + 10_000),
    );
    const second = store.insertEvent(eventInput('older-observation', epoch));
    const candidates = store.pendingEventsForSession(session);
    expect(candidates.map((event) => event.id)).toEqual([second.id, first.id]);
    expect(
      computeNetCollapseView(candidates).delivered.map((event) => event.id),
    ).toEqual([first.id]);
    expect(
      store
        .collapseNetForClaim(session, [first, second])
        .map((event) => event.id),
    ).toEqual([first.id]);
    store.markClaimed(session, [first.id, second.id], 'turn-interruptible');
    expect(
      store.getSessionObjectCursor(session, 'monitor', 'object', '/workspace')
        ?.baselineContent,
    ).toBe('newer-observation');
  });

  it('does not let rolled-back materialization acquire a durable event position', () => {
    const { store, client } = open(databasePath());
    const first = store.insertEvent(eventInput('A', epoch));
    expect(() =>
      client
        .transaction(() => {
          store.insertEvent(eventInput('B', epoch));
          throw new Error('abort event');
        })
        .immediate(),
    ).toThrow('abort event');
    const next = store.insertEvent(eventInput('C', epoch));
    expect(store.listEvents().map((event) => event.id)).toEqual([
      next.id,
      first.id,
    ]);
    expect(
      client
        .prepare('SELECT title FROM monitor_events ORDER BY sequence')
        .all(),
    ).toEqual([{ title: 'A' }, { title: 'C' }]);
    expect(store.latestSnapshot('monitor', 'object', '/workspace')).toEqual({
      content: 'C',
    });
  });
  it('rejects unknown or duplicate candidate identities before any claim mutation', () => {
    const { store } = open(databasePath());
    const session = lead(store, 'invalid');
    const event = store.insertEvent(eventInput('A', epoch));
    expect(() => store.collapseNetForClaim(session, [event, event])).toThrow(
      'Duplicate event',
    );
    expect(() =>
      store.collapseNetForClaim(session, [{ ...event, id: 'missing' }]),
    ).toThrow('Event not found');
    expect(
      store.pendingEventsForSession(session).map((item) => item.id),
    ).toEqual([event.id]);
  });

  it('uses persisted candidate artifacts instead of caller-modified fields', () => {
    const { store } = open(databasePath());
    const session = lead(store, 'authoritative');
    const first = store.insertEvent(eventInput('A', epoch));
    const last = store.insertEvent(eventInput('B', epoch));
    const result = store.collapseNetForClaim(session, [
      first,
      { ...last, snapshotText: 'forged', title: 'forged' },
    ]);
    expect(result.map((event) => event.title)).toEqual(['B']);
    expect(
      store.perRecipientDiffsForSession(session, [last.id]).get(last.id),
    ).toBe('- 1: A\n+ 1: B');
  });

  it('preserves legacy IDs, projections, snapshots and cursors through migration and maintenance', () => {
    const dbPath = databasePath();
    const { store, client } = open(dbPath);
    const session = lead(store, 'migrated');
    const first = store.insertEvent(eventInput('A', epoch));
    const last = store.insertEvent(eventInput('B', epoch));
    store.markClaimed(session, [first.id], 'turn-interruptible');
    restoreLegacyEvents(client);
    const originalRows = client
      .prepare('SELECT * FROM monitor_events ORDER BY rowid')
      .all();
    const projections = client
      .prepare('SELECT * FROM session_event_state ORDER BY id')
      .all();
    const snapshots = client
      .prepare('SELECT * FROM monitor_snapshots ORDER BY sequence')
      .all();
    const cursors = client
      .prepare('SELECT * FROM session_object_cursor ORDER BY id')
      .all();
    const objects = client
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name IN ('legacy_event_object', 'legacy_event_audit') ORDER BY name",
      )
      .all();
    client.close();
    const migrated = open(dbPath);
    const migratedRows = migrated.client
      .prepare('SELECT * FROM monitor_events ORDER BY sequence')
      .all() as Record<string, unknown>[];
    expect(migratedRows.map(({ sequence: _sequence, ...row }) => row)).toEqual(
      originalRows,
    );
    expect(
      migrated.client
        .prepare('SELECT * FROM session_event_state ORDER BY id')
        .all(),
    ).toEqual(projections);
    expect(
      migrated.client
        .prepare('SELECT * FROM monitor_snapshots ORDER BY sequence')
        .all(),
    ).toEqual(snapshots);
    expect(
      migrated.client
        .prepare('SELECT * FROM session_object_cursor ORDER BY id')
        .all(),
    ).toEqual(cursors);
    expect(
      migrated.client
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name IN ('legacy_event_object', 'legacy_event_audit') ORDER BY name",
        )
        .all(),
    ).toEqual(objects);
    expect(migrated.client.pragma('foreign_key_list(monitor_events)')).toEqual(
      [],
    );
    expect(migrated.client.pragma('foreign_key_check')).toEqual([]);
    expect(
      migrated.client.prepare('SELECT * FROM event_insert_audit').all(),
    ).toEqual([]);
    migrated.client.exec('VACUUM');
    migrated.client.close();
    const reopened = open(dbPath);
    expect(
      reopened.client
        .prepare('SELECT * FROM monitor_events ORDER BY sequence')
        .all(),
    ).toEqual(migratedRows);
    expect(
      reopened.store.pendingEventsForSession(session).map((event) => event.id),
    ).toEqual([last.id]);
    reopened.client
      .prepare('DELETE FROM monitor_events WHERE id = ?')
      .run(last.id);
    const next = reopened.store.insertEvent(eventInput('C', epoch));
    const nextRow = reopened.client
      .prepare('SELECT sequence FROM monitor_events WHERE id = ?')
      .get(next.id) as { sequence: number };
    expect(nextRow.sequence).toBeGreaterThan(Number(migratedRows[1]?.sequence));
    expect(
      reopened.client.prepare('SELECT * FROM event_insert_audit').all(),
    ).toEqual([{ title: 'C' }]);
  });
  it('serializes concurrent legacy-event migration and writer allocation', async () => {
    const dbPath = databasePath();
    const { store, client } = open(dbPath);
    const baseline = store.insertEvent(eventInput('baseline', epoch));
    restoreLegacyEvents(client);
    client.close();
    const workers = [writer(dbPath), writer(dbPath)];
    try {
      await Promise.all(workers.map((worker) => worker.ready));
      const results = workers.map((worker, index) => {
        const committed = message(worker.child);
        worker.child.send({ content: `child-${String(index)}` });
        return committed;
      });
      await Promise.all(results);
      expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual(
        [
          [0, null],
          [0, null],
        ],
      );
      const reader = open(dbPath);
      expect(
        reader.client
          .prepare(
            'SELECT COUNT(*) AS count, COUNT(DISTINCT sequence) AS positions FROM monitor_events',
          )
          .get(),
      ).toEqual({ count: 3, positions: 3 });
      expect(reader.store.getEventById(baseline.id).title).toBe('baseline');
      expect(
        reader.client
          .prepare('SELECT title FROM event_insert_audit ORDER BY title')
          .all(),
      ).toEqual([{ title: 'child-0' }, { title: 'child-1' }]);
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill('SIGKILL');
      }
      await Promise.allSettled(workers.map((worker) => worker.exited));
    }
  }, 30_000);
});
