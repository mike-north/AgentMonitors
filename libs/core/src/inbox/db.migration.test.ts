/**
 * Migration coverage for the workspace-namespacing of `monitor_state` and
 * `observation_history` (issue #345 / #307).
 *
 * A database created before this change keyed `monitor_state` by `monitor_id`
 * alone (its PRIMARY KEY, no `workspace_path` column) and had no `workspace_path`
 * on `observation_history`. `createDb` must migrate such a database forward:
 *
 *  - drop the legacy `monitor_state` table (a one-time re-baseline — its
 *    `source_state` cannot be safely attributed to a workspace), rebuilding it
 *    with the surrogate `id` PK + `(monitor_id, COALESCE(workspace_path, ''))`
 *    UNIQUE index so two workspaces can hold independent state for the same id;
 *  - add the nullable `workspace_path` column to `observation_history`.
 *
 * @see ../runtime/store.ts (getMonitorState/setMonitorState keying)
 * @see docs/specs/002-runtime-delivery.md §3 (Persisted Monitor State)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from './db.js';
import { RuntimeStore } from '../runtime/store.js';

const tempRoots: string[] = [];

function tempDbPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-migrate-'));
  tempRoots.push(root);
  return path.join(root, 'inbox.db');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Materialize a database with the PRE-namespacing schema: `monitor_state` keyed
 * by `monitor_id` alone, `observation_history` without `workspace_path`. Seeds
 * one legacy row in each so the migration's re-baseline is observable.
 */
function createLegacyDb(dbPath: string): void {
  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE monitor_state (
      monitor_id TEXT PRIMARY KEY,
      last_observation_at INTEGER,
      last_fingerprint TEXT,
      source_state TEXT NOT NULL DEFAULT '{}',
      notify_state TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE observation_history (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      observation_data TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO monitor_state (monitor_id, source_state, notify_state, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      'my-first-monitor',
      JSON.stringify({ fingerprints: { '/project1/example.ts': 'deadbeef' } }),
      '{}',
      Date.now(),
    );
  sqlite
    .prepare(
      `INSERT INTO observation_history (id, monitor_id, source_name, observation_data, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'legacy-1',
      'my-first-monitor',
      'file-fingerprint',
      '{}',
      'triggered',
      Date.now(),
    );
  sqlite.close();
}

function columnNames(dbPath: string, table: string): string[] {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const cols = sqlite.pragma(`table_info(${table})`) as { name: string }[];
    return cols.map((c) => c.name);
  } finally {
    sqlite.close();
  }
}

describe('monitor_state / observation_history workspace migration (#345 / #307)', () => {
  it('adds workspace_path columns to a legacy database on open', () => {
    const dbPath = tempDbPath();
    createLegacyDb(dbPath);

    createDb(dbPath);

    expect(columnNames(dbPath, 'monitor_state')).toEqual(
      expect.arrayContaining(['id', 'monitor_id', 'workspace_path']),
    );
    expect(columnNames(dbPath, 'observation_history')).toContain(
      'workspace_path',
    );
  });

  it('re-baselines legacy monitor_state (drops unattributable rows) so no workspace inherits it', () => {
    const dbPath = tempDbPath();
    createLegacyDb(dbPath);

    const store = new RuntimeStore(createDb(dbPath));

    // The legacy row keyed by monitor_id alone is gone: neither a concrete
    // workspace nor the global scope inherits the old fingerprints. Every
    // workspace therefore re-baselines cleanly on its first post-upgrade tick.
    expect(
      store.getMonitorState('my-first-monitor', '/project2').sourceState,
    ).toBeUndefined();
    expect(
      store.getMonitorState('my-first-monitor', null).sourceState,
    ).toBeUndefined();
  });

  it('keeps two workspaces independent for the same monitor id after migration', () => {
    const dbPath = tempDbPath();
    createLegacyDb(dbPath);
    const store = new RuntimeStore(createDb(dbPath));

    store.setMonitorState('my-first-monitor', '/project1', {
      sourceState: { fingerprints: { '/project1/a.ts': 'aaa' } },
      notifyState: {},
      lastObservationAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    store.setMonitorState('my-first-monitor', '/project2', {
      sourceState: { fingerprints: { '/project2/b.ts': 'bbb' } },
      notifyState: {},
      lastObservationAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    // Same monitor id, two workspaces, one shared DB → two independent rows.
    expect(
      store.getMonitorState('my-first-monitor', '/project1').sourceState,
    ).toEqual({ fingerprints: { '/project1/a.ts': 'aaa' } });
    expect(
      store.getMonitorState('my-first-monitor', '/project2').sourceState,
    ).toEqual({ fingerprints: { '/project2/b.ts': 'bbb' } });
  });
});
