/**
 * Migration coverage for the workspace-namespacing of `monitor_state` and
 * `observation_history` (issue #345 / #307).
 *
 * A database created before this change keyed `monitor_state` by `monitor_id`
 * alone (its PRIMARY KEY, no `workspace_path` column) and had no `workspace_path`
 * on `observation_history`. `createDb` must migrate such a database forward:
 *
 *  - rebuild `monitor_state` with the surrogate `id` PK +
 *    `(monitor_id, COALESCE(workspace_path, ''))` UNIQUE index so two workspaces
 *    can hold independent state for the same id. `source_state` is reset (it
 *    cannot be safely attributed to a workspace), but each row's DURABLE
 *    `notify_state` batch (`pendingDebounce`/`pendingRollup` — already-detected
 *    observations the runtime MUST redeliver, 002 §4.4 / issue #109) is salvaged
 *    and re-inserted, attributed to the workspace derived from each observation's
 *    monitor `filePath`. Dropping such a batch would be silent, permanent event
 *    loss (the next tick re-baselines and never re-detects those changes);
 *  - add the nullable `workspace_path` column to `observation_history`.
 *
 * @see ../runtime/store.ts (getMonitorState/setMonitorState keying)
 * @see docs/specs/002-runtime-delivery.md §3 (Persisted Monitor State), §4.4
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

/** Fixed timestamp for legacy seed rows (never `Date.now()` in test data). */
const LEGACY_UPDATED_AT = new Date('2026-01-01T00:00:00.000Z').getTime();

/** Legacy (pre-namespacing) `monitor_state` DDL: keyed by `monitor_id` alone. */
const LEGACY_MONITOR_STATE_DDL = `
  CREATE TABLE monitor_state (
    monitor_id TEXT PRIMARY KEY,
    last_observation_at INTEGER,
    last_fingerprint TEXT,
    source_state TEXT NOT NULL DEFAULT '{}',
    notify_state TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
`;

/**
 * A persisted `StoredObservationEnvelope` as it lived inside a legacy row's
 * `notify_state` batch: the migration attributes each observation to a workspace
 * via its monitor's `filePath` (`<root>/.claude/monitors/<id>/MONITOR.md`).
 */
function legacyEnvelope(
  workspaceRoot: string,
  objectKey: string,
): Record<string, unknown> {
  return {
    monitor: {
      id: 'my-first-monitor',
      displayName: 'My monitor',
      frontmatter: { watch: { type: 'file-fingerprint' }, urgency: 'normal' },
      instructions: 'Handle it.',
      filePath: path.join(
        workspaceRoot,
        '.claude',
        'monitors',
        'my-first-monitor',
        'MONITOR.md',
      ),
    },
    observation: { title: `change ${objectKey}`, objectKey },
    observedAt: '2026-01-01T00:00:00.000Z',
    effectiveUrgency: 'normal',
  };
}

/**
 * Materialize a legacy database seeded with the given `monitor_state` rows
 * (keyed by `monitor_id` alone). Each row's `sourceState`/`notifyState` are
 * JSON-serialized exactly as the pre-namespacing runtime persisted them.
 */
function seedLegacyMonitorState(
  dbPath: string,
  rows: {
    monitorId: string;
    sourceState?: unknown;
    notifyState: unknown;
  }[],
): void {
  const sqlite = new Database(dbPath);
  sqlite.exec(LEGACY_MONITOR_STATE_DDL);
  const insert = sqlite.prepare(
    `INSERT INTO monitor_state (monitor_id, source_state, notify_state, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.monitorId,
      JSON.stringify(row.sourceState ?? {}),
      JSON.stringify(row.notifyState),
      LEGACY_UPDATED_AT,
    );
  }
  sqlite.close();
}

/** The observation object-keys held in a scope's persisted rollup batch. */
function rollupObjectKeys(
  store: RuntimeStore,
  monitorId: string,
  workspacePath: string | null,
): string[] {
  const notifyState = store.getMonitorState(monitorId, workspacePath)
    .notifyState as {
    pendingRollup?: {
      observations?: { observation?: { objectKey?: string } }[];
    };
  };
  return (notifyState.pendingRollup?.observations ?? []).map(
    (envelope) => envelope.observation?.objectKey ?? '',
  );
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

  it('preserves a non-empty pendingRollup batch across the migration, attributed to its workspace, with source_state reset', () => {
    // A legacy row holding an ALREADY-DETECTED rollup batch (002 §4.4 / #109).
    // Dropping it would be silent, permanent event loss: the batch is redelivered
    // on the next window opening, so the migration MUST carry it forward.
    const workspaceRoot = path.join('/', 'projects', 'alpha');
    const dbPath = tempDbPath();
    seedLegacyMonitorState(dbPath, [
      {
        monitorId: 'my-first-monitor',
        // source_state that MUST be reset (unattributable across workspaces).
        sourceState: { fingerprints: { '/projects/alpha/x.ts': 'deadbeef' } },
        notifyState: {
          pendingRollup: {
            observations: [
              legacyEnvelope(workspaceRoot, '/projects/alpha/x.ts'),
              legacyEnvelope(workspaceRoot, '/projects/alpha/y.ts'),
            ],
          },
        },
      },
    ]);

    const store = new RuntimeStore(createDb(dbPath));
    const migrated = store.getMonitorState('my-first-monitor', workspaceRoot);

    // The rollup batch survived, scoped to the workspace derived from each
    // observation's monitor filePath — and holds exactly its two observations.
    expect(rollupObjectKeys(store, 'my-first-monitor', workspaceRoot)).toEqual([
      '/projects/alpha/x.ts',
      '/projects/alpha/y.ts',
    ]);
    // source_state is reset to empty (clean re-baseline): the seeded
    // `deadbeef` fingerprint is gone, so no workspace inherits it.
    expect(migrated.sourceState).toEqual({});
    // The batch is NOT stranded under the global (NULL) scope no tick reads.
    expect(store.getMonitorState('my-first-monitor', null).notifyState).toEqual(
      {},
    );
  });

  it('preserves a non-empty pendingDebounce batch (with its dueAt) across the migration', () => {
    const workspaceRoot = path.join('/', 'projects', 'beta');
    const dueAt = '2026-02-02T00:00:00.000Z';
    const dbPath = tempDbPath();
    seedLegacyMonitorState(dbPath, [
      {
        monitorId: 'my-first-monitor',
        notifyState: {
          pendingDebounce: {
            dueAt,
            observations: [
              legacyEnvelope(workspaceRoot, '/projects/beta/z.ts'),
            ],
          },
        },
      },
    ]);

    const store = new RuntimeStore(createDb(dbPath));
    const debounce = (
      store.getMonitorState('my-first-monitor', workspaceRoot).notifyState as {
        pendingDebounce?: {
          dueAt?: string;
          observations?: { observation?: { objectKey?: string } }[];
        };
      }
    ).pendingDebounce;

    expect(debounce?.dueAt).toBe(dueAt);
    expect(
      (debounce?.observations ?? []).map((e) => e.observation?.objectKey),
    ).toEqual(['/projects/beta/z.ts']);
  });

  it('splits a legacy batch spanning two workspaces into correctly-scoped rows (no cross-workspace mixing)', () => {
    // The collision case #345 tracks: one legacy row (keyed by monitor_id alone)
    // whose batch mixes observations from two different workspaces. Each must
    // land in its OWN scoped row, never the other's.
    const alpha = path.join('/', 'projects', 'alpha');
    const beta = path.join('/', 'projects', 'beta');
    const dbPath = tempDbPath();
    seedLegacyMonitorState(dbPath, [
      {
        monitorId: 'my-first-monitor',
        notifyState: {
          pendingRollup: {
            observations: [
              legacyEnvelope(alpha, '/projects/alpha/a.ts'),
              legacyEnvelope(beta, '/projects/beta/b.ts'),
              legacyEnvelope(alpha, '/projects/alpha/c.ts'),
            ],
          },
        },
      },
    ]);

    const store = new RuntimeStore(createDb(dbPath));

    expect(rollupObjectKeys(store, 'my-first-monitor', alpha)).toEqual([
      '/projects/alpha/a.ts',
      '/projects/alpha/c.ts',
    ]);
    expect(rollupObjectKeys(store, 'my-first-monitor', beta)).toEqual([
      '/projects/beta/b.ts',
    ]);
  });

  it('is idempotent: re-running the migration on an already-migrated DB neither errors nor loses the batch', () => {
    const workspaceRoot = path.join('/', 'projects', 'gamma');
    const dbPath = tempDbPath();
    seedLegacyMonitorState(dbPath, [
      {
        monitorId: 'my-first-monitor',
        notifyState: {
          pendingRollup: {
            observations: [
              legacyEnvelope(workspaceRoot, '/projects/gamma/g.ts'),
            ],
          },
        },
      },
    ]);

    // First open migrates; second open re-runs the migration path against the
    // already-migrated schema. This is the same code two concurrent first-opens
    // race on, serialized by the immediate transaction — it must be a no-op.
    createDb(dbPath);
    const store = new RuntimeStore(createDb(dbPath));

    expect(columnNames(dbPath, 'monitor_state')).toEqual(
      expect.arrayContaining(['id', 'monitor_id', 'workspace_path']),
    );
    // The preserved batch was not dropped or duplicated by the second open.
    expect(rollupObjectKeys(store, 'my-first-monitor', workspaceRoot)).toEqual([
      '/projects/gamma/g.ts',
    ]);
  });
});
