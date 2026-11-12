/**
 * Database migration contracts, including dependency-safe materialization table
 * rebuilds that preserve retained triggers, rows and logical references.
 *
 * Workspace-namespacing coverage for `monitor_state` and
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from './db.js';
import { RuntimeStore } from '../runtime/store.js';

const tempRoots: string[] = [];
/** Native migration handles remain owned even when createDb throws before returning. */
const migrationClients = new Set<Database.Database>();

function tempDbPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-migrate-'));
  tempRoots.push(root);
  return path.join(root, 'inbox.db');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const client of migrationClients) {
    if (client.open) client.close();
  }
  migrationClients.clear();
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

/** Public identities and reference targets belong to retained input, not migration output. */
const retainedEventId = '01M6BFP5G00000000000000001';
const retainedSnapshotId = '01M6BFP5G00000000000000002';
const retainedSessionId = '01M6BFP5G00000000000000003';
const probeEventId = '01M6BFP5G00000000000000004';
const probeSnapshotId = '01M6BFP5G00000000000000005';

/** Legacy table inputs omit only the private ordering key introduced by materialization migration. */
const legacyEventsDDL = `CREATE TABLE monitor_events (
  id TEXT PRIMARY KEY, workspace_path TEXT, monitor_id TEXT NOT NULL,
  source_name TEXT NOT NULL, urgency TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}', snapshot_metadata TEXT NOT NULL DEFAULT '{}',
  snapshot_text TEXT, diff_text TEXT, object_key TEXT, baseline_strategy TEXT,
  query_scope TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
)`;
const legacySnapshotsDDL = `CREATE TABLE monitor_snapshots (
  id TEXT PRIMARY KEY, workspace_path TEXT, monitor_id TEXT NOT NULL,
  object_key TEXT NOT NULL, event_id TEXT NOT NULL, content TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

/** Native schema rows are input-preservation evidence, including exact stored SQL. */
interface IMigrationSchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Each relationship exercises a trigger that remains valid in the original durable schema. */
type TriggerDependency =
  | 'snapshots-events'
  | 'events-snapshots'
  | 'auxiliary-events'
  | 'auxiliary-snapshots';
interface ITriggerMigrationCase {
  name: string;
  legacy: 'both' | 'events' | 'snapshots' | 'neither';
  dependencies: readonly TriggerDependency[];
  quoted?: boolean;
}

/** SQL identifiers may contain quotes and punctuation; fixture names must retain their exact identity. */
function quoteMigrationIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Public InboxDb deliberately hides native access; only migration fixtures inspect SQLite directly. */
function migrationClient(dbPath: string): Database.Database {
  const client = (createDb(dbPath) as unknown as { $client: Database.Database })
    .$client;
  migrationClients.add(client);
  return client;
}

/** Capture supplied durable input for equality checks; this is not a generated expected-output snapshot. */
function retainedMigrationState(client: Database.Database) {
  const schema = client
    .prepare<
      [],
      IMigrationSchemaObject
    >('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
    .all();
  const data = Object.fromEntries(
    schema
      .filter((row) => row.type === 'table')
      .map((row) => [
        row.name,
        client
          .prepare<
            [],
            Record<string, unknown>
          >(`SELECT * FROM ${quoteMigrationIdentifier(row.name)} ORDER BY rowid`)
          .all(),
      ]),
  );
  const metadata = Object.fromEntries(
    [
      'schema_version',
      'user_version',
      'application_id',
      'journal_mode',
      'foreign_keys',
      'busy_timeout',
      'legacy_alter_table',
      'writable_schema',
      'recursive_triggers',
    ].map((name) => [name, client.pragma(name, { simple: true })]),
  );
  return { schema, data, metadata };
}

/** Seed ordinary rows and references before installing triggers, so any later audit row is an actual side effect. */
function seedTriggerMigration(
  dbPath: string,
  fixture: ITriggerMigrationCase,
): void {
  const client = migrationClient(dbPath);
  if (fixture.legacy === 'both' || fixture.legacy === 'events') {
    client.exec(`DROP TABLE monitor_events; ${legacyEventsDDL}`);
  }
  if (fixture.legacy === 'both' || fixture.legacy === 'snapshots') {
    client.exec(`DROP TABLE monitor_snapshots; ${legacySnapshotsDDL}`);
  }
  client.exec(`
    CREATE INDEX retained_events_scope ON monitor_events(workspace_path, monitor_id, object_key);
    CREATE INDEX retained_snapshots_scope ON monitor_snapshots(workspace_path, monitor_id, object_key);
    CREATE TABLE retained_audit (kind TEXT NOT NULL, ref TEXT NOT NULL, related_count INTEGER NOT NULL);
    CREATE TABLE retained_auxiliary (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO retained_auxiliary VALUES ('aux', 'unchanged');
    PRAGMA user_version=41;
    PRAGMA application_id=534;
  `);
  client
    .prepare(
      `INSERT INTO monitor_events
    (id,workspace_path,monitor_id,source_name,urgency,title,summary,snapshot_text,object_key,baseline_strategy,created_at)
    VALUES (?, '/workspace', 'monitor', 'manual', 'normal', 'retained event', 'original summary', 'original content', 'object', 'net', 1793534400)`,
    )
    .run(retainedEventId);
  client
    .prepare(
      `INSERT INTO monitor_snapshots
    (id,workspace_path,monitor_id,object_key,event_id,content,created_at) VALUES (?, '/workspace', 'monitor', 'object', ?, 'original content',1793534400)`,
    )
    .run(retainedSnapshotId, retainedEventId);
  client
    .prepare(
      `INSERT INTO agent_sessions
    (id,adapter,host_session_id,agent_identity,role,workspace_path,hook_state_path,status,baseline_at,last_active_at,created_at,updated_at)
    VALUES (?, 'fixture','host','fixture','lead','/workspace','/owned/hook.json','active',1793534400,1793534400,1793534400,1793534400)`,
    )
    .run(retainedSessionId);
  client
    .prepare(
      `INSERT INTO session_event_state
    (id,session_id,event_id,diff_text,created_at,updated_at) VALUES ('projection',?,?,'recipient delta',1793534400,1793534400)`,
    )
    .run(retainedSessionId, retainedEventId);
  client
    .prepare(
      `INSERT INTO session_object_cursor
    (id,session_id,monitor_id,object_key,workspace_path,baseline_snapshot_id,baseline_content,updated_at)
    VALUES ('cursor',?,'monitor','object','/workspace',?,'original content',1793534400)`,
    )
    .run(retainedSessionId, retainedSnapshotId);
  client.exec(`CREATE TRIGGER "ordinary event audit" AFTER INSERT ON monitor_events
    BEGIN INSERT INTO retained_audit VALUES ('ordinary-event',NEW.id,0); END`);
  client.exec(`CREATE TRIGGER "ordinary snapshot audit" AFTER INSERT ON monitor_snapshots
    BEGIN INSERT INTO retained_audit VALUES ('ordinary-snapshot',NEW.id,0); END`);
  for (const dependency of fixture.dependencies) {
    const name = fixture.quoted ? `cross "${dependency}"; trigger` : dependency;
    const target = dependency.startsWith('snapshots')
      ? 'monitor_snapshots'
      : dependency.startsWith('events')
        ? 'monitor_events'
        : 'retained_auxiliary';
    const action =
      target === 'retained_auxiliary' ? 'UPDATE OF value' : 'INSERT';
    const source = dependency.endsWith('events')
      ? 'monitor_events'
      : 'monitor_snapshots';
    const condition =
      dependency === 'snapshots-events' ? ' WHERE id=NEW.event_id' : '';
    client.exec(`CREATE TRIGGER ${quoteMigrationIdentifier(name)} AFTER ${action} ON ${target}
      BEGIN INSERT INTO retained_audit SELECT '${dependency}',NEW.id,COUNT(*) FROM ${source}${condition}; END`);
  }
  client.close();
}

/** Exercise retained SQL on real inserts/updates, then undo only the probe work. */
function expectTriggerBehavior(
  client: Database.Database,
  dependencies: readonly TriggerDependency[],
): void {
  client.exec('SAVEPOINT retained_trigger_behavior');
  try {
    client
      .prepare(
        `INSERT INTO monitor_events (id,monitor_id,source_name,urgency,title,created_at)
      VALUES (?,'monitor','manual','normal','probe event',1793534401)`,
      )
      .run(probeEventId);
    client
      .prepare(
        `INSERT INTO monitor_snapshots (id,monitor_id,object_key,event_id,content,created_at)
      VALUES (?,'monitor','object',?,'probe content',1793534401)`,
      )
      .run(probeSnapshotId, probeEventId);
    client.exec("UPDATE retained_auxiliary SET value='probe' WHERE id='aux'");
    const expected = [
      { kind: 'ordinary-event', ref: probeEventId, related_count: 0 },
      { kind: 'ordinary-snapshot', ref: probeSnapshotId, related_count: 0 },
      ...dependencies.map((dependency) => ({
        kind: dependency,
        ref: dependency.startsWith('snapshots')
          ? probeSnapshotId
          : dependency.startsWith('events')
            ? probeEventId
            : 'aux',
        related_count: dependency.startsWith('auxiliary') ? 2 : 1,
      })),
    ].sort((a, b) => a.kind.localeCompare(b.kind));
    expect(
      client
        .prepare(
          'SELECT kind,ref,related_count FROM retained_audit ORDER BY kind',
        )
        .all(),
    ).toEqual(expected);
  } finally {
    client.exec(
      'ROLLBACK TO retained_trigger_behavior; RELEASE retained_trigger_behavior',
    );
  }
}

/** Spec 002 §1.1.7/§5.2 promises exact trigger preservation across the coordinated rebuild. */
describe('materialization migration preserves dependent legacy triggers (#534)', () => {
  const nativeExec = Database.prototype.exec;
  let nativeFailure: 'second-rebuild' | 'trigger-restoration' | undefined;
  let failureBoundary:
    | { eventOrdered: boolean; snapshotOrdered: boolean }
    | undefined;

  beforeEach(() => {
    nativeFailure = undefined;
    failureBoundary = undefined;
    // Delegate every production statement to native SQLite. Fault cases add an actual
    // duplicate-table DDL statement at a chosen boundary, never a fabricated Error.
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      statement: string,
    ) {
      migrationClients.add(this);
      const atSecondRebuild =
        nativeFailure === 'second-rebuild' &&
        statement.includes('CREATE TABLE monitor_snapshots_ordered');
      const atRestoration =
        nativeFailure === 'trigger-restoration' &&
        statement.startsWith('CREATE TRIGGER "ordinary snapshot audit"');
      if (atSecondRebuild || atRestoration) {
        failureBoundary = {
          eventOrdered: this.prepare<[], { name: string }>(
            'PRAGMA table_info(monitor_events)',
          )
            .all()
            .some((row) => row.name === 'sequence'),
          snapshotOrdered: this.prepare<[], { name: string }>(
            'PRAGMA table_info(monitor_snapshots)',
          )
            .all()
            .some((row) => row.name === 'sequence'),
        };
        return nativeExec.call(
          this,
          'CREATE TABLE retained_auxiliary (id TEXT)',
        );
      }
      return nativeExec.call(this, statement);
    });
  });

  const cases: readonly ITriggerMigrationCase[] = [
    {
      name: 'snapshot trigger reading events',
      legacy: 'both',
      dependencies: ['snapshots-events'],
    },
    {
      name: 'event trigger reading snapshots',
      legacy: 'both',
      dependencies: ['events-snapshots'],
    },
    {
      name: 'mutually dependent triggers',
      legacy: 'both',
      dependencies: ['snapshots-events', 'events-snapshots'],
    },
    {
      name: 'third-table trigger reading events',
      legacy: 'both',
      dependencies: ['auxiliary-events'],
    },
    {
      name: 'third-table trigger reading snapshots',
      legacy: 'both',
      dependencies: ['auxiliary-snapshots'],
    },
    { name: 'ordinary non-cross triggers', legacy: 'both', dependencies: [] },
    {
      name: 'quoted cross-trigger names',
      legacy: 'both',
      dependencies: ['snapshots-events', 'events-snapshots'],
      quoted: true,
    },
    {
      name: 'only events require rebuilding',
      legacy: 'events',
      dependencies: ['snapshots-events', 'auxiliary-events'],
    },
    {
      name: 'only snapshots require rebuilding',
      legacy: 'snapshots',
      dependencies: ['events-snapshots', 'auxiliary-snapshots'],
    },
  ];

  it.each(cases)(
    'opens and preserves $name without replaying copied rows',
    (fixture) => {
      const filename = tempDbPath();
      seedTriggerMigration(filename, fixture);
      const original = new Database(filename);
      migrationClients.add(original);
      original.pragma('foreign_keys=ON');
      const before = retainedMigrationState(original);
      expectTriggerBehavior(original, fixture.dependencies);
      expect(retainedMigrationState(original)).toEqual(before);
      original.close();

      // Expected success is derived from retained-trigger compatibility, not the old failure.
      const migrated = migrationClient(filename);
      const after = retainedMigrationState(migrated);
      for (const table of ['monitor_events', 'monitor_snapshots']) {
        expect(
          migrated
            .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => row.name),
        ).toContain('sequence');
        expect(after.data[table]?.map((row) => row['sequence'])).toEqual([1]);
      }
      for (const row of before.schema.filter(
        (row) =>
          row.type === 'trigger' || (row.type === 'index' && row.sql !== null),
      )) {
        expect(
          after.schema.find((candidate) => candidate.name === row.name),
        ).toEqual(row);
      }
      for (const [table, rows] of Object.entries(before.data)) {
        if (table === 'sqlite_sequence') continue;
        const actual = after.data[table];
        expect(
          actual?.map((row) => {
            if (table !== 'monitor_events' && table !== 'monitor_snapshots')
              return row;
            const {
              sequence: _sequence,
              definition_fingerprint: _fingerprint,
              ...publicRow
            } = row;
            return publicRow;
          }),
        ).toEqual(
          rows.map((row) => {
            if (table !== 'monitor_events' && table !== 'monitor_snapshots')
              return row;
            const {
              sequence: _sequence,
              definition_fingerprint: _fingerprint,
              ...publicRow
            } = row;
            return publicRow;
          }),
        );
      }
      for (const [name, value] of Object.entries(before.metadata)) {
        if (name !== 'schema_version')
          expect(after.metadata[name]).toEqual(value);
      }
      expect(after.data['retained_audit']).toEqual([]);
      expect(migrated.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(migrated.pragma('foreign_key_check')).toEqual([]);
      expectTriggerBehavior(migrated, fixture.dependencies);
      expect(retainedMigrationState(migrated)).toEqual(after);
      migrated.close();

      const reopened = migrationClient(filename);
      expect(retainedMigrationState(reopened)).toEqual(after);
      expectTriggerBehavior(reopened, fixture.dependencies);
    },
  );

  it('does not churn retained triggers or schema on an already-current open', () => {
    const filename = tempDbPath();
    const fixture: ITriggerMigrationCase = {
      name: 'current',
      legacy: 'neither',
      dependencies: [
        'snapshots-events',
        'events-snapshots',
        'auxiliary-events',
        'auxiliary-snapshots',
      ],
      quoted: true,
    };
    seedTriggerMigration(filename, fixture);
    const client = migrationClient(filename);
    const before = retainedMigrationState(client);
    expectTriggerBehavior(client, fixture.dependencies);
    client.close();
    const reopened = migrationClient(filename);
    expect(retainedMigrationState(reopened)).toEqual(before);
    expectTriggerBehavior(reopened, fixture.dependencies);
  });

  it.each(['second-rebuild', 'trigger-restoration'] as const)(
    'rolls back every retained object after native DDL failure at %s',
    (boundary) => {
      const filename = tempDbPath();
      seedTriggerMigration(filename, {
        name: 'rollback',
        legacy: 'both',
        dependencies: [],
      });
      const observer = new Database(filename);
      migrationClients.add(observer);
      observer.pragma('foreign_keys=ON');
      const before = retainedMigrationState(observer);
      nativeFailure = boundary;
      let caught: unknown;
      try {
        migrationClient(filename);
      } catch (error) {
        caught = error;
      }
      nativeFailure = undefined;
      expect(caught).toMatchObject({
        name: 'SqliteError',
        code: 'SQLITE_ERROR',
        message: 'table retained_auxiliary already exists',
      });
      expect(failureBoundary).toEqual({
        eventOrdered: true,
        snapshotOrdered: boundary === 'trigger-restoration',
      });
      expect(retainedMigrationState(observer)).toEqual(before);
      observer.close();
      const fresh = new Database(filename);
      migrationClients.add(fresh);
      fresh.pragma('foreign_keys=ON');
      expect(retainedMigrationState(fresh)).toEqual(before);
      expectTriggerBehavior(fresh, []);
      fresh.close();
      // A later successful retry still owns the complete migration and original SQL.
      const recovered = migrationClient(filename);
      expectTriggerBehavior(recovered, []);
    },
  );
});

/**
 * Regression (#451 composed with #534): a database written by the definition
 * fingerprint change before materialization ordering existed has
 * `definition_fingerprint` populated but no `sequence`. The ordering rebuild
 * must carry the column and its values forward; dropping them would silently
 * turn every pending event's fingerprint back to "unknown" (002 §5.3: rows
 * without a fingerprint read as unknown, so staleness detection is lost).
 */
describe('ordering migration keeps definition_fingerprint (#451 + #534)', () => {
  const fingerprintedId = '01M6BFP5G00000000000000010';
  const unfingerprintedId = '01M6BFP5G00000000000000011';

  function seed(filename: string): void {
    const raw = new Database(filename);
    migrationClients.add(raw);
    raw.exec(
      legacyEventsDDL.replace(
        'created_at INTEGER NOT NULL',
        'created_at INTEGER NOT NULL, definition_fingerprint TEXT',
      ),
    );
    const insert = raw.prepare(
      `INSERT INTO monitor_events
         (id, monitor_id, source_name, urgency, title, created_at, definition_fingerprint)
       VALUES (?, 'm', 's', 'normal', 't', 1, ?)`,
    );
    insert.run(fingerprintedId, 'abc123def4567890');
    insert.run(unfingerprintedId, null);
    raw.close();
  }

  it('preserves stored fingerprint values and NULLs when rebuilding for sequence', () => {
    const filename = tempDbPath();
    seed(filename);
    const client = migrationClient(filename);
    const columns = client
      .prepare<[], { name: string }>('PRAGMA table_info(monitor_events)')
      .all()
      .map((c) => c.name);
    expect(columns).toContain('sequence');
    expect(columns.filter((c) => c === 'definition_fingerprint')).toHaveLength(
      1,
    );
    const rows = client
      .prepare<
        [],
        { id: string; definition_fingerprint: string | null }
      >('SELECT id, definition_fingerprint FROM monitor_events ORDER BY sequence')
      .all();
    expect(rows).toEqual([
      { id: fingerprintedId, definition_fingerprint: 'abc123def4567890' },
      { id: unfingerprintedId, definition_fingerprint: null },
    ]);
  });
});
