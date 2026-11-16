import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { RuntimeStore } from '../runtime/store.js';

const NOW = new Date('2026-08-13T18:00:00.000Z');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentmon-ingress-schema-'));
  tempDirs.push(dir);
  return path.join(dir, 'agentmon.db');
}

function receiptValues(overrides: Record<string, unknown> = {}) {
  return {
    id: 'receipt-1',
    workspace_identity: '/workspace-a',
    monitor_id: 'build-health',
    source: 'build-system',
    upstream_event_id: 'delivery-1',
    semantic_hash: 'hash-1',
    object_id: 'build-1',
    object_sequence: 1,
    event_kind: 'build.updated',
    change_kind: 'modified',
    occurred_at: '2026-08-13T18:00:00Z',
    outcome: 'held',
    event_ids: '[]',
    accepted_at: NOW.getTime(),
    updated_at: NOW.getTime(),
    ...overrides,
  };
}

function insertReceipt(
  sqlite: Database.Database,
  values: Record<string, unknown>,
) {
  sqlite
    .prepare(
      `INSERT INTO external_event_receipts (
        id, workspace_identity, monitor_id, source, upstream_event_id,
        semantic_hash, object_id, object_sequence, event_kind, change_kind,
        occurred_at, outcome, event_ids, accepted_at, updated_at
      ) VALUES (
        @id, @workspace_identity, @monitor_id, @source, @upstream_event_id,
        @semantic_hash, @object_id, @object_sequence, @event_kind, @change_kind,
        @occurred_at, @outcome, @event_ids, @accepted_at, @updated_at
      )`,
    )
    .run(values);
}

describe('external ingress storage schema', () => {
  it('recreates additive tables and indexes without losing existing rows', () => {
    const dbPath = scratchDb();
    const first = new RuntimeStore(createDb(dbPath));
    const session = first.openSession({
      adapter: 'test',
      hostSessionId: 'host-session',
      agentIdentity: 'agent',
      workspacePath: '/workspace-a',
      hookStatePath: '/tmp/hook-state.json',
    });
    const event = first.insertEvent({
      workspacePath: '/workspace-a',
      monitorId: 'existing-monitor',
      sourceName: 'existing-source',
      urgency: 'normal',
      title: 'Existing event',
      body: '',
      summary: 'Preserve me',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: null,
      baselineStrategy: null,
      queryScope: {},
      tags: [],
      createdAt: NOW,
    });

    const before = new Database(dbPath);
    before.exec(`
      DROP TABLE external_event_receipts;
      DROP TABLE external_object_sequences;
      DROP TABLE database_compatibility_markers;
    `);
    before.close();

    const migrated = new RuntimeStore(createDb(dbPath));
    expect(migrated.listSessions().map((row) => row.id)).toContain(session.id);
    expect(migrated.listEvents().map((row) => row.id)).toContain(event.id);

    const sqlite = new Database(dbPath);
    const tables = (
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'external_%'
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual([
      'external_event_receipts',
      'external_object_sequences',
    ]);

    insertReceipt(sqlite, receiptValues());
    expect(() =>
      insertReceipt(sqlite, receiptValues({ id: 'same-receipt-key' })),
    ).toThrow(/UNIQUE/);
    for (const [field, value] of [
      ['workspace_identity', '/workspace-b'],
      ['monitor_id', 'other-monitor'],
      ['source', 'other-source'],
      ['upstream_event_id', 'delivery-2'],
    ] as const) {
      insertReceipt(
        sqlite,
        receiptValues({ id: `receipt-${field}`, [field]: value }),
      );
    }
    expect(
      sqlite
        .prepare('SELECT count(*) AS count FROM external_event_receipts')
        .get(),
    ).toEqual({ count: 5 });
    sqlite.close();
  });

  it('keys object sequences by workspace, monitor, source, and object', () => {
    const dbPath = scratchDb();
    createDb(dbPath);
    const sqlite = new Database(dbPath);
    const insert = sqlite.prepare(
      `INSERT INTO external_object_sequences (
        id, workspace_identity, monitor_id, source, object_id,
        highest_sequence, receipt_id, upstream_event_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const base = [
      'sequence-1',
      '/workspace-a',
      'build-health',
      'build-system',
      'build-1',
      1,
      'receipt-1',
      'delivery-1',
      NOW.getTime(),
    ] as const;
    insert.run(...base);
    expect(() => insert.run('duplicate', ...base.slice(1))).toThrow(/UNIQUE/);
    for (const [index, value] of [
      [1, '/workspace-b'],
      [2, 'other-monitor'],
      [3, 'other-source'],
      [4, 'other-object'],
    ] as const) {
      const values = [...base];
      values[0] = `sequence-mut-${String(index)}`;
      values[index] = value as never;
      insert.run(...values);
    }
    expect(
      sqlite
        .prepare('SELECT count(*) AS count FROM external_object_sequences')
        .get(),
    ).toEqual({ count: 5 });
    sqlite.close();
  });

  it('keeps global, empty, and concrete compatibility identities distinct', () => {
    const dbPath = scratchDb();
    createDb(dbPath);
    const sqlite = new Database(dbPath);
    const insert = sqlite.prepare(
      `INSERT INTO database_compatibility_markers
        (id, workspace_identity, capability, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run('global', null, 'durable-ingress-v1', NOW.getTime());
    insert.run('empty', '', 'durable-ingress-v1', NOW.getTime());
    insert.run(
      'workspace',
      '/workspace-a',
      'durable-ingress-v1',
      NOW.getTime(),
    );
    expect(() =>
      insert.run('global-duplicate', null, 'durable-ingress-v1', NOW.getTime()),
    ).toThrow(/UNIQUE/);
    expect(() =>
      insert.run('empty-duplicate', '', 'durable-ingress-v1', NOW.getTime()),
    ).toThrow(/UNIQUE/);
    expect(() =>
      insert.run(
        'workspace-duplicate',
        '/workspace-a',
        'durable-ingress-v1',
        NOW.getTime(),
      ),
    ).toThrow(/UNIQUE/);
    expect(
      sqlite
        .prepare('SELECT count(*) AS count FROM database_compatibility_markers')
        .get(),
    ).toEqual({ count: 3 });
    sqlite.close();
  });
});
