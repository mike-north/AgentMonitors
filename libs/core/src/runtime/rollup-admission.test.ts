/**
 * Not-due rollup decisions and their durable effects share one writer lock.
 * Owned competing runtimes and independent readers expose stale decisions,
 * checkpoint rewinds, partial admission and interpretation before commit.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Source polling is due at08:00/10:00; the independent rollup window is09:00 UTC. */
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

/** Interpose at the pre-BEGIN boundary without mocked reads or changes to production seams. */
function beforeAdmission(
  f: Awaited<ReturnType<typeof fixture>>,
  competingCommit: () => void,
) {
  let ran = false;
  registerRuntimeTransaction(f.store, (operation) => {
    if (!ran) {
      ran = true;
      competingCommit();
    }
    return f.writer.client.transaction(operation).immediate();
  });
  return () => expect(ran).toBe(true);
}

/** The child imports current source using Node24 type transformation and a confined resolver hook. */
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
      expect(state.notifyState).toEqual({
        rollupLastFiredMinute: Math.floor(WINDOW / 60000),
      });
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
        notifyState: { rollupLastFiredMinute: Math.floor(WINDOW / 60000) },
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
      expect(f.reader.listMaterializationRetries().map(({ id }) => id)).toEqual(
        retries.map(({ id }) => id),
      );
      expect(f.reader.listEvents().map(({ id }) => id)).toEqual(
        events.map(({ id }) => id),
      );
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
        notifyState: { rollupLastFiredMinute: Math.floor(WINDOW / 60000) },
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
              notifyState: {
                rollupLastFiredMinute: Math.floor(WINDOW / 60000),
              },
            }
          : f.before,
      );
    });
  }
});
