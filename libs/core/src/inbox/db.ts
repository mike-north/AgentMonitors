import path from 'node:path';
import Database, { type Database as BetterSQLiteClient } from 'better-sqlite3';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  ensurePrivateDir,
  PRIVATE_FILE_MODE,
  resetVerifiedPathCachesForTest,
  restrictExistingPathMode,
  withRestrictedUmask,
} from '../security/local-permissions.js';
import * as schema from './schema.js';

type InternalInboxDb = BetterSQLite3Database<typeof schema> & {
  $client: BetterSQLiteClient;
};

declare const inboxDbBrand: unique symbol;

export interface InboxDb {
  readonly [inboxDbBrand]: true;
}

/**
 * Add `column` (`type`) to `table` if it does not already exist. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so we probe with {@link tableHasColumn} first. Used
 * for additive, backward-compatible schema evolution on durable DBs created by an
 * earlier version (no destructive migration framework exists yet).
 *
 * The `ALTER` is guarded against a "duplicate column name" race: `createDb` is
 * called unguarded from every CLI entry point, so a concurrent first-open could
 * add the column between our check and the `ALTER`. We run inside an immediate
 * transaction ({@link buildDb}) to serialize that, but treat the duplicate-column
 * error as benign anyway — iff the column now exists.
 */
function addColumnIfMissing(
  client: BetterSQLiteClient,
  table: string,
  column: string,
  type: string,
): void {
  if (tableHasColumn(client, table, column)) return;
  try {
    client.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (error) {
    // A racing opener won the ALTER first; the column is present now, so our
    // add is satisfied. Any other failure is real and must propagate.
    if (!tableHasColumn(client, table, column)) throw error;
  }
}

/** True if `table` exists in this database. */
function tableExists(client: BetterSQLiteClient, table: string): boolean {
  const row = client
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row !== undefined;
}

/** True if `table` exists and has a column named `column`. */
function tableHasColumn(
  client: BetterSQLiteClient,
  table: string,
  column: string,
): boolean {
  if (!tableExists(client, table)) return false;
  const columns = client.pragma(`table_info(${table})`) as { name: string }[];
  return columns.some((c) => c.name === column);
}

/**
 * SQLite file suffixes whose modes we restrict alongside the main database
 * file. `-wal` / `-shm` are created by SQLite itself in WAL mode; `-journal`
 * appears if a connection ever falls back to rollback journaling. Each may
 * contain the same private snapshot/event data as the main file.
 */
const SQLITE_ARTIFACT_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

/**
 * Database paths whose artifact modes have already been tightened this process.
 * Spec 002 §3.1 requires tightening once per *startup* (one process); caching
 * lets a re-`createDb` on the same path in a long-lived process skip the
 * per-suffix `lstat`/`open`/`fchmod` cycles. Tests simulating a second startup
 * in one process clear it via {@link resetSqliteArtifactModeCacheForTest}.
 */
const verifiedSqlitePaths = new Set<string>();

/**
 * Tighten the mode of the SQLite database and its sidecar files to owner-only
 * (`0600`). Called after schema setup to (a) migrate a database created by an
 * earlier version under a permissive umask (issue #292) and (b) belt-and-braces
 * cover any sidecar SQLite created outside the restricted-umask window.
 */
function restrictSqliteArtifactModes(dbPath: string): void {
  if (verifiedSqlitePaths.has(dbPath)) return;
  for (const suffix of SQLITE_ARTIFACT_SUFFIXES) {
    restrictExistingPathMode(`${dbPath}${suffix}`, PRIVATE_FILE_MODE);
  }
  verifiedSqlitePaths.add(dbPath);
}

/**
 * Test-only: clear the per-process verified-path caches (this module's SQLite
 * cache and the shared directory cache in `local-permissions`) so a test that
 * re-opens the same on-disk database to prove tighten-on-startup migration —
 * something that is a fresh process in production — re-runs the tightening.
 * Not re-exported from the package entry point; imported directly by tests.
 */
export function resetSqliteArtifactModeCacheForTest(): void {
  verifiedSqlitePaths.clear();
  resetVerifiedPathCachesForTest();
}

/**
 * Create a database connection and ensure tables exist.
 *
 * On-disk databases are created owner-only (issue #292): the containing
 * directory is forced to `0700`, and the database file plus its WAL/SHM sidecars
 * to `0600`. The open + schema build runs under a restricted (`0o077`) umask so
 * files SQLite creates itself are private from birth, then existing artifacts are
 * re-tightened so a database from an earlier, world-readable version is migrated
 * forward on the next open.
 *
 * @param dbPath - Path to the SQLite database file, or ':memory:' for in-memory
 */
export function createDb(dbPath: string): InboxDb {
  const inMemory = dbPath === ':memory:';
  if (!inMemory) {
    ensurePrivateDir(path.dirname(dbPath));
  }
  const db = inMemory
    ? buildDb(dbPath)
    : withRestrictedUmask(() => buildDb(dbPath));
  if (!inMemory) {
    restrictSqliteArtifactModes(dbPath);
  }
  return db;
}

/**
 * Open the SQLite connection and materialize the schema. Extracted from
 * {@link createDb} so the whole synchronous open+build can run inside a
 * restricted-umask window for on-disk databases.
 */
function buildDb(dbPath: string): InboxDb {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Wait for a concurrent first-open's migration transaction to commit rather
  // than failing with SQLITE_BUSY (see `buildSchema`'s immediate transaction).
  sqlite.pragma('busy_timeout = 5000');

  /*
   * This cast is deliberate.
   *
   * Drizzle returns a schema-parameterized database type here:
   * `BetterSQLite3Database<typeof schema> & { $client: ... }`.
   *
   * That exact public type is fine for TypeScript, but it causes API Extractor
   * to either emit forgotten-export warnings or fail outright when generating
   * declaration rollups, because the rolled-up public surface ends up depending
   * on the local schema module symbol.
   *
   * We therefore erase the schema generic at the public alias boundary and cast
   * the concrete Drizzle instance to an opaque `InboxDb`. This keeps the runtime
   * type correct, preserves the methods we use internally via `asInternalDb()`,
   * and allows declaration rollups to avoid leaking Drizzle's schema-parameterized
   * types into consumer-facing `.d.ts` output.
   */
  const db = drizzle(sqlite, { schema }) as unknown as InternalInboxDb;

  // Serialize the whole schema build + migrations under a single immediate
  // transaction. `createDb` runs unguarded from every CLI entry point against
  // the same default DB, so two processes can first-open concurrently, and the
  // check-then-DROP/ALTER migration sequences are individually non-atomic.
  // `BEGIN IMMEDIATE` makes a second opener wait (up to the busy_timeout) for
  // the first to commit and then observe the already-migrated schema — so it
  // cannot double-DROP a just-migrated table or race an ALTER into a
  // "duplicate column name" error.
  sqlite
    .transaction(() => {
      buildSchema(db, sqlite);
    })
    .immediate();

  return db as unknown as InboxDb;
}

/**
 * Create every table and run the additive / re-baseline migrations. Invoked
 * inside {@link buildDb}'s immediate transaction so the whole thing is atomic
 * against a concurrent first-open.
 */
function buildSchema(db: InternalInboxDb, sqlite: BetterSQLiteClient): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      monitor_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      urgency TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      snapshot TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      acked_at INTEGER,
      completed_at INTEGER
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      adapter TEXT NOT NULL,
      host_session_id TEXT NOT NULL,
      agent_identity TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'lead',
      workspace_path TEXT,
      hook_state_path TEXT NOT NULL,
      status TEXT NOT NULL,
      baseline_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      last_recap_at INTEGER,
      dormant_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Workspace-namespacing migration for `monitor_state` (issue #345 / #307).
  // Rebuilds the table under the `(monitor_id, workspace_path)` key while
  // preserving each row's durable `notify_state` batch — see
  // `migrateMonitorStateToWorkspaceScope` for why `source_state` (and only
  // `source_state`) is reset.
  migrateMonitorStateToWorkspaceScope(db, sqlite);

  // Ephemeral (agent-declared, session-scoped) monitors (007 §4). Additive —
  // a brand-new table, so a durable DB from an earlier version simply gains it
  // on the next open. Keyed to the declaring session; survives a daemon restart
  // while that session lives (007 §4.4, BP1).
  db.run(sql`
    CREATE TABLE IF NOT EXISTS ephemeral_monitors (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_path TEXT,
      source_name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '{}',
      urgency TEXT NOT NULL,
      urgency_max TEXT NOT NULL,
      instruction TEXT NOT NULL DEFAULT '',
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      reaped_at INTEGER
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS observation_history (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      workspace_path TEXT,
      source_name TEXT NOT NULL,
      observation_data TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Additive migration (issue #345 / #307): an `observation_history` table created
  // before workspace namespacing lacks `workspace_path`. Add it if missing so
  // post-upgrade rows are scoped; legacy rows keep NULL and simply fall out of any
  // workspace-scoped history/explain query (a soft one-time reset of the audit
  // trail, consistent with the monitor_state re-baseline above).
  addColumnIfMissing(sqlite, 'observation_history', 'workspace_path', 'TEXT');

  db.run(sql`
    CREATE TABLE IF NOT EXISTS monitor_events (
      id TEXT PRIMARY KEY,
      workspace_path TEXT,
      monitor_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      urgency TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      snapshot_metadata TEXT NOT NULL DEFAULT '{}',
      snapshot_text TEXT,
      diff_text TEXT,
      object_key TEXT,
      baseline_strategy TEXT,
      query_scope TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )
  `);

  // Additive migration (G10 PR-B, 002 §1.1.7): a `monitor_events` table created
  // before PR-B lacks the persisted `baseline_strategy` column. Add it if
  // missing so the per-recipient `net` collapse can read each event's strategy
  // at claim time; legacy rows keep NULL and are treated as `incremental`.
  addColumnIfMissing(sqlite, 'monitor_events', 'baseline_strategy', 'TEXT');

  db.run(sql`
    CREATE TABLE IF NOT EXISTS monitor_snapshots (
      id TEXT PRIMARY KEY,
      workspace_path TEXT,
      monitor_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS session_event_state (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      first_notified_at INTEGER,
      acknowledged_at INTEGER,
      last_claim_at INTEGER,
      last_claim_lifecycle TEXT,
      interpret_decision TEXT,
      interpret_reason TEXT,
      interpret_digest TEXT,
      net_suppressed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Additive migration (G14, 002 §1.1.8): a `session_event_state` table created
  // by an earlier version lacks the per-recipient Interpret columns. `CREATE
  // TABLE IF NOT EXISTS` will not add them, so add each missing column to keep
  // pre-existing durable DBs forward-compatible (restart-safety, BP1).
  addColumnIfMissing(
    sqlite,
    'session_event_state',
    'interpret_decision',
    'TEXT',
  );
  addColumnIfMissing(sqlite, 'session_event_state', 'interpret_reason', 'TEXT');
  addColumnIfMissing(sqlite, 'session_event_state', 'interpret_digest', 'TEXT');

  // Per-recipient baseline cursor + per-recipient delta (G10, 002 §1.1.2).
  db.run(sql`
    CREATE TABLE IF NOT EXISTS session_object_cursor (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      monitor_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      workspace_path TEXT,
      baseline_snapshot_id TEXT,
      baseline_content TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    )
  `);

  // Unique on the cursor key. SQLite treats NULLs as DISTINCT in a UNIQUE index,
  // which would let duplicate cursors accumulate for global (NULL-workspace)
  // sessions; `COALESCE(workspace_path, '')` collapses the NULL case so a global
  // recipient gets exactly one cursor per (session, monitor, object).
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_object_cursor_key
      ON session_object_cursor (
        session_id, monitor_id, object_key, COALESCE(workspace_path, '')
      )
  `);

  // Additive migration (G10, 002 §1.1.2): a `session_event_state` table created
  // before G10 lacks the per-recipient `diff_text` column. Add it if missing so
  // pre-existing durable DBs stay forward-compatible; legacy rows keep a NULL
  // here and delivery/explain fall back to the shared `monitor_events.diff_text`.
  addColumnIfMissing(sqlite, 'session_event_state', 'diff_text', 'TEXT');

  // Additive migration (G10 PR-B, 002 §1.1.7): a `session_event_state` table
  // created before PR-B lacks the per-recipient `net`-collapse suppression
  // marker. Add it if missing; legacy rows keep NULL (never net-suppressed).
  addColumnIfMissing(
    sqlite,
    'session_event_state',
    'net_suppressed_at',
    'INTEGER',
  );
}

/**
 * A legacy `monitor_state` row (keyed by `monitor_id` ALONE — its PRIMARY KEY,
 * no `workspace_path` column), read before the table is rebuilt so its durable
 * `notify_state` batch can be carried forward.
 */
interface LegacyMonitorStateRow {
  monitor_id: string;
  last_observation_at: number | null;
  notify_state: string;
  updated_at: number;
}

/**
 * Rebuild `monitor_state` under the `(monitor_id, workspace_path)` key
 * (issue #345 / #307).
 *
 * A table created before workspace namespacing keyed rows by `monitor_id` alone,
 * so SQLite cannot add the surrogate `id` PK the scoped schema needs without a
 * table rebuild. The rebuild is NOT a blanket drop: legacy rows' durable
 * `notify_state` batches are salvaged and re-inserted, attributed to their
 * workspace (see {@link reinsertLegacyMonitorState}). Only `source_state` is
 * reset. Runs inside {@link buildSchema}'s immediate transaction.
 */
function migrateMonitorStateToWorkspaceScope(
  db: InternalInboxDb,
  sqlite: BetterSQLiteClient,
): void {
  // Read every legacy row BEFORE any drop so nothing durable is lost. A legacy
  // table is one that exists but lacks the `workspace_path` column.
  const legacyRows =
    tableExists(sqlite, 'monitor_state') &&
    !tableHasColumn(sqlite, 'monitor_state', 'workspace_path')
      ? (sqlite
          .prepare(
            `SELECT monitor_id, last_observation_at, notify_state, updated_at
               FROM monitor_state`,
          )
          .all() as LegacyMonitorStateRow[])
      : null;

  if (legacyRows) {
    sqlite.exec('DROP TABLE monitor_state');
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS monitor_state (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      workspace_path TEXT,
      last_observation_at INTEGER,
      last_fingerprint TEXT,
      source_state TEXT NOT NULL DEFAULT '{}',
      notify_state TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )
  `);

  // Unique on the workspace-scoped state key. SQLite treats NULLs as DISTINCT in
  // a UNIQUE index, which would let duplicate rows accumulate for global
  // (NULL-workspace) monitors; `COALESCE(workspace_path, '')` collapses the NULL
  // case so each `(monitor_id, workspace)` scope holds exactly one row. Mirrors
  // `session_object_cursor` (issue #345 / #307).
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_state_key
      ON monitor_state (monitor_id, COALESCE(workspace_path, ''))
  `);

  if (legacyRows) {
    reinsertLegacyMonitorState(sqlite, legacyRows);
  }
}

/**
 * Re-insert legacy `monitor_state` rows into the workspace-scoped table.
 *
 * `source_state` is RESET (`{}`): a pre-namespacing row keyed by `monitor_id`
 * alone cannot have its source-plugin change-detection baseline safely
 * attributed to one workspace (several workspaces sharing one global DB
 * clobbered each other on that id), so every monitor re-baselines cleanly on its
 * first post-upgrade tick — no spurious created/deleted/descoped events.
 *
 * The durable `notify_state` batch is NOT diagnostic and is NOT dropped:
 * `pendingDebounce`/`pendingRollup` hold ALREADY-DETECTED observations the
 * runtime MUST redeliver after a restart (002 §4.4, issue #109); dropping them
 * is silent, permanent event loss (the next tick re-baselines and never
 * re-detects those changes). Each batched observation carries its monitor's
 * `filePath`, from which its workspace is derived, so a batch is split across
 * correctly-scoped rows and hydrated by the next tick of each workspace. A row
 * with no pending batch is simply not re-inserted — there is nothing durable to
 * preserve, and the empty state re-baselines identically.
 */
function reinsertLegacyMonitorState(
  sqlite: BetterSQLiteClient,
  legacyRows: LegacyMonitorStateRow[],
): void {
  const insert = sqlite.prepare(
    `INSERT INTO monitor_state
       (id, monitor_id, workspace_path, last_observation_at,
        last_fingerprint, source_state, notify_state, updated_at)
     VALUES (?, ?, ?, ?, NULL, '{}', ?, ?)`,
  );
  for (const row of legacyRows) {
    for (const [workspacePath, notifyState] of partitionNotifyStateByWorkspace(
      row.notify_state,
    )) {
      insert.run(
        ulid(),
        row.monitor_id,
        workspacePath,
        row.last_observation_at,
        JSON.stringify(notifyState),
        row.updated_at,
      );
    }
  }
}

/** A durable notify batch (subset of `NotifyRuntimeState`) after partitioning. */
interface PartitionedNotifyState {
  suppressedUntil?: string;
  rollupLastFiredMinute?: number;
  pendingDebounce?: { observations: unknown[]; dueAt: string };
  pendingRollup?: { observations: unknown[] };
}

/**
 * Split one legacy row's persisted `notify_state` into per-workspace batches.
 * Returns a map keyed by the workspace each pending observation belongs to
 * (`null` = the global/underivable scope). A row whose batch is empty yields an
 * empty map (nothing to preserve). Row-level guards (`suppressedUntil`,
 * `rollupLastFiredMinute`) are conservatively copied onto every resulting scope.
 */
function partitionNotifyStateByWorkspace(
  raw: string,
): Map<string | null, PartitionedNotifyState> {
  const result = new Map<string | null, PartitionedNotifyState>();
  const parsed = asRecord(safeJsonParse(raw));
  if (!parsed) return result;

  const debounce = asRecord(parsed['pendingDebounce']);
  const rollup = asRecord(parsed['pendingRollup']);
  const debounceObs = debounce ? asArray(debounce['observations']) : [];
  const rollupObs = rollup ? asArray(rollup['observations']) : [];
  if (debounceObs.length === 0 && rollupObs.length === 0) return result;

  const dueAt =
    debounce && typeof debounce['dueAt'] === 'string'
      ? debounce['dueAt']
      : new Date(0).toISOString();
  const suppressedUntil =
    typeof parsed['suppressedUntil'] === 'string'
      ? parsed['suppressedUntil']
      : undefined;
  const rollupLastFiredMinute =
    typeof parsed['rollupLastFiredMinute'] === 'number'
      ? parsed['rollupLastFiredMinute']
      : undefined;

  const scopeFor = (ws: string | null): PartitionedNotifyState => {
    let bucket = result.get(ws);
    if (!bucket) {
      bucket = {};
      if (suppressedUntil !== undefined)
        bucket.suppressedUntil = suppressedUntil;
      if (rollupLastFiredMinute !== undefined) {
        bucket.rollupLastFiredMinute = rollupLastFiredMinute;
      }
      result.set(ws, bucket);
    }
    return bucket;
  };

  for (const observation of debounceObs) {
    const bucket = scopeFor(workspaceOfObservation(observation));
    (bucket.pendingDebounce ??= { observations: [], dueAt }).observations.push(
      observation,
    );
  }
  for (const observation of rollupObs) {
    const bucket = scopeFor(workspaceOfObservation(observation));
    (bucket.pendingRollup ??= { observations: [] }).observations.push(
      observation,
    );
  }
  return result;
}

/** The workspace a persisted observation envelope belongs to, via its monitor's `filePath`. */
function workspaceOfObservation(observation: unknown): string | null {
  const record = asRecord(observation);
  const monitor = record ? asRecord(record['monitor']) : null;
  const filePath =
    monitor && typeof monitor['filePath'] === 'string'
      ? monitor['filePath']
      : null;
  return filePath ? workspaceForMonitorFilePath(filePath) : null;
}

/**
 * Derive the workspace root a monitor belongs to from its `MONITOR.md` path.
 * Project monitors live under `<root>/.claude/monitors/...` (or `.codex`), so the
 * workspace is the parent of the nearest `.claude`/`.codex` ancestor — the same
 * root the daemon's tick loop threads as its `workspacePath`. Falls back to the
 * file's directory when no config dir is present. Mirrors the CLI's
 * `configRootForMonitorFile`; kept local so this core migration takes no CLI dep.
 */
function workspaceForMonitorFilePath(filePath: string): string | null {
  if (filePath.length === 0) return null;
  const resolved = path.resolve(filePath);
  const segments = resolved.split(path.sep);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === '.claude' || segment === '.codex') {
      if (index <= 0) return null;
      return path.dirname(segments.slice(0, index + 1).join(path.sep));
    }
  }
  return path.dirname(resolved);
}

/** Parse JSON, returning `undefined` (not throwing) on malformed input. */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Narrow to a plain string-keyed record (rejects arrays and null). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Narrow to an array, or `[]` for any non-array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
