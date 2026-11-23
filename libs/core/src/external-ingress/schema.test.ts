/**
 * Durable storage for external event receipts, per-object sequence high-water
 * marks and database compatibility markers (002 §15). Covers the shape a fresh
 * database creates, the upgrade of a database written with the earlier marker
 * index, concurrent first opens from independent processes, the store's
 * carry-or-refuse migration rule, and the separation from source checkpoint
 * state.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md (§15, external ingress tables)
 * @see ../../../../docs/specs/004-validation-testing.md (§2.14)
 * @see https://www.sqlite.org/partialindex.html
 * @see https://www.sqlite.org/wal.html#concurrency
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDb,
  enableWriteAheadLog,
  SchemaMigrationError,
  type WalSwitchClock,
} from '../inbox/db.js';
import { RuntimeStore } from '../runtime/store.js';

const sql = String.raw;

const NOW = new Date('2026-08-13T18:00:00.000Z');
/** 002 §15: every SQLite timestamp column stores Unix epoch seconds. */
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentmon-ingress-schema-'));
  tempDirs.push(dir);
  return dir;
}

function scratchDb(): string {
  return path.join(scratchDir(), 'agentmon.db');
}

/** The three tables this storage layer owns (002 §15). */
const INGRESS_TABLES = [
  'database_compatibility_markers',
  'external_event_receipts',
  'external_object_sequences',
] as const;

/**
 * The marker index a database written before the global/concrete split holds.
 * Its expression folds `NULL` and `''` into one key, so a global marker and an
 * empty-string workspace marker for the same capability collide.
 */
const LEGACY_MARKER_INDEX_SQL = sql`
  CREATE UNIQUE INDEX idx_database_compatibility_marker_key
    ON database_compatibility_markers (
      COALESCE(workspace_identity, ''), capability
    )
`;

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
    accepted_at: NOW_SECONDS,
    updated_at: NOW_SECONDS,
    ...overrides,
  };
}

function insertReceipt(
  sqlite: Database.Database,
  values: Record<string, unknown>,
) {
  sqlite
    .prepare(
      sql`INSERT INTO external_event_receipts (
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

function insertSequence(sqlite: Database.Database, id: string) {
  sqlite
    .prepare(
      sql`INSERT INTO external_object_sequences (
        id, workspace_identity, monitor_id, source, object_id,
        highest_sequence, receipt_id, upstream_event_id, updated_at
      ) VALUES (?, '/workspace-a', 'build-health', 'build-system', 'build-1',
        7, 'receipt-1', 'delivery-1', ?)`,
    )
    .run(id, NOW_SECONDS);
}

function insertMarker(
  sqlite: Database.Database,
  id: string,
  workspaceIdentity: string | null,
) {
  sqlite
    .prepare(
      sql`INSERT INTO database_compatibility_markers
        (id, workspace_identity, capability, created_at)
       VALUES (?, ?, 'durable-ingress-v1', ?)`,
    )
    .run(id, workspaceIdentity, NOW_SECONDS);
}

function allRows(sqlite: Database.Database, table: string): unknown[] {
  return sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

function indexSql(sqlite: Database.Database, name: string): string | null {
  const row = sqlite
    .prepare<
      [string],
      { sql: string | null }
    >(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name);
  return row === undefined ? null : (row.sql ?? '').replace(/\s+/g, ' ');
}

/** Each index's unique/partial flags and key columns, as SQLite reports them. */
function indexShape(sqlite: Database.Database, table: string, name: string) {
  const listed = (
    sqlite.pragma(`index_list(${table})`) as {
      name: string;
      unique: number;
      partial: number;
    }[]
  ).find((index) => index.name === name);
  const columns = (
    sqlite.pragma(`index_info(${name})`) as { name: string | null }[]
  ).map((column) => column.name);
  return { unique: listed?.unique, partial: listed?.partial, columns };
}

function tableColumns(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_xinfo(${table})`) as { name: string }[]).map(
    (column) => column.name,
  );
}

function seedRuntimeRows(store: RuntimeStore) {
  const session = store.openSession({
    adapter: 'test',
    hostSessionId: 'host-session',
    agentIdentity: 'agent',
    workspacePath: '/workspace-a',
    hookStatePath: '/tmp/hook-state.json',
  });
  const event = store.insertEvent({
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
  return { session, event };
}

describe('external ingress storage schema', () => {
  it('keys receipts by workspace, monitor, source, and upstream event', () => {
    const dbPath = scratchDb();
    createDb(dbPath);
    const sqlite = new Database(dbPath);

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

  it('stores receipt timestamps as epoch seconds that decode to the written instant', () => {
    const dbPath = scratchDb();
    createDb(dbPath);
    const sqlite = new Database(dbPath);
    insertReceipt(sqlite, receiptValues());
    sqlite.close();

    // A fresh open reads the row through the schema's `mode: 'timestamp'`
    // columns; seconds must round-trip to the same instant (002 §15).
    const reopened = new Database(dbPath);
    const row = reopened
      .prepare(
        `SELECT accepted_at, updated_at FROM external_event_receipts WHERE id = 'receipt-1'`,
      )
      .get() as { accepted_at: number; updated_at: number };
    expect(new Date(row.accepted_at * 1000).toISOString()).toBe(
      NOW.toISOString(),
    );
    expect(new Date(row.updated_at * 1000).toISOString()).toBe(
      NOW.toISOString(),
    );
    reopened.close();
  });

  it('keys object sequences by workspace, monitor, source, and object', () => {
    const dbPath = scratchDb();
    createDb(dbPath);
    const sqlite = new Database(dbPath);
    const insert = sqlite.prepare(
      sql`INSERT INTO external_object_sequences (
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
      NOW_SECONDS,
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
    insertMarker(sqlite, 'global', null);
    insertMarker(sqlite, 'empty', '');
    insertMarker(sqlite, 'workspace', '/workspace-a');
    expect(() => {
      insertMarker(sqlite, 'global-duplicate', null);
    }).toThrow(/UNIQUE/);
    expect(() => {
      insertMarker(sqlite, 'empty-duplicate', '');
    }).toThrow(/UNIQUE/);
    expect(() => {
      insertMarker(sqlite, 'workspace-duplicate', '/workspace-a');
    }).toThrow(/UNIQUE/);
    expect(
      sqlite
        .prepare('SELECT count(*) AS count FROM database_compatibility_markers')
        .get(),
    ).toEqual({ count: 3 });
    sqlite.close();
  });
});

describe('opening a database written with the earlier marker index', () => {
  /**
   * Build the earlier on-disk shape in place: the same tables, with the legacy
   * expression index instead of the two partial indexes, holding a persisted
   * global marker, a receipt, a sequence row and ordinary runtime rows. No
   * table is dropped or recreated.
   */
  function writeEarlierDatabase(dbPath: string) {
    const store = new RuntimeStore(createDb(dbPath));
    const runtime = seedRuntimeRows(store);
    const sqlite = new Database(dbPath);
    sqlite.exec(sql`
      DROP INDEX idx_database_compatibility_marker_workspace_key;
      DROP INDEX idx_database_compatibility_marker_global_key;
    `);
    sqlite.exec(LEGACY_MARKER_INDEX_SQL);
    insertMarker(sqlite, 'marker-global', null);
    insertReceipt(sqlite, receiptValues());
    insertSequence(sqlite, 'sequence-1');
    // The earlier index really does fold `NULL` and `''` together.
    expect(() => {
      insertMarker(sqlite, 'marker-empty', '');
    }).toThrow(/UNIQUE/);
    const before = Object.fromEntries(
      INGRESS_TABLES.map((table) => [table, allRows(sqlite, table)]),
    );
    sqlite.close();
    return { runtime, before };
  }

  it('keeps every row, replaces the legacy index, and lets global and empty identities coexist', () => {
    const dbPath = scratchDb();
    const { runtime, before } = writeEarlierDatabase(dbPath);

    const migrated = new RuntimeStore(createDb(dbPath));
    expect(migrated.listSessions().map((row) => row.id)).toContain(
      runtime.session.id,
    );
    expect(migrated.listEvents().map((row) => row.id)).toContain(
      runtime.event.id,
    );

    const sqlite = new Database(dbPath);
    for (const table of INGRESS_TABLES) {
      expect(allRows(sqlite, table)).toEqual(before[table]);
    }
    expect(allRows(sqlite, 'database_compatibility_markers')).toEqual([
      {
        id: 'marker-global',
        workspace_identity: null,
        capability: 'durable-ingress-v1',
        created_at: NOW_SECONDS,
      },
    ]);

    expect(indexSql(sqlite, 'idx_database_compatibility_marker_key')).toBe(
      null,
    );
    expect(
      indexShape(
        sqlite,
        'database_compatibility_markers',
        'idx_database_compatibility_marker_workspace_key',
      ),
    ).toEqual({
      unique: 1,
      partial: 1,
      columns: ['workspace_identity', 'capability'],
    });
    expect(
      indexSql(sqlite, 'idx_database_compatibility_marker_workspace_key'),
    ).toMatch(/ WHERE workspace_identity IS NOT NULL ?$/);
    expect(
      indexShape(
        sqlite,
        'database_compatibility_markers',
        'idx_database_compatibility_marker_global_key',
      ),
    ).toEqual({ unique: 1, partial: 1, columns: ['capability'] });
    expect(
      indexSql(sqlite, 'idx_database_compatibility_marker_global_key'),
    ).toMatch(/ WHERE workspace_identity IS NULL ?$/);

    // The persisted global marker and a new empty-string marker coexist; the
    // global identity stays single.
    insertMarker(sqlite, 'marker-empty', '');
    expect(() => {
      insertMarker(sqlite, 'marker-global-again', null);
    }).toThrow(/UNIQUE/);
    expect(
      sqlite
        .prepare(`SELECT id FROM database_compatibility_markers ORDER BY id`)
        .all(),
    ).toEqual([{ id: 'marker-empty' }, { id: 'marker-global' }]);
    sqlite.close();
  });

  it('is a no-op on a second open of the upgraded database', () => {
    const dbPath = scratchDb();
    writeEarlierDatabase(dbPath);
    createDb(dbPath);
    const probe = new Database(dbPath);
    const schemaAfterFirst = probe
      .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`)
      .all();
    const rowsAfterFirst = INGRESS_TABLES.map((table) => allRows(probe, table));
    probe.close();

    createDb(dbPath);
    const again = new Database(dbPath);
    expect(
      again
        .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`)
        .all(),
    ).toEqual(schemaAfterFirst);
    expect(INGRESS_TABLES.map((table) => allRows(again, table))).toEqual(
      rowsAfterFirst,
    );
    again.close();
  });
});

describe('ingress tables follow the store migration rule: carry or refuse', () => {
  /** An existing table, then a full open; returns what the open threw. */
  function openWith(setup: (sqlite: Database.Database) => void) {
    const dbPath = scratchDb();
    createDb(dbPath);
    const sqlite = new Database(dbPath);
    setup(sqlite);
    const schemaBefore = sqlite
      .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`)
      .all();
    sqlite.close();
    let thrown: unknown;
    try {
      createDb(dbPath);
    } catch (error) {
      thrown = error;
    }
    const after = new Database(dbPath);
    return { dbPath, thrown, schemaBefore, after };
  }

  it('carries a column an earlier or local schema added, with its values', () => {
    const { thrown, after } = openWith((sqlite) => {
      sqlite.exec(
        `ALTER TABLE external_event_receipts ADD COLUMN operator_note TEXT`,
      );
      insertReceipt(sqlite, receiptValues());
      sqlite.exec(
        `UPDATE external_event_receipts SET operator_note = 'keep me'`,
      );
    });
    expect(thrown).toBeUndefined();
    expect(tableColumns(after, 'external_event_receipts')).toContain(
      'operator_note',
    );
    expect(
      after
        .prepare(`SELECT id, operator_note FROM external_event_receipts`)
        .all(),
    ).toEqual([{ id: 'receipt-1', operator_note: 'keep me' }]);
    // The current writer, which never names the carried column, still writes.
    insertReceipt(
      after,
      receiptValues({ id: 'receipt-2', upstream_event_id: 'd-2' }),
    );
    after.close();
  });

  it('adds a missing column that is nullable or has a default, keeping existing rows', () => {
    const { thrown, after } = openWith((sqlite) => {
      sqlite.exec(sql`
        ALTER TABLE external_event_receipts DROP COLUMN last_error;
        ALTER TABLE external_event_receipts DROP COLUMN attempt_count;
      `);
      sqlite
        .prepare(
          sql`INSERT INTO external_event_receipts (
            id, workspace_identity, monitor_id, source, upstream_event_id,
            semantic_hash, object_id, object_sequence, event_kind, change_kind,
            occurred_at, outcome, accepted_at, updated_at
          ) VALUES ('receipt-1', '/workspace-a', 'build-health', 'build-system',
            'delivery-1', 'hash-1', 'build-1', 1, 'build.updated', 'modified',
            '2026-08-13T18:00:00Z', 'held', ?, ?)`,
        )
        .run(NOW_SECONDS, NOW_SECONDS);
    });
    expect(thrown).toBeUndefined();
    expect(
      after
        .prepare(
          `SELECT id, attempt_count, last_error, event_ids FROM external_event_receipts`,
        )
        .all(),
    ).toEqual([
      // 002 §15 defaults: attempt_count 0, last_error NULL, event_ids '[]'.
      { id: 'receipt-1', attempt_count: 0, last_error: null, event_ids: '[]' },
    ]);
    after.close();
  });

  it('keeps an equivalent index written with other formatting instead of rebuilding it', () => {
    // The index text an earlier open stored, with its line breaks.
    const stored = sql`CREATE UNIQUE INDEX idx_external_event_receipt_key
      ON external_event_receipts (
        workspace_identity, monitor_id, source, upstream_event_id
      )`;
    const { thrown, after } = openWith((sqlite) => {
      sqlite.exec(sql`DROP INDEX idx_external_event_receipt_key`);
      sqlite.exec(stored);
    });
    expect(thrown).toBeUndefined();
    expect(
      (
        after
          .prepare(
            `SELECT sql FROM sqlite_master WHERE name = 'idx_external_event_receipt_key'`,
          )
          .get() as { sql: string }
      ).sql,
    ).toBe(stored);
    after.close();
  });

  it('replaces a same-named index whose definition differs', () => {
    const { thrown, after } = openWith((sqlite) => {
      sqlite.exec(sql`
        DROP INDEX idx_external_object_sequence_key;
        CREATE INDEX idx_external_object_sequence_key
          ON external_object_sequences (object_id);
      `);
    });
    expect(thrown).toBeUndefined();
    expect(
      indexShape(
        after,
        'external_object_sequences',
        'idx_external_object_sequence_key',
      ),
    ).toEqual({
      unique: 1,
      partial: 0,
      columns: ['workspace_identity', 'monitor_id', 'source', 'object_id'],
    });
    after.close();
  });

  it('does not report a failure unrelated to existing rows as a row violation', () => {
    // A view holding the index's name makes creation fail for a reason that
    // has nothing to do with duplicate rows.
    const { thrown, after } = openWith((sqlite) => {
      sqlite.exec(sql`
        DROP INDEX idx_external_object_sequence_key;
        CREATE VIEW idx_external_object_sequence_key AS SELECT 1;
      `);
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SchemaMigrationError);
    expect((thrown as Error).message).toMatch(/already/);
    after.close();
  });

  it('refuses, naming the table and column, when an existing table lacks a required column', () => {
    const { thrown, schemaBefore, after } = openWith((sqlite) => {
      // Rebuild the sequence table by hand without `receipt_id`: a shape the
      // current writer cannot use.
      sqlite.exec(sql`
        ALTER TABLE external_object_sequences RENAME TO old_sequences;
        CREATE TABLE external_object_sequences (
          id TEXT PRIMARY KEY,
          workspace_identity TEXT NOT NULL,
          monitor_id TEXT NOT NULL,
          source TEXT NOT NULL,
          object_id TEXT NOT NULL,
          highest_sequence INTEGER NOT NULL,
          upstream_event_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        DROP TABLE old_sequences;
      `);
    });
    expect(thrown).toBeInstanceOf(SchemaMigrationError);
    const error = thrown as SchemaMigrationError;
    expect(error.table).toBe('external_object_sequences');
    expect(error.column).toBe('receipt_id');
    expect(error.message).toMatch(/The database was left unchanged\.$/);
    expect(
      after
        .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`)
        .all(),
    ).toEqual(schemaBefore);
    after.close();
  });

  it('refuses a carried NOT NULL column without a default, which would reject every new receipt', () => {
    const { thrown, schemaBefore, after } = openWith((sqlite) => {
      sqlite.exec(sql`
        ALTER TABLE database_compatibility_markers RENAME TO old_markers;
        CREATE TABLE database_compatibility_markers (
          id TEXT PRIMARY KEY,
          workspace_identity TEXT,
          capability TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          owner TEXT NOT NULL
        );
        DROP TABLE old_markers;
      `);
      sqlite.exec(LEGACY_MARKER_INDEX_SQL);
    });
    expect(thrown).toBeInstanceOf(SchemaMigrationError);
    const error = thrown as SchemaMigrationError;
    expect(error.table).toBe('database_compatibility_markers');
    expect(error.column).toBe('owner');
    // The refusal rolled back the legacy index drop with everything else.
    expect(
      after
        .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`)
        .all(),
    ).toEqual(schemaBefore);
    expect(indexSql(after, 'idx_database_compatibility_marker_key')).not.toBe(
      null,
    );
    after.close();
  });

  it('refuses clearly when existing rows violate a receipt key the open must create', () => {
    const { thrown, schemaBefore, after } = openWith((sqlite) => {
      sqlite.exec(`DROP INDEX idx_external_event_receipt_key`);
      insertReceipt(sqlite, receiptValues());
      insertReceipt(sqlite, receiptValues({ id: 'receipt-duplicate' }));
    });
    expect(thrown).toBeInstanceOf(SchemaMigrationError);
    const error = thrown as SchemaMigrationError;
    expect(error.table).toBe('external_event_receipts');
    expect(error.message).toMatch(/idx_external_event_receipt_key/);
    expect(
      after
        .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY name`)
        .all(),
    ).toEqual(schemaBefore);
    expect(
      after.prepare(`SELECT count(*) AS n FROM external_event_receipts`).get(),
    ).toEqual({ n: 2 });
    after.close();
  });
});

describe('receipt tables stay separate from source checkpoint state', () => {
  /** 002 §15 `monitor_state`: the source/notify checkpoint columns. */
  const MONITOR_STATE_COLUMNS = [
    'id',
    'monitor_id',
    'workspace_path',
    'last_observation_at',
    'last_fingerprint',
    'source_state',
    'notify_state',
    'updated_at',
  ];
  /** Columns that carry external-ingress identity or ordering. */
  const INGRESS_ONLY_COLUMNS = [
    'workspace_identity',
    'upstream_event_id',
    'semantic_hash',
    'object_sequence',
    'highest_sequence',
    'receipt_id',
    'capability',
    'outcome',
  ];

  it('adds no ingress column to monitor_state and links no table to it', () => {
    const dbPath = scratchDb();
    createDb(dbPath);
    const sqlite = new Database(dbPath);
    expect(tableColumns(sqlite, 'monitor_state').sort()).toEqual(
      [...MONITOR_STATE_COLUMNS].sort(),
    );
    for (const table of INGRESS_TABLES) {
      const columns = tableColumns(sqlite, table);
      expect(columns).not.toContain('source_state');
      expect(columns).not.toContain('notify_state');
      expect(sqlite.pragma(`foreign_key_list(${table})`)).toEqual([]);
    }
    for (const column of INGRESS_ONLY_COLUMNS) {
      expect(tableColumns(sqlite, 'monitor_state')).not.toContain(column);
    }
    expect(
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
        .all(),
    ).toEqual([]);
    sqlite.close();
  });

  it('writes to either side leave the other side unchanged', () => {
    const dbPath = scratchDb();
    const store = new RuntimeStore(createDb(dbPath));
    store.setMonitorState('build-health', '/workspace-a', {
      sourceState: { cursor: 3 },
      notifyState: {},
      lastObservationAt: NOW,
    });
    const sqlite = new Database(dbPath);
    for (const table of INGRESS_TABLES) {
      expect(allRows(sqlite, table)).toEqual([]);
    }
    const stateBefore = allRows(sqlite, 'monitor_state');

    insertReceipt(sqlite, receiptValues());
    insertSequence(sqlite, 'sequence-1');
    insertMarker(sqlite, 'marker-workspace', '/workspace-a');
    expect(allRows(sqlite, 'monitor_state')).toEqual(stateBefore);
    expect(store.getMonitorState('build-health', '/workspace-a')).toEqual({
      lastObservationAt: new Date(NOW_SECONDS * 1000),
      sourceState: { cursor: 3 },
      notifyState: {},
    });
    sqlite.close();
  });
});

describe('concurrent first open from independent processes', () => {
  const CHILD_COUNT = 6;
  const TRIALS = 60;

  /**
   * Start one bounded child that runs every trial under `root` (see the
   * fixture's protocol). Each process starts once for all trials, so the
   * test's cost is the racing opens rather than repeated startup.
   */
  function startChild(root: string) {
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--import',
        path.resolve('src/runtime/__fixtures__/typescript-loader.ts'),
        path.resolve('src/external-ingress/__fixtures__/first-open-child.ts'),
        root,
        String(TRIALS),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 60_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return {
      child,
      exited,
      get output() {
        return output;
      },
      get errors() {
        return errors;
      },
    };
  }

  type Child = ReturnType<typeof startChild>;

  /** Wait until every child has printed a line starting with one of `prefixes`. */
  async function waitForLine(
    children: Child[],
    prefixes: string[],
    what: string,
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    const seen = (c: Child) =>
      c.output
        .split('\n')
        .some((line) => prefixes.some((prefix) => line.startsWith(prefix)));
    while (!children.every(seen)) {
      if (Date.now() >= deadline) {
        const report = children.map((c) => c.output + c.errors).join('\n');
        throw new Error(`children never reported ${what}:\n${report}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  it('every opener succeeds and sees the full schema, created once', async () => {
    const reference = scratchDb();
    createDb(reference);
    const expected = new Database(reference);
    const expectedNames = expected
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all();
    expected.close();
    expect(expectedNames).toEqual(
      expect.arrayContaining(
        INGRESS_TABLES.map((name) => ({ type: 'table', name })),
      ),
    );

    const root = scratchDir();
    const children = Array.from({ length: CHILD_COUNT }, () =>
      startChild(root),
    );
    try {
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const n = String(trial);
        await waitForLine(children, [`READY ${n}`], `READY ${n}`);
        // Every child is now polling this trial's barrier against one fresh path.
        mkdirSync(path.join(root, `trial-${n}`), { mode: 0o700 });
        writeFileSync(path.join(root, `go-${n}`), 'go');
        await waitForLine(
          children,
          [`RESULT ${n} `, `ERROR ${n} `],
          `trial ${n}`,
        );
        for (const c of children) {
          const line = c.output
            .split('\n')
            .find(
              (l) =>
                l.startsWith(`RESULT ${n} `) || l.startsWith(`ERROR ${n} `),
            );
          expect(line, `trial ${n}`).toMatch(new RegExp(`^RESULT ${n} `));
          expect(
            JSON.parse(line?.slice(`RESULT ${n} `.length) ?? 'null'),
          ).toEqual(expectedNames);
        }
        // One schema: each object exists exactly once and the file is sound.
        const sqlite = new Database(
          path.join(root, `trial-${n}`, 'agentmon.db'),
        );
        expect(
          sqlite
            .prepare(
              `SELECT type, name FROM sqlite_master
               WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
               ORDER BY type, name`,
            )
            .all(),
        ).toEqual(expectedNames);
        expect(sqlite.pragma('integrity_check')).toEqual([
          { integrity_check: 'ok' },
        ]);
        expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
        sqlite.close();
      }
      const codes = await Promise.all(children.map((c) => c.exited));
      expect(codes).toEqual(Array.from({ length: CHILD_COUNT }, () => 0));
    } finally {
      for (const c of children) {
        if (c.child.exitCode === null && c.child.signalCode === null)
          c.child.kill('SIGKILL');
      }
      await Promise.allSettled(children.map((c) => c.exited));
    }
  }, 120_000);
});

describe('switching a fresh file to write-ahead logging is bounded', () => {
  /** 002 §15: the switch waits at most this long in total, retries included. */
  const BOUND_MS = 5000;

  function busyError(): Error {
    return Object.assign(new Error('database is locked'), {
      code: 'SQLITE_BUSY',
    });
  }

  /**
   * A connection whose WAL switch reports `SQLITE_BUSY` at once until
   * `immediateUntil` (another opener mid-switch, so SQLite skips the busy
   * handler) and afterwards blocks for its whole busy timeout before failing
   * (a lock held by another connection), unless `releasedAt` has passed. Time
   * is virtual: blocking and pauses only advance the clock.
   */
  function contendedConnection(immediateUntil: number, releasedAt = Infinity) {
    let time = 0;
    // buildDb sets the connection's busy timeout before the switch.
    let busyTimeout = BOUND_MS;
    const clock: WalSwitchClock = {
      now: () => time,
      sleep: (ms) => {
        time += ms;
      },
    };
    const sqlite = {
      pragma(source: string): unknown {
        const timeout = /^busy_timeout = (\d+)$/.exec(source);
        if (timeout) {
          busyTimeout = Number(timeout[1]);
          return undefined;
        }
        if (source !== 'journal_mode = WAL') {
          throw new Error(`unexpected pragma ${source}`);
        }
        if (time >= releasedAt) return 'wal';
        if (time < immediateUntil) throw busyError();
        const waited = Math.min(busyTimeout, Math.max(0, releasedAt - time));
        time += waited;
        if (time >= releasedAt) return 'wal';
        throw busyError();
      },
    };
    return {
      sqlite,
      clock,
      get time() {
        return time;
      },
      get busyTimeout() {
        return busyTimeout;
      },
    };
  }

  it('fails at the bound when a held lock follows immediate busy results', () => {
    // Immediate busy results use up almost all of the bound; the next attempt
    // may block in the busy handler only for the time that is left.
    const connection = contendedConnection(BOUND_MS - 10);
    expect(() => {
      enableWriteAheadLog(connection.sqlite, connection.clock, BOUND_MS);
    }).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    expect(connection.time).toBeLessThanOrEqual(BOUND_MS);
    expect(connection.busyTimeout).toBe(BOUND_MS);
  });

  it('succeeds once a concurrent switch finishes, restoring the busy timeout', () => {
    const connection = contendedConnection(Infinity, 120);
    enableWriteAheadLog(connection.sqlite, connection.clock, BOUND_MS);
    expect(connection.time).toBeGreaterThanOrEqual(120);
    expect(connection.time).toBeLessThan(BOUND_MS);
    expect(connection.busyTimeout).toBe(BOUND_MS);
  });

  it('opening a fresh rollback-journal file under a held lock fails within the bound', () => {
    const dbPath = scratchDb();
    const holder = new Database(dbPath);
    holder.exec('CREATE TABLE held (x INTEGER)');
    expect(holder.pragma('journal_mode', { simple: true })).toBe('delete');
    holder.exec('BEGIN EXCLUSIVE');
    holder.exec('INSERT INTO held VALUES (1)');
    const started = Date.now();
    let failure: unknown;
    try {
      createDb(dbPath);
    } catch (error) {
      failure = error;
    }
    const elapsed = Date.now() - started;
    holder.exec('ROLLBACK');
    holder.close();
    expect(failure).toEqual(
      expect.objectContaining({ code: expect.stringMatching(/^SQLITE_BUSY/) }),
    );
    // It waited for the lock rather than failing at once, and stopped at the bound.
    expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 100);
    expect(elapsed).toBeLessThan(BOUND_MS + 1000);
  }, 20_000);
});
