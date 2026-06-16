import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database, { type Database as BetterSQLiteClient } from 'better-sqlite3';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
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
 * `ADD COLUMN IF NOT EXISTS`, so we probe `PRAGMA table_info` first. Used for
 * additive, backward-compatible schema evolution on durable DBs created by an
 * earlier version (no destructive migration framework exists yet).
 */
function addColumnIfMissing(
  client: BetterSQLiteClient,
  table: string,
  column: string,
  type: string,
): void {
  const columns = client.pragma(`table_info(${table})`) as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  client.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * Create a database connection and ensure tables exist.
 *
 * @param dbPath - Path to the SQLite database file, or ':memory:' for in-memory
 */
export function createDb(dbPath: string): InboxDb {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

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

  db.run(sql`
    CREATE TABLE IF NOT EXISTS monitor_state (
      monitor_id TEXT PRIMARY KEY,
      last_observation_at INTEGER,
      last_fingerprint TEXT,
      source_state TEXT NOT NULL DEFAULT '{}',
      notify_state TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS observation_history (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      observation_data TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

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
      query_scope TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )
  `);

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

  return db as unknown as InboxDb;
}
