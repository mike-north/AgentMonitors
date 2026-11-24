/**
 * Opening a database that a newer version marked forward-only. `createDb()`
 * refuses a compatibility marker whose capability this version does not know,
 * before the open writes anything, and still opens every capability and
 * marker scope this version (or any earlier shape of it) writes.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md (§15 `database_compatibility_markers`)
 * @see ../../../../docs/specs/004-validation-testing.md (§2.14)
 */
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type InboxDb } from '../inbox/db.js';
import {
  cleanupReceiptTempDirs,
  receiptScratchDb,
} from './persistence.fixtures.js';

const sql = String.raw;

afterEach(cleanupReceiptTempDirs);

function closeDb(db: InboxDb): void {
  (db as unknown as { $client: Database.Database }).$client.close();
}

/** Every byte a refused open could touch: the file and its WAL sidecars. */
function snapshot(dbPath: string) {
  const sidecar = (suffix: string) =>
    existsSync(dbPath + suffix) ? readFileSync(dbPath + suffix) : null;
  return {
    main: readFileSync(dbPath),
    wal: sidecar('-wal'),
    shm: sidecar('-shm'),
  };
}

function markers(dbPath: string) {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw
      .prepare(
        sql`SELECT workspace_identity, capability FROM database_compatibility_markers
            ORDER BY capability, workspace_identity`,
      )
      .all();
  } finally {
    raw.close();
  }
}

function journalMode(dbPath: string): unknown {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw.pragma('journal_mode', { simple: true });
  } finally {
    raw.close();
  }
}

/** A current database holding the given markers, closed. */
function databaseWithMarkers(
  rows: readonly [workspace: string | null, capability: string][],
  journal: 'wal' | 'delete' = 'wal',
): string {
  const dbPath = receiptScratchDb();
  closeDb(createDb(dbPath));
  const raw = new Database(dbPath);
  const insert = raw.prepare(
    sql`INSERT INTO database_compatibility_markers
        (id, workspace_identity, capability, created_at) VALUES (?, ?, ?, 0)`,
  );
  rows.forEach(([workspace, capability], index) => {
    insert.run(`marker-${String(index)}`, workspace, capability);
  });
  // A session row stands for the durable state the refusal protects.
  raw.exec(
    sql`INSERT INTO agent_sessions (id, adapter, host_session_id, agent_identity, workspace_path,
          hook_state_path, status, baseline_at, last_active_at, created_at, updated_at)
        VALUES ('session-1', 'claude', 'host-1', 'lead', '/workspace', '/hook-state', 'active',
          0, 0, 0, 0)`,
  );
  if (journal === 'delete') raw.pragma('journal_mode = DELETE');
  raw.close();
  return dbPath;
}

describe('opening a database marked by a newer version', () => {
  it.each([
    ['write-ahead-log', 'wal'],
    ['rollback-journal', 'delete'],
  ] as const)(
    'refuses a %s database, naming the capability, and leaves every byte unchanged',
    (_mode, journal) => {
      const dbPath = databaseWithMarkers(
        [
          ['/workspace', 'durable-ingress-v1'],
          ['/workspace', 'durable-ingress-v2'],
        ],
        journal,
      );
      const before = snapshot(dbPath);
      const markersBefore = markers(dbPath);

      let refusal: unknown;
      try {
        closeDb(createDb(dbPath));
      } catch (error) {
        refusal = error;
      }
      // 002 §15: a clear error naming the unknown capability and saying a
      // newer version wrote it.
      expect(refusal).toBeInstanceOf(Error);
      const message = (refusal as Error).message;
      expect(message).toContain('"durable-ingress-v2"');
      expect(message).toContain('newer version of Agent Monitors');
      expect(message).toContain('The database was left unchanged.');
      expect(message).not.toContain('"durable-ingress-v1"');

      // 002 §15: schema, rows, markers and journal mode are untouched.
      expect(snapshot(dbPath)).toEqual(before);
      expect(markers(dbPath)).toEqual(markersBefore);
      expect(journalMode(dbPath)).toBe(journal);
    },
  );

  it('refuses an unknown capability in any marker scope, naming each one', () => {
    const dbPath = databaseWithMarkers([
      [null, 'global-future-v1'],
      ['', 'empty-scope-future-v1'],
    ]);
    const before = snapshot(dbPath);

    expect(() => createDb(dbPath)).toThrow(
      'holds capability "empty-scope-future-v1", "global-future-v1", written by a newer version',
    );
    expect(snapshot(dbPath)).toEqual(before);
  });

  it('opens again once the unknown marker is gone', () => {
    const dbPath = databaseWithMarkers([['/workspace', 'durable-ingress-v2']]);
    expect(() => createDb(dbPath)).toThrow('"durable-ingress-v2"');

    const raw = new Database(dbPath);
    raw.exec(
      `DELETE FROM database_compatibility_markers WHERE capability = 'durable-ingress-v2'`,
    );
    raw.close();
    expect(() => {
      closeDb(createDb(dbPath));
    }).not.toThrow();
  });
});

describe('opening a database marked by this version', () => {
  // `durable-ingress-v1` is the only capability any shape of this storage has
  // written, at the global, empty-string and concrete workspace scopes.
  it('opens global, empty-workspace and workspace markers and keeps them', () => {
    const dbPath = databaseWithMarkers([
      [null, 'durable-ingress-v1'],
      ['', 'durable-ingress-v1'],
      ['/workspace', 'durable-ingress-v1'],
    ]);

    closeDb(createDb(dbPath));
    closeDb(createDb(dbPath));

    expect(markers(dbPath)).toEqual([
      { workspace_identity: null, capability: 'durable-ingress-v1' },
      { workspace_identity: '', capability: 'durable-ingress-v1' },
      { workspace_identity: '/workspace', capability: 'durable-ingress-v1' },
    ]);
  });

  it('opens a database with the earlier single marker index and a global marker', () => {
    // The earlier shape keyed markers by COALESCE(workspace_identity, ''), so
    // it could hold a global and a concrete marker but not a global and an
    // empty-string one.
    const dbPath = databaseWithMarkers([]);
    const raw = new Database(dbPath);
    raw.exec(sql`
      DROP INDEX idx_database_compatibility_marker_workspace_key;
      DROP INDEX idx_database_compatibility_marker_global_key;
      CREATE UNIQUE INDEX idx_database_compatibility_marker_key
        ON database_compatibility_markers (COALESCE(workspace_identity, ''), capability);
      INSERT INTO database_compatibility_markers (id, workspace_identity, capability, created_at)
        VALUES ('legacy-global', NULL, 'durable-ingress-v1', 0),
               ('legacy-workspace', '/workspace', 'durable-ingress-v1', 0);
    `);
    raw.close();

    closeDb(createDb(dbPath));

    expect(markers(dbPath)).toEqual([
      { workspace_identity: null, capability: 'durable-ingress-v1' },
      { workspace_identity: '/workspace', capability: 'durable-ingress-v1' },
    ]);
  });

  it('opens an in-memory database', () => {
    expect(() => {
      closeDb(createDb(':memory:'));
    }).not.toThrow();
  });
});
