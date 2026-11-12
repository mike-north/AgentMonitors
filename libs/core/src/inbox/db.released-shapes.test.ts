/**
 * Opening a database written by any released version must succeed without losing
 * event or snapshot data (issue #569, spec 002 §5.2 and §15).
 *
 * The materialization-order rebuild adds a private `sequence` key to
 * `monitor_events` and `monitor_snapshots`. Every released version wrote those
 * tables without it, so every upgraded database takes the rebuild. These
 * fixtures reproduce the table layouts the released versions created:
 *
 *  - 0.0.1–0.3.0: `monitor_events.event_kind TEXT NOT NULL` (later removed from
 *    the schema without a migration), no `baseline_strategy`;
 *  - 0.4.0–0.8.0: no `event_kind`, no `baseline_strategy`;
 *  - 0.9.0–0.13.0: `baseline_strategy` added in place.
 *
 * No released version created an explicit index on either table; an index exists
 * only when an operator or another tool added one. A legacy-only column that such
 * an index references is the case that used to roll the whole open back, on every
 * open. The rebuild now carries columns the current schema does not define, so
 * their values, and every index and trigger that reads them, survive.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.2 (legacy rebuild), §15
 * @see https://www.sqlite.org/pragma.html#pragma_table_xinfo
 * @see https://www.sqlite.org/lang_altertable.html#otheralter
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from './db.js';

const sql = String.raw;

const tempRoots: string[] = [];
/** Every native connection opened in a test, including ones `createDb` opens and then throws from. */
const nativeClients = new Set<Database.Database>();

beforeEach(() => {
  const nativePragma = Database.prototype.pragma;
  vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
    this: Database.Database,
    ...args: Parameters<Database.Database['pragma']>
  ) {
    nativeClients.add(this);
    return nativePragma.apply(this, args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const client of nativeClients) {
    if (client.open) client.close();
  }
  nativeClients.clear();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-shapes-'));
  tempRoots.push(root);
  return path.join(root, 'inbox.db');
}

function rawClient(dbPath: string): Database.Database {
  const client = new Database(dbPath);
  nativeClients.add(client);
  return client;
}

/** The public `InboxDb` hides native access; only schema fixtures inspect SQLite directly. */
function openWithCurrentCode(dbPath: string): Database.Database {
  const client = (createDb(dbPath) as unknown as { $client: Database.Database })
    .$client;
  nativeClients.add(client);
  return client;
}

/** Fixed observation times for seeded rows (never `Date.now()` in test data). */
const OBSERVED_AT = 1793534400;

/** `monitor_events` as created by 0.0.1–0.3.0 (release commits 8f7d35bd … cd6b00e1). */
const EVENTS_0_0_1 = sql`
  CREATE TABLE monitor_events (
    id TEXT PRIMARY KEY,
    workspace_path TEXT,
    monitor_id TEXT NOT NULL,
    source_name TEXT NOT NULL,
    event_kind TEXT NOT NULL,
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
`;

/** `monitor_events` as created by 0.4.0–0.8.0 (release commits 20d75aa0 … fa1d4f4e). */
const EVENTS_0_4_0 = EVENTS_0_0_1.replace('event_kind TEXT NOT NULL,', '');

/** `monitor_events` as created by 0.9.0–0.13.0 (release commits 7c508d24 … a6445551). */
const EVENTS_0_9_0 = EVENTS_0_4_0.replace(
  'object_key TEXT,',
  'object_key TEXT, baseline_strategy TEXT,',
);

/** `monitor_snapshots` as every released version (0.0.1–0.13.0) created it. */
const SNAPSHOTS_RELEASED = sql`
  CREATE TABLE monitor_snapshots (
    id TEXT PRIMARY KEY,
    workspace_path TEXT,
    monitor_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`;

/** Every column carries a distinct non-default value so a dropped or reset column is visible. */
function eventRow(
  index: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `01M6BSHAPE00000000000000E${index}`,
    workspace_path: index % 2 === 0 ? null : `/workspace-${index}`,
    monitor_id: `monitor-${index}`,
    source_name: `source-${index}`,
    urgency: index % 2 === 0 ? 'high' : 'low',
    title: `title ${index}`,
    body: `body ${index}`,
    summary: `summary ${index}`,
    payload: JSON.stringify({ n: index }),
    snapshot_metadata: JSON.stringify({ m: index }),
    snapshot_text: `snapshot ${index}`,
    diff_text: `diff ${index}`,
    object_key: `object-${index}`,
    query_scope: JSON.stringify({ q: index }),
    tags: JSON.stringify([`tag-${index}`]),
    created_at: OBSERVED_AT + index,
    ...extra,
  };
}

function snapshotRow(
  index: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `01M6BSHAPE00000000000000S${index}`,
    workspace_path: index % 2 === 0 ? null : `/workspace-${index}`,
    monitor_id: `monitor-${index}`,
    object_key: `object-${index}`,
    event_id: `01M6BSHAPE00000000000000E${index}`,
    content: `content ${index}`,
    created_at: OBSERVED_AT + index,
    ...extra,
  };
}

function insertRows(
  client: Database.Database,
  table: string,
  rows: readonly Record<string, unknown>[],
): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    client
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
          .map((column) => `@${column}`)
          .join(', ')})`,
      )
      .run(row);
  }
}

interface IReleasedShape {
  /** Release range and the commits that produced the layout. */
  name: string;
  eventsDDL: string;
  snapshotsDDL: string;
  /** Operator-added objects (indexes, triggers) layered on the released layout. */
  extraDDL?: string;
  events: Record<string, unknown>[];
  snapshots: Record<string, unknown>[];
}

const SHAPES: readonly IReleasedShape[] = [
  {
    name: '0.0.1–0.3.0 with event_kind',
    eventsDDL: EVENTS_0_0_1,
    snapshotsDDL: SNAPSHOTS_RELEASED,
    events: [1, 2].map((n) => eventRow(n, { event_kind: `kind-${n}` })),
    snapshots: [1, 2].map((n) => snapshotRow(n)),
  },
  {
    name: '0.0.1–0.3.0 with an index on the legacy-only event_kind column',
    eventsDDL: EVENTS_0_0_1,
    snapshotsDDL: SNAPSHOTS_RELEASED,
    extraDDL: sql`
      CREATE INDEX operator_events_by_kind ON monitor_events (event_kind, created_at);
    `,
    events: [1, 2, 3].map((n) => eventRow(n, { event_kind: `kind-${n}` })),
    snapshots: [1, 2].map((n) => snapshotRow(n)),
  },
  {
    name: '0.4.0–0.8.0',
    eventsDDL: EVENTS_0_4_0,
    snapshotsDDL: SNAPSHOTS_RELEASED,
    events: [1, 2].map((n) => eventRow(n)),
    snapshots: [1, 2].map((n) => snapshotRow(n)),
  },
  {
    name: '0.9.0–0.13.0',
    eventsDDL: EVENTS_0_9_0,
    snapshotsDDL: SNAPSHOTS_RELEASED,
    events: [1, 2].map((n) =>
      eventRow(n, { baseline_strategy: n % 2 === 0 ? 'net' : null }),
    ),
    snapshots: [1, 2].map((n) => snapshotRow(n)),
  },
  {
    name: '0.9.0–0.13.0 with operator columns, indexes and a trigger on both tables',
    eventsDDL: EVENTS_0_9_0,
    snapshotsDDL: SNAPSHOTS_RELEASED,
    extraDDL: sql`
      ALTER TABLE monitor_events ADD COLUMN triage_note TEXT;
      ALTER TABLE monitor_events ADD COLUMN triage_rank INTEGER NOT NULL DEFAULT 7;
      ALTER TABLE monitor_snapshots ADD COLUMN content_digest BLOB;
      CREATE UNIQUE INDEX operator_events_rank ON monitor_events (triage_rank, id);
      CREATE INDEX operator_events_note ON monitor_events (lower(triage_note))
        WHERE triage_note IS NOT NULL;
      CREATE INDEX operator_snapshots_digest ON monitor_snapshots (content_digest);
      CREATE TABLE operator_audit (event_id TEXT, note TEXT);
      CREATE TRIGGER operator_note_audit AFTER UPDATE OF triage_note ON monitor_events
        BEGIN INSERT INTO operator_audit VALUES (NEW.id, NEW.triage_note); END;
    `,
    events: [1, 2].map((n) =>
      eventRow(n, {
        baseline_strategy: 'incremental',
        triage_note: n === 1 ? `Note ${n}` : null,
        triage_rank: n * 10,
      }),
    ),
    snapshots: [1, 2].map((n) =>
      snapshotRow(n, { content_digest: Buffer.from([n, 0xff, n]) }),
    ),
  },
];

/** Look up a fixture by its release range, failing loudly on a typo. */
function shapeNamed(name: string): IReleasedShape {
  const shape = SHAPES.find((candidate) => candidate.name === name);
  if (!shape) throw new Error(`no released-shape fixture named ${name}`);
  return shape;
}

/** Write the layout and rows a released version left on disk. */
function seedReleasedShape(dbPath: string, shape: IReleasedShape): void {
  const client = rawClient(dbPath);
  client.exec(`${shape.eventsDDL}; ${shape.snapshotsDDL};`);
  if (shape.extraDDL) client.exec(shape.extraDDL);
  insertRows(client, 'monitor_events', shape.events);
  insertRows(client, 'monitor_snapshots', shape.snapshots);
  client.close();
}

/** The explicit (non-automatic) indexes and triggers defined on a table, with exact stored SQL. */
function explicitSchemaObjects(
  client: Database.Database,
): { type: string; name: string; sql: string }[] {
  return client
    .prepare<[], { type: string; name: string; sql: string }>(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE type IN ('index', 'trigger') AND sql IS NOT NULL
         AND tbl_name IN ('monitor_events', 'monitor_snapshots')
       ORDER BY type, name`,
    )
    .all();
}

function rowsByRowid(
  client: Database.Database,
  table: string,
): Record<string, unknown>[] {
  return client
    .prepare<
      [],
      Record<string, unknown>
    >(`SELECT * FROM ${table} ORDER BY rowid`)
    .all();
}

describe('opening a database written by a released version (#569)', () => {
  it.each(SHAPES)('opens $name and keeps every row and value', (shape) => {
    const dbPath = tempDbPath();
    seedReleasedShape(dbPath, shape);
    const original = rawClient(dbPath);
    const objectsBefore = explicitSchemaObjects(original);
    const eventsBefore = rowsByRowid(original, 'monitor_events');
    const snapshotsBefore = rowsByRowid(original, 'monitor_snapshots');
    original.close();

    const migrated = openWithCurrentCode(dbPath);

    // Every seeded value survives in its own column; the only additions are the
    // private order key (rowid order, 002 §5.2) and columns added after it.
    const eventsAfter = rowsByRowid(migrated, 'monitor_events');
    expect(eventsAfter).toHaveLength(shape.events.length);
    eventsAfter.forEach((row, index) => {
      expect(row).toMatchObject(eventsBefore[index] ?? {});
      expect(row['sequence']).toBe(index + 1);
    });
    const snapshotsAfter = rowsByRowid(migrated, 'monitor_snapshots');
    expect(snapshotsAfter).toHaveLength(shape.snapshots.length);
    snapshotsAfter.forEach((row, index) => {
      expect(row).toMatchObject(snapshotsBefore[index] ?? {});
      expect(row['sequence']).toBe(index + 1);
    });

    // Indexes and triggers that applied before the rebuild apply after it, with
    // their exact stored SQL.
    expect(explicitSchemaObjects(migrated)).toEqual(objectsBefore);
    expect(migrated.pragma('integrity_check', { simple: true })).toBe('ok');

    // The current writer can still insert: a carried legacy column never keeps
    // a NOT NULL it has no default for (the current code does not write it).
    migrated
      .prepare(
        `INSERT INTO monitor_events (id, monitor_id, source_name, urgency, title, created_at)
         VALUES ('01M6BSHAPE0000000000000NEW', 'm', 's', 'normal', 't', ?)`,
      )
      .run(OBSERVED_AT + 100);
    migrated
      .prepare(
        `INSERT INTO monitor_snapshots (id, monitor_id, object_key, event_id, content, created_at)
         VALUES ('01M6BSHAPE0000000000000NEW', 'm', 'o', '01M6BSHAPE0000000000000NEW', 'c', ?)`,
      )
      .run(OBSERVED_AT + 100);
    migrated.close();

    // Reopening is a no-op: nothing is rebuilt twice.
    const reopened = openWithCurrentCode(dbPath);
    expect(rowsByRowid(reopened, 'monitor_events')).toHaveLength(
      shape.events.length + 1,
    );
    expect(explicitSchemaObjects(reopened)).toEqual(objectsBefore);
  });

  it('carries a legacy-only column with its declared type and default, relaxing a NOT NULL that has no default', () => {
    const dbPath = tempDbPath();
    seedReleasedShape(dbPath, {
      ...shapeNamed('0.0.1–0.3.0 with event_kind'),
      extraDDL: sql`
        ALTER TABLE monitor_events ADD COLUMN triage_rank INTEGER NOT NULL DEFAULT 7;
      `,
    });

    const migrated = openWithCurrentCode(dbPath);
    const columns = migrated
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: unknown }
      >('PRAGMA table_xinfo(monitor_events)')
      .all();
    expect(columns.find((c) => c.name === 'event_kind')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    });
    expect(columns.find((c) => c.name === 'triage_rank')).toMatchObject({
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '7',
    });
    // Current-schema columns keep their current definitions.
    expect(columns.find((c) => c.name === 'monitor_id')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
    });
  });
});

describe('a materialization-order rebuild that cannot complete (#569)', () => {
  /** Captures what a fresh reader sees, to prove the failed open changed nothing. */
  function durableState(dbPath: string) {
    const client = rawClient(dbPath);
    try {
      return {
        schema: client
          .prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name')
          .all(),
        events: rowsByRowid(client, 'monitor_events'),
        snapshots: rowsByRowid(client, 'monitor_snapshots'),
      };
    } finally {
      client.close();
    }
  }

  it('names the table and column when a retained row has no value for a required column', () => {
    const dbPath = tempDbPath();
    seedReleasedShape(dbPath, shapeNamed('0.9.0–0.13.0'));
    // A released `id TEXT PRIMARY KEY` accepts NULL (a SQLite quirk); the current
    // schema requires `id NOT NULL`, so this row cannot be carried.
    const legacy = rawClient(dbPath);
    insertRows(legacy, 'monitor_events', [eventRow(3, { id: null })]);
    legacy.close();
    const before = durableState(dbPath);

    let caught: unknown;
    try {
      createDb(dbPath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'SchemaMigrationError',
      table: 'monitor_events',
      column: 'id',
    });
    expect((caught as Error).message).toMatch(/monitor_events/);
    expect((caught as Error).message).toMatch(/"id"/);
    expect(durableState(dbPath)).toEqual(before);
  });

  it('names the table and column when a legacy column cannot be carried', () => {
    const dbPath = tempDbPath();
    seedReleasedShape(dbPath, shapeNamed('0.9.0–0.13.0'));
    const legacy = rawClient(dbPath);
    legacy.exec(sql`
      ALTER TABLE monitor_snapshots
        ADD COLUMN content_length INTEGER GENERATED ALWAYS AS (length(content)) VIRTUAL;
      CREATE INDEX operator_snapshots_length ON monitor_snapshots (content_length);
    `);
    legacy.close();
    const before = durableState(dbPath);

    let caught: unknown;
    try {
      createDb(dbPath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'SchemaMigrationError',
      table: 'monitor_snapshots',
      column: 'content_length',
    });
    expect((caught as Error).message).toMatch(/monitor_snapshots/);
    expect((caught as Error).message).toMatch(/"content_length"/);
    expect(durableState(dbPath)).toEqual(before);
  });
});
