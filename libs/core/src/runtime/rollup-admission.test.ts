/**
 * Not-due rollup decisions and their durable effects share one writer lock.
 * Owned competing runtimes and independent readers expose stale decisions,
 * checkpoint rewinds, partial admission and interpretation before commit.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type {
  InterpretAdapter,
  InterpretInput,
  InterpretResult,
} from '../adapter/interpret.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationSource } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import { registerRuntimeTransaction } from './runtime-transaction.js';

/** Source polling is due at 08:00/10:00; the independent rollup window is 09:00 UTC. */
const BEFORE = Date.parse('2026-11-01T08:00:00Z');
const WINDOW = Date.parse('2026-11-01T09:00:00Z');
let clockTime = BEFORE;
/** Native Date instances preserve the retry serializer's plain-timestamp invariant. */
const owned: { root: string; clients: BetterSQLiteClient[] }[] = [];
beforeEach(() => {
  clockTime = BEFORE;
  vi.stubGlobal(
    'Date',
    new Proxy(Date, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [clockTime]);
      },
      get(target, key, receiver) {
        return key === 'now'
          ? () => clockTime
          : Reflect.get(target, key, receiver);
      },
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const resource of owned.splice(0)) {
    for (const client of resource.clients) if (client.open) client.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

/** Fault after actual writes so tests require SQLite rollback, not early rejection. */
class RollupFaultStore extends RuntimeStore {
  failState = false;
  failSnapshot = false;
  failOutbox = false;
  override setMonitorState(
    ...args: Parameters<RuntimeStore['setMonitorState']>
  ): void {
    super.setMonitorState(...args);
    if (args[0] === 'rollup' && this.failState) {
      this.failState = false;
      throw new Error('rollup state failed');
    }
  }
  override saveSnapshot(
    input: Parameters<RuntimeStore['saveSnapshot']>[0],
  ): void {
    super.saveSnapshot(input);
    if (this.failSnapshot && input.content === '') {
      this.failSnapshot = false;
      throw new Error('middle snapshot failed');
    }
  }
  override enqueueMaterializationRetries(
    ...args: Parameters<RuntimeStore['enqueueMaterializationRetries']>
  ) {
    const records = super.enqueueMaterializationRetries(...args);
    if (this.failOutbox) {
      this.failOutbox = false;
      throw new Error('rollup suffix failed');
    }
    return records;
  }
}

/** Suspend only the first actual interpretation to expose the outer commit. */
function barrier() {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const calls: InterpretInput[] = [];
  const adapter: InterpretAdapter = {
    name: 'rollup-barrier',
    async interpret(input): Promise<InterpretResult> {
      calls.push(input);
      if (calls.length === 1) {
        entered.resolve(undefined);
        await released.promise;
      }
      return { decision: 'deliver', digest: input.delta };
    },
  };
  return {
    adapter,
    calls,
    entered: entered.promise,
    release: () => released.resolve(undefined),
  };
}

/** Real source acquisition seeds held work; every subsequent assertion exercises not-due ticks. */
async function fixture(empty = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-rollup-admission-'));
  const resource = { root, clients: [] as BetterSQLiteClient[] };
  owned.push(resource);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(path.join(monitorsDir, 'rollup'), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, 'rollup', 'MONITOR.md'),
    `---
name: Rollup
watch:
  type: rollup-source
  interval: 2h
urgency: normal
payload:
  form: prose
baseline-strategy: incremental
notify:
  strategy: rollup
  window: '0 9 * * *'
---
Inspect the changes.
`,
  );
  const dbPath = path.join(root, 'runtime.db');
  const connect = () => {
    const db = createDb(dbPath);
    // InboxDb is deliberately opaque outside storage; the fixture owns every handle.
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    resource.clients.push(client);
    return { db, client };
  };
  const writer = connect();
  const store = new RollupFaultStore(writer.db);
  const interpretation = barrier();
  let observations = 0;
  const source: ObservationSource = {
    name: 'rollup-source',
    scopeSchema: { type: 'object' },
    observe() {
      observations += 1;
      return Promise.resolve({
        observations: empty
          ? []
          : ['alpha', '', 'omega'].map((snapshotText, index) => ({
              title: `step-${String(index + 1)}`,
              summary: `step-${String(index + 1)}`,
              objectKey: 'shared',
              snapshotText,
            })),
        nextState: 'original-source',
      });
    },
  };
  const makeRuntime = (target: RuntimeStore) => {
    const registry = new SourceRegistry();
    registry.register(source);
    registry.register({
      name: 'healthy',
      scopeSchema: { type: 'object' },
      observe: () =>
        Promise.resolve({ observations: [{ title: 'healthy sibling' }] }),
    });
    return new AgentMonitorRuntime(
      target,
      registry,
      [claudeCodeAdapter],
      interpretation.adapter,
    );
  };
  const runtime = makeRuntime(store);
  const sessions = ['a', 'b'].map((hostSessionId) =>
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId,
        workspacePath: root,
      }),
    ),
  );
  const observer = connect();
  const reader = new RuntimeStore(observer.db);
  const initial = await runtime.tick(monitorsDir, root);
  expect(initial.emittedEventIds).toEqual([]);
  const before = reader.getMonitorState('rollup', root);
  return {
    root,
    monitorsDir,
    dbPath,
    writer,
    store,
    reader,
    observer,
    connect,
    makeRuntime,
    runtime,
    sessions,
    interpretation,
    before,
    observations: () => observations,
  };
}

/**
 * Interpose immediately before the window flush's own transaction begins, with
 * no mocked reads or changes to production seams. Each tick first runs the
 * notify-edit reconcile through the same registered runner (`withStoreWriter`);
 * that call is passed through untouched, so the competing commit lands before
 * the flush's BEGIN and can only be seen by a read made under the writer lock.
 * `target: 'edit-drain'` instead fires before that reconcile's own transaction.
 * The returned assertion proves the commit fired at the targeted transaction.
 */
function beforeAdmission(
  f: Awaited<ReturnType<typeof fixture>>,
  competingCommit: () => void,
  target: 'flush' | 'edit-drain' = 'flush',
) {
  let firedAt: string | undefined;
  registerRuntimeTransaction(
    f.store,
    (operation) => {
      const stack = new Error().stack ?? '';
      const isEditDrain = stack.includes('withStoreWriter');
      if (firedAt === undefined && isEditDrain === (target === 'edit-drain')) {
        firedAt = stack;
        competingCommit();
      }
      return f.writer.client.transaction(operation).immediate();
    },
    () => f.writer.client.inTransaction,
  );
  return () => {
    expect(firedAt, 'competing commit never fired').toBeDefined();
    expect(firedAt).toContain(
      target === 'flush' ? 'flushRollupWindow' : 'withStoreWriter',
    );
  };
}

/** The child imports current source using Node 24 type transformation and a confined resolver hook. */
function competingRuntime(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'notdue' | 'due' | 'watch',
) {
  const child = fileURLToPath(
    new URL('./test-fixtures/rollup-writer.mjs', import.meta.url),
  );
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-transform-types',
      child,
      mode,
      f.dbPath,
      f.monitorsDir,
      f.root,
      String(clockTime),
    ],
    {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(output) as {
    result?: { emittedEventIds: string[]; erroredObservations: unknown[] };
    calls: string[];
    ids: string[];
  };
}

/**
 * Notify state after this fixture's window fires: the minute marker plus the
 * private pacing identity (002 §4.6) the seeding poll recorded. A window check
 * neither drops nor rewrites that identity, so an unchanged definition is never
 * mistaken for a policy edit on the next tick.
 */
function firedWindowNotify(f: Awaited<ReturnType<typeof fixture>>) {
  // `policyKey` is private persisted metadata outside NotifyRuntimeState's type.
  const { policyKey } = f.before.notifyState as { policyKey?: unknown };
  expect(typeof policyKey).toBe('string');
  return { policyKey, rollupLastFiredMinute: Math.floor(WINDOW / 60000) };
}

/** No event family or recovery obligation may survive a failed outer admission. */
function expectNoAdmission(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.reader.listEvents({ monitorId: 'rollup' })).toEqual([]);
  expect(f.reader.listMaterializationRetries()).toEqual([]);
  for (const table of [
    'session_event_state',
    'session_object_cursor',
    'monitor_snapshots',
  ]) {
    expect(f.observer.client.prepare(`SELECT * FROM ${table}`).all()).toEqual(
      [],
    );
  }
}

describe('not-due rollup admission', () => {
  for (const mode of ['notdue', 'due', 'watch'] as const) {
    it(`does not duplicate a competing ${mode} runtime's committed window`, async () => {
      const f = await fixture();
      clockTime = WINDOW;
      let competitor: ReturnType<typeof competingRuntime> | undefined;
      const interposed = beforeAdmission(f, () => {
        competitor = competingRuntime(f, mode);
      });
      f.interpretation.release();
      const result = await f.runtime.tick(f.monitorsDir, f.root);
      interposed();
      expect(competitor?.result?.erroredObservations ?? []).toEqual([]);
      expect(result.emittedEventIds).toEqual([]);
      expect(result.erroredObservations).toEqual([]);
      const events = f.reader.listEvents({ monitorId: 'rollup' });
      expect(events.map(({ id }) => id).sort()).toEqual(
        competitor?.ids.slice().sort(),
      );
      expect(events).toHaveLength(mode === 'notdue' ? 3 : 4);
      expect(competitor?.calls).toHaveLength(events.length);
      expect(f.interpretation.calls).toEqual([]);
      for (const session of f.sessions)
        expect(f.reader.listEvents({ sessionId: session.id })).toHaveLength(
          events.length,
        );
      expect(f.reader.listMaterializationRetries()).toEqual([]);
      const state = f.reader.getMonitorState('rollup', f.root);
      expect(state.sourceState).toBe(
        mode === 'notdue' ? 'original-source' : `${mode}-winner`,
      );
      expect(state.lastObservationAt?.getTime()).toBe(
        mode === 'notdue' ? BEFORE : WINDOW,
      );
      expect(state.notifyState).toEqual(firedWindowNotify(f));
      expect(f.observations()).toBe(1);
    });
  }

  for (const fired of [false, true]) {
    it(`uses the locked current checkpoint/time/pending work (window already fired: ${String(fired)})`, async () => {
      const f = await fixture();
      clockTime = WINDOW;
      const first = f.before.notifyState.pendingRollup?.observations[0];
      if (!first) throw new Error('Fixture requires held work');
      const currentTime = new Date(BEFORE + 30 * 60 * 1000);
      const pending = {
        ...first,
        observation: {
          title: 'winner',
          summary: 'winner',
          objectKey: 'winner',
          snapshotText: 'current',
        },
      };
      const currentNotify = {
        pendingRollup: { observations: [pending] },
        ...(fired ? { rollupLastFiredMinute: Math.floor(WINDOW / 60000) } : {}),
      };
      const interposed = beforeAdmission(f, () =>
        f.reader.setMonitorState('rollup', f.root, {
          sourceState: 'newer-source',
          lastObservationAt: currentTime,
          notifyState: currentNotify,
        }),
      );
      f.interpretation.release();
      const result = await f.runtime.tick(f.monitorsDir, f.root);
      interposed();
      expect(result.erroredObservations).toEqual([]);
      const current = f.reader.getMonitorState('rollup', f.root);
      expect(current.sourceState).toBe('newer-source');
      expect(current.lastObservationAt).toEqual(currentTime);
      expect(f.reader.listEvents().map(({ summary }) => summary)).toEqual(
        fired ? [] : ['winner'],
      );
      expect(
        current.notifyState.pendingRollup?.observations.map(
          ({ observation }) => observation.summary,
        ),
      ).toEqual(fired ? ['winner'] : undefined);
      expect(current.notifyState.rollupLastFiredMinute).toBe(
        Math.floor(WINDOW / 60000),
      );
    });
  }

  it('commits the prefix, retained suffix and minute marker before the first Interpret', async () => {
    const f = await fixture();
    clockTime = WINDOW;
    f.store.failSnapshot = true;
    const tick = f.runtime.tick(f.monitorsDir, f.root);
    try {
      await f.interpretation.entered;
      expect(f.interpretation.calls).toHaveLength(1);
      const events = f.reader.listEvents();
      expect(events.map(({ summary }) => summary)).toEqual(['step-1']);
      const retries = f.reader.listMaterializationRetries();
      expect(
        retries.map(({ envelope }) => [
          envelope.observation.summary,
          envelope.observation.snapshotText,
        ]),
      ).toEqual([
        ['step-2', ''],
        ['step-3', 'omega'],
      ]);
      for (const session of f.sessions)
        expect(
          f.reader.listEvents({ sessionId: session.id }).map(({ id }) => id),
        ).toEqual(events.map(({ id }) => id));
      expect(
        f.observer.client
          .prepare('SELECT content, event_id FROM monitor_snapshots')
          .all(),
      ).toEqual([{ content: 'alpha', event_id: events[0]?.id }]);
      expect(f.reader.getMonitorState('rollup', f.root)).toEqual({
        ...f.before,
        notifyState: firedWindowNotify(f),
      });
      expect(
        f.reader
          .listObservationHistory({ monitorId: 'rollup' })
          .filter(({ result }) => result === 'errored'),
      ).toHaveLength(1);
      f.interpretation.release();
      const result = await tick;
      expect(result.emittedEventIds).toEqual(events.map(({ id }) => id));
      expect(result.erroredObservations).toHaveLength(1);
      clockTime += 1000;
      await f
        .makeRuntime(new RuntimeStore(f.connect().db))
        .tick(f.monitorsDir, f.root);
      // The window does not flush again. Its retained suffix, now due, drains
      // on the reopened runtime in its original order, each exactly once
      // (002 §2.6).
      expect(f.reader.listMaterializationRetries()).toEqual([]);
      expect(
        f.observer.client
          .prepare('SELECT id, summary FROM monitor_events ORDER BY sequence')
          .all(),
      ).toEqual([
        { id: events[0]?.id, summary: 'step-1' },
        { id: expect.any(String), summary: 'step-2' },
        { id: expect.any(String), summary: 'step-3' },
      ]);
    } finally {
      f.interpretation.release();
      await tick;
    }
  });

  for (const fault of ['state', 'outbox'] as const) {
    it(`rolls back every admission effect on ${fault} failure and reopens for one successful flush`, async () => {
      const f = await fixture();
      clockTime = WINDOW;
      f.store.failState = fault === 'state';
      f.store.failSnapshot = fault === 'outbox';
      f.store.failOutbox = fault === 'outbox';
      const previousCache = f.store.projectedSessionIdsForLastEvent();
      const failed = await f.runtime.tick(f.monitorsDir, f.root);
      expect(failed.emittedEventIds).toEqual([]);
      expect(failed.erroredObservations).toHaveLength(1);
      expectNoAdmission(f);
      expect(f.reader.getMonitorState('rollup', f.root)).toEqual(f.before);
      expect(f.store.projectedSessionIdsForLastEvent()).toEqual(previousCache);
      expect(f.interpretation.calls).toEqual([]);
      f.interpretation.release();
      clockTime += 1000;
      const reopened = f.makeRuntime(new RuntimeStore(f.connect().db));
      const success = await reopened.tick(f.monitorsDir, f.root);
      expect(success.emittedEventIds).toHaveLength(3);
      expect(f.interpretation.calls).toHaveLength(3);
      expect(f.reader.getMonitorState('rollup', f.root)).toEqual({
        ...f.before,
        notifyState: firedWindowNotify(f),
      });
      const repeated = await reopened.tick(f.monitorsDir, f.root);
      expect(repeated.emittedEventIds).toEqual([]);
      expect(
        f.reader
          .listEvents()
          .map(({ id }) => id)
          .sort(),
      ).toEqual(success.emittedEventIds.slice().sort());
    });
  }

  for (const emptyWindow of [false, true]) {
    it(`isolates non-emitting state failure and avoids empty audit/delivery spam (empty window: ${String(emptyWindow)})`, async () => {
      const f = await fixture(emptyWindow);
      clockTime = emptyWindow ? WINDOW : BEFORE + 30 * 60 * 1000;
      mkdirSync(path.join(f.monitorsDir, 'z-healthy'));
      writeFileSync(
        path.join(f.monitorsDir, 'z-healthy', 'MONITOR.md'),
        '---\nwatch:\n  type: healthy\nurgency: normal\n---\nHealthy sibling',
      );
      f.store.failState = true;
      const beforeHistory = f.reader.listObservationHistory({
        monitorId: 'rollup',
      });
      const result = await f.runtime.tick(f.monitorsDir, f.root);
      expect(result.erroredObservations).toEqual([
        { monitorId: 'rollup', message: 'rollup state failed' },
      ]);
      expect(f.reader.getMonitorState('rollup', f.root)).toEqual(f.before);
      expect(f.reader.listEvents({ monitorId: 'z-healthy' })).toHaveLength(1);
      expect(f.reader.listEvents({ monitorId: 'rollup' })).toEqual([]);
      expect(f.reader.listMaterializationRetries()).toEqual([]);
      expect(f.interpretation.calls).toEqual([]);
      expect(
        f.reader.listObservationHistory({ monitorId: 'rollup' }),
      ).toHaveLength(beforeHistory.length + 1);
      const count = f.reader.listObservationHistory({
        monitorId: 'rollup',
      }).length;
      await f.runtime.tick(f.monitorsDir, f.root);
      expect(
        f.reader.listObservationHistory({ monitorId: 'rollup' }),
      ).toHaveLength(count);
      expect(f.reader.getMonitorState('rollup', f.root)).toEqual(
        emptyWindow
          ? {
              ...f.before,
              notifyState: firedWindowNotify(f),
            }
          : f.before,
      );
    });
  }
});

/**
 * Native SQLite faults end different scopes (002 §2 admission units, §4.4
 * held rollup flush, §10.7 observation history; 003 §2.3 opaque baselines;
 * 004 §3.4). `RAISE(ROLLBACK)` ends the whole owning transaction underneath a
 * nested savepoint, so no retained suffix may outlive the vanished prefix.
 * `RAISE(ABORT)` ends only the failing statement's savepoint, so the prefix
 * commits and the ordered suffix is retained.
 */

/** Durable admission artifacts; best-effort error history is asserted separately. */
const rollupArtifactTables = [
  'monitor_events',
  'monitor_snapshots',
  'session_event_state',
  'session_object_cursor',
  'materialization_retry_outbox',
  'monitor_state',
] as const;

/** Independent full-row reads preserve prior artifacts, not merely row counts. */
function rollupArtifactRows(f: Awaited<ReturnType<typeof fixture>>) {
  return rollupArtifactTables.map((table) =>
    f.observer.client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}

/**
 * Commit one event for another workspace's lead before the fault, so the
 * store's recipient cache and prior rows are non-empty. Its summary collides
 * with the new prefix; the trigger's monitor/workspace predicates must not
 * accept it as proof that the new prefix was written.
 */
function seedPriorRecipient(f: Awaited<ReturnType<typeof fixture>>) {
  const workspacePath = path.join(f.root, 'previous-workspace');
  const session = f.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'previous-rollup-lead',
      workspacePath,
    }),
  );
  const event = f.store.insertEvent({
    workspacePath,
    monitorId: 'previous-monitor',
    sourceName: 'rollup-source',
    urgency: 'normal',
    title: 'Previously committed',
    body: 'Preserve this recipient.',
    summary: 'step-1',
    payload: {},
    snapshotMetadata: {},
    snapshotText: null,
    diffText: null,
    objectKey: null,
    baselineStrategy: 'incremental',
    queryScope: {},
    tags: [],
    createdAt: new Date(BEFORE),
  });
  expect(f.store.projectedSessionIdsForLastEvent()).toEqual([session.id]);
  return { event, session };
}

/**
 * A real trigger on the second held envelope. It first proves the new prefix
 * (event, its snapshot, both lead projections) is visible on the owning
 * connection, i.e. written in the same transaction, then lets SQLite itself
 * raise the requested native conflict resolution.
 */
function installRollupNativeFault(
  f: Awaited<ReturnType<typeof fixture>>,
  action: 'ROLLBACK' | 'ABORT',
): void {
  f.writer.client.exec(`
    CREATE TRIGGER native_rollup_fault BEFORE INSERT ON monitor_events
    WHEN NEW.monitor_id = 'rollup' AND NEW.summary = 'step-2'
    BEGIN
      SELECT CASE WHEN (
        SELECT count(*) FROM monitor_events prefix
        WHERE prefix.monitor_id = NEW.monitor_id
          AND prefix.workspace_path = NEW.workspace_path
          AND prefix.summary = 'step-1'
          AND (SELECT count(*) FROM monitor_snapshots snapshot
            WHERE snapshot.event_id = prefix.id) = 1
          AND (SELECT count(*) FROM session_event_state projection
            WHERE projection.event_id = prefix.id) = 2
      ) != 1 THEN RAISE(ABORT, 'missing new rollup prefix artifacts') END;
      SELECT RAISE(${action}, 'native rollup ${action}');
    END;
  `);
}

/** Errored history rows for the held monitor, in insertion order. */
function erroredHistory(f: Awaited<ReturnType<typeof fixture>>) {
  return f.reader
    .listObservationHistory({ monitorId: 'rollup' })
    .filter(({ result }) => result === 'errored')
    .map(({ observationData }) => observationData);
}

describe('native rollback in held rollup flush', () => {
  it('surfaces a whole-transaction ROLLBACK without residue, then replays the full held span once on reopen', async () => {
    const f = await fixture();
    f.interpretation.release();
    const prior = seedPriorRecipient(f);
    const previousRows = rollupArtifactRows(f);
    const previousHistory = erroredHistory(f);
    installRollupNativeFault(f, 'ROLLBACK');
    clockTime = WINDOW;
    const failed = await f.runtime.tick(f.monitorsDir, f.root);
    // The original native error is reported, not a follow-on COMMIT failure.
    expect.soft(failed.emittedEventIds).toEqual([]);
    expect
      .soft(failed.erroredObservations)
      .toEqual([{ monitorId: 'rollup', message: 'native rollup ROLLBACK' }]);
    expect
      .soft(erroredHistory(f))
      .toEqual([...previousHistory, { error: 'native rollup ROLLBACK' }]);
    expect.soft(f.writer.client.inTransaction).toBe(false);
    // No new event/snapshot/projection/cursor/retry, no checkpoint or cleared hold.
    expect.soft(rollupArtifactRows(f)).toEqual(previousRows);
    expect.soft(f.reader.getMonitorState('rollup', f.root)).toEqual(f.before);
    expect.soft(f.reader.listMaterializationRetries()).toEqual([]);
    expect
      .soft(f.store.projectedSessionIdsForLastEvent())
      .toEqual([prior.session.id]);
    expect.soft(f.interpretation.calls).toEqual([]);
    expect.soft(f.observations()).toBe(1);

    f.writer.client.exec('DROP TRIGGER native_rollup_fault');
    // Close every original connection: reopen must consume persisted work,
    // not an old runtime's in-memory scheduling or recipient state.
    f.writer.client.close();
    f.observer.client.close();
    const reopenedConnection = f.connect();
    const reopenedStore = new RuntimeStore(reopenedConnection.db);
    expect
      .soft(reopenedStore.getMonitorState('rollup', f.root))
      .toEqual(f.before);
    // Force the source due inside the open window. The replacement
    // implementation acquires nothing and omits nextState, so only the
    // retained held span can emit and the opaque baseline must survive.
    const monitorFile = path.join(f.monitorsDir, 'rollup', 'MONITOR.md');
    writeFileSync(
      monitorFile,
      readFileSync(monitorFile, 'utf8').replace('interval: 2h', 'interval: 1s'),
    );
    const acquiredBaselines: unknown[] = [];
    const registry = new SourceRegistry();
    registry.register({
      name: 'rollup-source',
      scopeSchema: { type: 'object' },
      observe(_config, context) {
        acquiredBaselines.push(context.previousState);
        return Promise.resolve({ observations: [] });
      },
    });
    const reopened = new AgentMonitorRuntime(
      reopenedStore,
      registry,
      [claudeCodeAdapter],
      f.interpretation.adapter,
    );
    clockTime = WINDOW + 2000;
    const replay = await reopened.tick(f.monitorsDir, f.root);
    expect.soft(replay.erroredObservations).toEqual([]);
    expect.soft(replay.emittedEventIds).toHaveLength(3);
    expect.soft(acquiredBaselines).toEqual(['original-source']);
    const events = reopenedStore
      .listEvents({ monitorId: 'rollup', workspacePath: f.root })
      .sort((a, b) => a.id.localeCompare(b.id));
    expect
      .soft(events.map(({ summary, snapshotText }) => [summary, snapshotText]))
      .toEqual([
        ['step-1', 'alpha'],
        ['step-2', ''],
        ['step-3', 'omega'],
      ]);
    expect.soft(reopenedStore.getMonitorState('rollup', f.root)).toEqual({
      sourceState: 'original-source',
      notifyState: firedWindowNotify(f),
      lastObservationAt: new Date(WINDOW + 2000),
    });
    expect.soft(reopenedStore.listMaterializationRetries()).toEqual([]);
    expect.soft(f.interpretation.calls).toHaveLength(3);
    expect
      .soft(
        reopenedConnection.client
          .prepare('SELECT content FROM monitor_snapshots ORDER BY rowid')
          .all(),
      )
      .toEqual([{ content: 'alpha' }, { content: '' }, { content: 'omega' }]);
    // One prior projection plus three events for each of two leads.
    expect
      .soft(
        reopenedConnection.client
          .prepare('SELECT * FROM session_event_state')
          .all(),
      )
      .toHaveLength(7);
    expect
      .soft(reopenedStore.listEvents({ sessionId: prior.session.id }))
      .toEqual([{ ...prior.event, deliveryState: 'unread' }]);
    for (const session of f.sessions) {
      expect
        .soft(
          reopenedStore
            .listEvents({ sessionId: session.id })
            .map(({ id }) => id)
            .sort(),
        )
        .toEqual(events.map(({ id }) => id));
      expect
        .soft(
          reopenedStore.getSessionObjectCursor(
            session.id,
            'rollup',
            'shared',
            f.root,
          ),
        )
        .not.toBeNull();
    }
    const repeated = await reopened.tick(f.monitorsDir, f.root);
    expect.soft(repeated.emittedEventIds).toEqual([]);
    expect.soft(reopenedStore.listEvents()).toHaveLength(4);
  });

  it('retains the prefix and ordered suffix when a native ABORT leaves the owning transaction alive', async () => {
    const f = await fixture();
    f.interpretation.release();
    installRollupNativeFault(f, 'ABORT');
    clockTime = WINDOW;
    const result = await f.runtime.tick(f.monitorsDir, f.root);
    expect(result.emittedEventIds).toHaveLength(1);
    expect(result.erroredObservations).toHaveLength(1);
    expect(f.reader.listEvents().map(({ summary }) => summary)).toEqual([
      'step-1',
    ]);
    const retries = f.reader.listMaterializationRetries();
    expect(
      retries.map(({ sourceName, envelope }) => [
        sourceName,
        envelope.observation.summary,
        envelope.observation.snapshotText,
      ]),
    ).toEqual([
      ['rollup-source', 'step-2', ''],
      ['rollup-source', 'step-3', 'omega'],
    ]);
    expect(retries[0]?.lastError).toBe('native rollup ABORT');
    expect(f.reader.getMonitorState('rollup', f.root)).toEqual({
      ...f.before,
      notifyState: firedWindowNotify(f),
    });
    expect(f.interpretation.calls).toHaveLength(1);
    expect(f.reader.latestSnapshot('rollup', 'shared', f.root)).toEqual({
      content: 'alpha',
    });
    for (const session of f.sessions) {
      expect(f.reader.listEvents({ sessionId: session.id })).toHaveLength(1);
      expect(
        f.reader.getSessionObjectCursor(session.id, 'rollup', 'shared', f.root),
      ).not.toBeNull();
    }
    f.writer.client.close();
    f.observer.client.close();
    const reopened = new RuntimeStore(f.connect().db);
    expect(reopened.listMaterializationRetries()).toEqual(retries);
    expect(reopened.getMonitorState('rollup', f.root)).toEqual({
      ...f.before,
      notifyState: firedWindowNotify(f),
    });
  });

  it('keeps the captured old-source envelope and opaque baseline through a parsed edit and a failed flush', async () => {
    const f = await fixture();
    f.interpretation.release();
    const held = f.before.notifyState.pendingRollup?.observations;
    expect(held).toHaveLength(3);
    expect(f.before.sourceState).toBe('original-source');
    // A real edit through the normal scanner/parser: new source type,
    // instructions and urgency, with a short interval so it polls once.
    const monitorFile = path.join(f.monitorsDir, 'rollup', 'MONITOR.md');
    writeFileSync(
      monitorFile,
      readFileSync(monitorFile, 'utf8')
        .replace('type: rollup-source', 'type: replacement-source')
        .replace('interval: 2h', 'interval: 1s')
        .replace('urgency: normal', 'urgency: low')
        .replace('Inspect the changes.', 'Replacement instructions.'),
    );
    const acquiredBaselines: unknown[] = [];
    const registry = new SourceRegistry();
    registry.register({
      name: 'replacement-source',
      scopeSchema: { type: 'object' },
      observe(_config, context) {
        acquiredBaselines.push(context.previousState);
        // Omitting nextState preserves the source-owned baseline (003 §2.3).
        return Promise.resolve({ observations: [] });
      },
    });
    const edited = new AgentMonitorRuntime(
      f.store,
      registry,
      [claudeCodeAdapter],
      f.interpretation.adapter,
    );
    // Poll the replacement source while the window is closed: the old hold
    // must survive and the opaque baseline must not be reset or coerced.
    clockTime = BEFORE + 1000;
    const editedPoll = await edited.tick(f.monitorsDir, f.root);
    expect(editedPoll.emittedEventIds).toEqual([]);
    expect(editedPoll.erroredObservations).toEqual([]);
    expect(f.reader.getMonitorState('rollup', f.root)).toEqual({
      sourceState: 'original-source',
      notifyState: f.before.notifyState,
      lastObservationAt: new Date(BEFORE + 1000),
    });
    // Lengthen the interval so the window opens on the not-due flush path.
    writeFileSync(
      monitorFile,
      readFileSync(monitorFile, 'utf8').replace('interval: 1s', 'interval: 2h'),
    );
    installRollupNativeFault(f, 'ABORT');
    clockTime = WINDOW;
    const result = await edited.tick(f.monitorsDir, f.root);
    expect(acquiredBaselines).toEqual(['original-source']);
    expect(result.emittedEventIds).toHaveLength(1);
    expect(result.erroredObservations).toHaveLength(1);
    const retries = f.reader.listMaterializationRetries();
    // The retry route is the envelope's captured source, not the edited one.
    expect(retries.map(({ sourceName }) => sourceName)).toEqual([
      'rollup-source',
      'rollup-source',
    ]);
    // Serialized equality covers instructions, route, urgency, timestamps,
    // payload and ordered observation data captured under the old definition.
    expect(JSON.stringify(retries.map(({ envelope }) => envelope))).toBe(
      JSON.stringify(held?.slice(1)),
    );
    const events = f.reader.listEvents();
    expect(
      events.map(({ summary, snapshotText }) => [summary, snapshotText]),
    ).toEqual([['step-1', 'alpha']]);
    expect(events[0]).toMatchObject({
      sourceName: 'rollup-source',
      body: 'Inspect the changes.',
      urgency: 'normal',
    });
    expect(f.interpretation.calls).toHaveLength(1);
    const expectedState = {
      sourceState: 'original-source',
      notifyState: firedWindowNotify(f),
      lastObservationAt: new Date(BEFORE + 1000),
    };
    expect(f.reader.getMonitorState('rollup', f.root)).toEqual(expectedState);
    f.writer.client.close();
    f.observer.client.close();
    const reopened = new RuntimeStore(f.connect().db);
    expect(reopened.listMaterializationRetries()).toEqual(retries);
    expect(reopened.getMonitorState('rollup', f.root)).toEqual(expectedState);
  });
});

/**
 * An effective notify-policy edit drains held rollup work outside any window
 * (002 §4.6). That drain is a held rollup flush too, so it shares the flush's
 * owned runtime transaction (002 §4.4): it reads the hold under the writer
 * lock, and a fault rolls back every event, projection, cursor, snapshot,
 * metadata write and the store's recipient cache together. Unlike the window
 * flush, it is all-or-nothing: no prefix commits and no suffix is retained.
 */
describe('notify-policy edit draining held rollup work', () => {
  /** The edited definition's window; the source is still not due then. */
  const EDITED_WINDOW = Date.parse('2026-11-01T10:00:00Z');

  /**
   * Move the window to 10:00, an effective rollup policy change. The longer
   * interval keeps the source not due through it (pacing identity ignores it).
   */
  function editWindow(f: Awaited<ReturnType<typeof fixture>>) {
    const monitorFile = path.join(f.monitorsDir, 'rollup', 'MONITOR.md');
    writeFileSync(
      monitorFile,
      readFileSync(monitorFile, 'utf8')
        .replace("window: '0 9 * * *'", "window: '0 10 * * *'")
        .replace('interval: 2h', 'interval: 4h'),
    );
  }

  /** Private persisted pacing identity (002 §4.6), outside NotifyRuntimeState's type. */
  function storedPolicyKey(f: Awaited<ReturnType<typeof fixture>>): unknown {
    return (
      f.reader.getMonitorState('rollup', f.root).notifyState as {
        policyKey?: unknown;
      }
    ).policyKey;
  }

  it('drains the hold read under the writer lock, including work committed just before it', async () => {
    const f = await fixture();
    f.interpretation.release();
    const held = f.before.notifyState.pendingRollup?.observations ?? [];
    expect(held).toHaveLength(3);
    const late = {
      ...held[0],
      observation: {
        title: 'late',
        summary: 'late',
        objectKey: 'late',
        snapshotText: 'late-content',
      },
      observedAt: new Date(BEFORE + 500).toISOString(),
    };
    editWindow(f);
    clockTime = BEFORE + 1000;
    // Another writer commits one more held envelope before this drain's BEGIN.
    const interposed = beforeAdmission(
      f,
      () =>
        f.reader.setMonitorState('rollup', f.root, {
          ...f.before,
          notifyState: {
            ...f.before.notifyState,
            pendingRollup: { observations: [...held, late] },
          },
        }),
      'edit-drain',
    );
    const result = await f.runtime.tick(f.monitorsDir, f.root);
    interposed();
    expect(result.erroredObservations).toEqual([]);
    expect(result.emittedEventIds).toHaveLength(4);
    expect(
      f.reader
        .listEvents({ monitorId: 'rollup' })
        .map(({ summary }) => summary)
        .sort(),
    ).toEqual(['late', 'step-1', 'step-2', 'step-3']);
    const after = f.reader.getMonitorState('rollup', f.root);
    expect(after.notifyState.pendingRollup).toBeUndefined();
    expect(after.notifyState.rollupLastFiredMinute).toBeUndefined();
    expect(storedPolicyKey(f)).not.toBe(
      (f.before.notifyState as { policyKey?: unknown }).policyKey,
    );
    // A notify-only drain never touches the source baseline or its clock.
    expect(after.sourceState).toBe(f.before.sourceState);
    expect(after.lastObservationAt).toEqual(f.before.lastObservationAt);
    expect(f.reader.listMaterializationRetries()).toEqual([]);
    expect(f.interpretation.calls).toHaveLength(4);
    expect(f.observations()).toBe(1);
  });

  for (const action of ['ROLLBACK', 'ABORT'] as const) {
    it(`rolls a native ${action} back whole, recipient cache included, then drains once`, async () => {
      const f = await fixture();
      f.interpretation.release();
      const prior = seedPriorRecipient(f);
      const previousRows = rollupArtifactRows(f);
      const previousHistory = f.reader.listObservationHistory({
        monitorId: 'rollup',
      });
      editWindow(f);
      installRollupNativeFault(f, action);
      // The edited window is open, but a blocked edit keeps the gate closed:
      // no window flush may admit the old hold under the new policy instead.
      clockTime = EDITED_WINDOW;
      const blocked = await f.runtime.tick(f.monitorsDir, f.root);
      expect(blocked.emittedEventIds).toEqual([]);
      expect(blocked.erroredObservations).toHaveLength(1);
      expect(blocked.erroredObservations[0]).toMatchObject({
        monitorId: 'rollup',
        message: expect.stringContaining(
          'Notify edit blocked; accepted holds retained',
        ),
      });
      expect(f.writer.client.inTransaction).toBe(false);
      // Even a statement-local ABORT commits no prefix and queues no suffix:
      // the hold, its old identity and every artifact stay exactly as they were.
      expect(rollupArtifactRows(f)).toEqual(previousRows);
      expect(f.reader.getMonitorState('rollup', f.root)).toEqual(f.before);
      expect(f.reader.listMaterializationRetries()).toEqual([]);
      expect(f.store.projectedSessionIdsForLastEvent()).toEqual([
        prior.session.id,
      ]);
      expect(f.interpretation.calls).toEqual([]);
      expect(f.observations()).toBe(1);
      // The blocked edit reports one errored row and records no drop.
      const history = f.reader.listObservationHistory({ monitorId: 'rollup' });
      expect(history).toHaveLength(previousHistory.length + 1);
      expect(
        history.filter(
          ({ observationData }) => 'notRetained' in observationData,
        ),
      ).toEqual([]);

      f.writer.client.exec('DROP TRIGGER native_rollup_fault');
      clockTime += 1000;
      const drained = await f.runtime.tick(f.monitorsDir, f.root);
      expect(drained.erroredObservations).toEqual([]);
      expect(drained.emittedEventIds).toHaveLength(3);
      const events = f.reader.listEvents({
        monitorId: 'rollup',
        workspacePath: f.root,
      });
      expect(
        events
          .map(({ summary, snapshotText, body }) => [
            summary,
            snapshotText,
            body,
          ])
          .sort(),
      ).toEqual([
        ['step-1', 'alpha', 'Inspect the changes.'],
        ['step-2', '', 'Inspect the changes.'],
        ['step-3', 'omega', 'Inspect the changes.'],
      ]);
      for (const session of f.sessions)
        expect(f.reader.listEvents({ sessionId: session.id })).toHaveLength(3);
      expect(f.reader.getMonitorState('rollup', f.root)).toMatchObject({
        sourceState: f.before.sourceState,
        lastObservationAt: f.before.lastObservationAt,
      });
      expect(
        f.reader.getMonitorState('rollup', f.root).notifyState.pendingRollup,
      ).toBeUndefined();
      expect(f.interpretation.calls).toHaveLength(3);
      const repeated = await f.runtime.tick(f.monitorsDir, f.root);
      expect(repeated.emittedEventIds).toEqual([]);
      expect(f.reader.listEvents({ monitorId: 'rollup' })).toHaveLength(3);
    });
  }
});
