/**
 * Snapshot predecessors follow committed materialization order, across process
 * factories, clock reversals and database maintenance. These tests deliberately
 * separate durable ordering from public ULID identity and observation clocks.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { decodeTime } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { buildTextDiff } from './diff.js';
import { RuntimeStore } from './store.js';

const roots: string[] = [];
const connections: Database.Database[] = [];
const epoch = Date.parse('2026-11-01T12:00:00.000Z');
const childPath = fileURLToPath(
  new URL('./test-fixtures/snapshot-writer.mjs', import.meta.url),
);

/** Own every probe database so failed assertions cannot leak open file handles. */
function databasePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'snapshot-materialization-'));
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

function save(store: RuntimeStore, content: string): void {
  store.saveSnapshot({
    workspacePath: '/workspace',
    monitorId: 'monitor',
    objectKey: 'object',
    eventId: `event-${content}`,
    content,
  });
}

function latest(store: RuntimeStore) {
  return store.latestSnapshot('monitor', 'object', '/workspace');
}

/** A child response is evidence only after its explicit durable commit barrier. */
function message(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => {
      reject(
        new Error(`Snapshot child exited before its response: ${String(code)}`),
      );
    };
    child.once('exit', onExit);
    child.once('error', reject);
    child.once('message', (value: unknown) => {
      child.off('exit', onExit);
      child.off('error', reject);
      if (typeof value !== 'object' || value === null) {
        reject(new Error('Invalid snapshot child response'));
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

function legacyDatabase(dbPath: string): void {
  const legacy = new Database(dbPath);
  try {
    legacy.pragma('journal_mode = WAL');
    legacy.exec(`
      CREATE TABLE monitor_snapshots (
        id TEXT PRIMARY KEY, workspace_path TEXT, monitor_id TEXT NOT NULL,
        object_key TEXT NOT NULL, event_id TEXT NOT NULL, content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO monitor_snapshots VALUES
        ('01M6BFP5G0ZZZZZZZZZZZZZZZZ', '/workspace', 'monitor', 'object', 'event-A', 'A', 1793534400),
        ('01M6BFP5G00000000000000000', '/workspace', 'monitor', 'object', 'event-B', 'B', 1793534400);
    `);
  } finally {
    legacy.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const client of connections.splice(0)) {
    if (client.open) client.close();
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('durable snapshot materialization order', () => {
  it('selects the last actual process commit despite adverse genuine ULID order', async () => {
    const dbPath = databasePath();
    const reader = open(dbPath);
    const writers = [writer(dbPath), writer(dbPath)];
    try {
      const ready = await Promise.all(writers.map((item) => item.ready));
      for (const item of ready) {
        expect(item.kind).toBe('ready');
        expect(String(item.id)).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        expect(decodeTime(String(item.id))).toBe(epoch);
      }
      const highFirst =
        String(ready[0]?.id) > String(ready[1]?.id) ? [0, 1] : [1, 0];
      const actualIds: string[] = [];
      for (const [position, index] of highFirst.entries()) {
        const worker = writers[index];
        if (!worker) throw new Error('Missing owned writer');
        const committed = message(worker.child);
        worker.child.send({ content: position === 0 ? 'A' : 'B' });
        const result = await committed;
        expect(result.kind).toBe('committed');
        expect(result.before).toEqual(position === 0 ? null : { content: 'A' });
        actualIds.push(String(result.id));
        expect(await worker.exited).toEqual([0, null]);
      }
      // Both IDs are generated by the real snapshot factory; the parent only
      // chooses which process commits first. A timestamp/id reader chooses A.
      expect(actualIds.map(decodeTime)).toEqual([epoch, epoch]);
      const [firstId, secondId] = actualIds;
      if (!firstId || !secondId)
        throw new Error('Missing committed snapshot IDs');
      expect(firstId > secondId).toBe(true);
      expect(latest(reader.store)).toEqual({ content: 'B' });
      const freshReader = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--experimental-transform-types',
            '--disable-warning=ExperimentalWarning',
            childPath,
            dbPath,
            'read',
            String(epoch),
          ],
          { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 },
        ),
      );
      expect(freshReader).toEqual({ content: 'B' });
      expect(buildTextDiff(freshReader.content, 'C')).toBe('- 1: B\n+ 1: C');
    } finally {
      for (const worker of writers) {
        if (
          worker.child.exitCode === null &&
          worker.child.signalCode === null
        ) {
          worker.child.kill('SIGKILL');
        }
      }
      await Promise.allSettled(writers.map((worker) => worker.exited));
    }
  }, 30_000);

  it('uses materialization order when the wall clock moves backwards', () => {
    const { store } = open(databasePath());
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    save(store, 'A');
    vi.setSystemTime(epoch - 60_000);
    save(store, 'B');
    expect(latest(store)).toEqual({ content: 'B' });
  });

  it('preserves order and public identity through deletion, VACUUM and reopen', () => {
    const dbPath = databasePath();
    const { store, client } = open(dbPath);
    save(store, 'A');
    save(store, 'B');
    const before = client
      .prepare('SELECT id, sequence FROM monitor_snapshots WHERE content = ?')
      .get('B') as { id: string; sequence: number };
    client.prepare('DELETE FROM monitor_snapshots WHERE content = ?').run('B');
    expect(latest(store)).toEqual({ content: 'A' });
    save(store, 'C');
    const after = client
      .prepare('SELECT id, sequence FROM monitor_snapshots WHERE content = ?')
      .get('C') as { id: string; sequence: number };
    expect(after.sequence).toBeGreaterThan(before.sequence);
    expect(after.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    client.exec('VACUUM');
    client.close();
    const reopened = open(dbPath);
    expect(latest(reopened.store)).toEqual({ content: 'C' });
    expect(
      reopened.client
        .prepare('SELECT id, sequence FROM monitor_snapshots WHERE content = ?')
        .get('C'),
    ).toEqual(after);
    reopened.client.exec('DELETE FROM monitor_snapshots');
    expect(latest(reopened.store)).toBeNull();
    save(reopened.store, 'D');
    const next = reopened.client
      .prepare('SELECT sequence FROM monitor_snapshots')
      .get() as { sequence: number };
    expect(next.sequence).toBeGreaterThan(after.sequence);
    expect(latest(reopened.store)).toEqual({ content: 'D' });
  });

  it('does not advance the predecessor for failed or rolled-back writes', () => {
    const { store, client } = open(databasePath());
    save(store, 'A');
    expect(() =>
      client
        .transaction(() => {
          save(store, 'B');
          throw new Error('abort outer transaction');
        })
        .immediate(),
    ).toThrow('abort outer transaction');
    expect(latest(store)).toEqual({ content: 'A' });
    client.exec(
      "CREATE TRIGGER reject_snapshot BEFORE INSERT ON monitor_snapshots WHEN NEW.content = 'C' BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END",
    );
    expect(() => save(store, 'C')).toThrow('snapshot failure');
    expect(latest(store)).toEqual({ content: 'A' });
    save(store, 'D');
    expect(latest(store)).toEqual({ content: 'D' });
    expect(
      client
        .prepare('SELECT content FROM monitor_snapshots ORDER BY sequence')
        .all(),
    ).toEqual([{ content: 'A' }, { content: 'D' }]);
  });

  it('bootstraps retained legacy rows by current rowid without changing their data', () => {
    const dbPath = databasePath();
    legacyDatabase(dbPath);
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE INDEX legacy_snapshot_object ON monitor_snapshots(monitor_id, object_key);
      CREATE TABLE snapshot_insert_audit (content TEXT NOT NULL);
      CREATE TRIGGER legacy_snapshot_audit AFTER INSERT ON monitor_snapshots
        BEGIN INSERT INTO snapshot_insert_audit VALUES (NEW.content); END;
    `);
    const rows = legacy
      .prepare('SELECT * FROM monitor_snapshots ORDER BY rowid')
      .all();
    const objects = legacy
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name IN ('legacy_snapshot_object', 'legacy_snapshot_audit') ORDER BY name",
      )
      .all();
    legacy.close();
    const first = open(dbPath);
    expect(latest(first.store)).toEqual({ content: 'B' });
    expect(
      first.client
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name IN ('legacy_snapshot_object', 'legacy_snapshot_audit') ORDER BY name",
        )
        .all(),
    ).toEqual(objects);
    expect(first.client.pragma('foreign_key_list(monitor_snapshots)')).toEqual(
      [],
    );
    expect(first.client.pragma('foreign_key_check')).toEqual([]);
    expect(
      first.client.prepare('SELECT * FROM snapshot_insert_audit').all(),
    ).toEqual([]);
    expect(
      first.client
        .prepare(
          'SELECT id, workspace_path, monitor_id, object_key, event_id, content, created_at FROM monitor_snapshots ORDER BY sequence',
        )
        .all(),
    ).toEqual(rows);
    first.client.close();
    const second = open(dbPath);
    expect(latest(second.store)).toEqual({ content: 'B' });
    expect(
      second.client
        .prepare('SELECT sequence FROM monitor_snapshots ORDER BY sequence')
        .all(),
    ).toEqual([{ sequence: 1 }, { sequence: 2 }]);
    expect(() =>
      second.client
        .prepare(
          'INSERT INTO monitor_snapshots (id, workspace_path, monitor_id, object_key, event_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          '01M6BFP5G0ZZZZZZZZZZZZZZZZ',
          '/workspace',
          'monitor',
          'object',
          'duplicate',
          'duplicate',
          1,
        ),
    ).toThrow();
    save(second.store, 'C');
    expect(latest(second.store)).toEqual({ content: 'C' });
    expect(
      second.client.prepare('SELECT * FROM snapshot_insert_audit').all(),
    ).toEqual([{ content: 'C' }]);
  });

  it('serializes simultaneous first-open migration without losing legacy rows', async () => {
    const dbPath = databasePath();
    legacyDatabase(dbPath);
    const workers = [writer(dbPath), writer(dbPath)];
    try {
      await Promise.all(workers.map((worker) => worker.ready));
      const results = workers.map((worker, index) => {
        const committed = message(worker.child);
        worker.child.send({ content: `child-${String(index)}` });
        return committed;
      });
      await Promise.all(results);
      await Promise.all(workers.map((worker) => worker.exited));
      const { client } = open(dbPath);
      expect(
        client
          .prepare(
            'SELECT COUNT(*) AS count, COUNT(DISTINCT sequence) AS distinctCount FROM monitor_snapshots',
          )
          .get(),
      ).toEqual({ count: 4, distinctCount: 4 });
      expect(
        client
          .prepare(
            "SELECT id FROM monitor_snapshots WHERE content IN ('A', 'B') ORDER BY sequence",
          )
          .all(),
      ).toEqual([
        { id: '01M6BFP5G0ZZZZZZZZZZZZZZZZ' },
        { id: '01M6BFP5G00000000000000000' },
      ]);
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill('SIGKILL');
      }
      await Promise.allSettled(workers.map((worker) => worker.exited));
    }
  }, 30_000);
});
