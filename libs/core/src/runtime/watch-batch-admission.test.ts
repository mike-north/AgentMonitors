/**
 * A watch yield associates a finite observation batch with its restart baseline.
 * The runtime admits both together or retains the old baseline and stops pulling.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type {
  InterpretAdapter,
  InterpretInput,
  InterpretResult,
} from '../adapter/interpret.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Only this suite's disposable SQLite clients and directories are cleaned up. */
const owned: { root: string; clients: BetterSQLiteClient[] }[] = [];
afterEach(() => {
  for (const resource of owned.splice(0)) {
    for (const client of resource.clients) if (client.open) client.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

/** The batch preserves intermediate changes, including a real empty snapshot. */
function batch(nextState: unknown = 'advanced'): ObservationResult {
  return {
    observations: ['alpha', '', 'omega'].map((snapshotText, index) => ({
      title: `step-${String(index + 1)}`,
      summary: `step-${String(index + 1)}`,
      objectKey: 'shared',
      snapshotText,
    })),
    nextState,
  };
}

/** Sources must also notice an abort that preceded their next asynchronous wait. */
function idle(context: ObservationContext): Promise<void> {
  return new Promise((resolve) => {
    if (context.signal?.aborted) resolve();
    else
      context.signal?.addEventListener('abort', () => resolve(), {
        once: true,
      });
  });
}

/** An actual inner snapshot failure permits successful prefix plus retry-suffix admission. */
class WatchFaultStore extends RuntimeStore {
  failSnapshot = false;
  override saveSnapshot(
    input: Parameters<RuntimeStore['saveSnapshot']>[0],
  ): void {
    super.saveSnapshot(input);
    if (this.failSnapshot && input.content === '') {
      this.failSnapshot = false;
      throw new Error('watch snapshot failed');
    }
  }
}

/** A real independent reader remains open across every admission boundary. */
function fixture(source: ObservationSource, adapter?: InterpretAdapter) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-watch-batch-'));
  const resource = { root, clients: [] as BetterSQLiteClient[] };
  owned.push(resource);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(path.join(monitorsDir, 'watched'), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, 'watched', 'MONITOR.md'),
    `---
name: Watch batch
watch:
  type: watch-batch
  interval: 1s
urgency: normal
payload:
  form: prose
baseline-strategy: incremental
---
Inspect the changes.
`,
  );
  const dbPath = path.join(root, 'runtime.db');
  const connect = () => {
    const db = createDb(dbPath);
    // The branded InboxDb hides the driver; tests inspect only owned durable rows.
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    resource.clients.push(client);
    return { db, client };
  };
  const writer = connect();
  const store = new WatchFaultStore(writer.db);
  const makeRuntime = (target: RuntimeStore) => {
    const registry = new SourceRegistry();
    registry.register(source);
    return new AgentMonitorRuntime(
      target,
      registry,
      [claudeCodeAdapter],
      adapter,
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
  return {
    root,
    monitorsDir,
    store,
    reader,
    writer,
    observer,
    runtime,
    sessions,
    connect,
    makeRuntime,
  };
}

/** A barrier exposes the durable state while the first optional adapter invocation is suspended. */
function barrier() {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const calls: InterpretInput[] = [];
  const adapter: InterpretAdapter = {
    name: 'watch-barrier',
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

/** Ordinary watch producers share the same one-shot fallback as a restarted daemon. */
function source(
  watch: NonNullable<ObservationSource['watch']>,
): ObservationSource {
  return {
    name: 'watch-batch',
    scopeSchema: { type: 'object' },
    observe: () => Promise.resolve({ observations: [] }),
    watch,
  };
}

describe('watch batch admission', () => {
  for (const retainedSuffix of [false, true]) {
    it(`commits the complete batch and checkpoint before Interpret and next pull (retained suffix: ${String(retainedSuffix)})`, async () => {
      const interpretation = barrier();
      let resumed = false;
      let retainedAtResume: string[] | undefined;
      let checkpointProperty: boolean | undefined;
      const f = fixture(
        source(async function* (_config, context) {
          checkpointProperty = Object.hasOwn(context, 'checkpoint');
          yield batch();
          resumed = true;
          retainedAtResume = f.reader
            .listMaterializationRetries()
            .map(({ envelope }) => envelope.observation.summary);
          await idle(context);
        }),
        interpretation.adapter,
      );
      f.store.failSnapshot = retainedSuffix;
      const errors: Error[] = [];
      const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root, {
        onError: (_id, error) => errors.push(error),
      });
      try {
        await vi.waitFor(() => expect(interpretation.calls).toHaveLength(1));
        expect(checkpointProperty).toBe(false);
        expect(resumed).toBe(false);
        const events = f.reader
          .listEvents()
          .sort((a, b) => a.id.localeCompare(b.id));
        expect(
          events.map(({ summary, snapshotText }) => [summary, snapshotText]),
        ).toEqual(
          retainedSuffix
            ? [['step-1', 'alpha']]
            : [
                ['step-1', 'alpha'],
                ['step-2', ''],
                ['step-3', 'omega'],
              ],
        );
        for (const session of f.sessions) {
          expect(
            f.reader
              .listEvents({ sessionId: session.id })
              .map(({ id }) => id)
              .sort(),
          ).toEqual(events.map(({ id }) => id).sort());
        }
        expect(f.reader.getMonitorState('watched', f.root).sourceState).toBe(
          'advanced',
        );
        expect(
          f.reader
            .listMaterializationRetries()
            .map(({ envelope }) => envelope.observation.summary),
        ).toEqual(retainedSuffix ? ['step-2', 'step-3'] : []);
        expect(
          f.observer.client
            .prepare(
              'SELECT content, event_id FROM monitor_snapshots ORDER BY id',
            )
            .all(),
        ).toEqual(
          events.map(({ snapshotText, id }) => ({
            content: snapshotText,
            event_id: id,
          })),
        );
        interpretation.release();
        // A retained suffix drains, after its first backoff, before the next
        // pull (002 §2.7).
        await vi.waitFor(() => expect(resumed).toBe(true), {
          timeout: 5_000,
          interval: 50,
        });
        expect(retainedAtResume).toEqual([]);
        expect(
          f.observer.client
            .prepare('SELECT summary FROM monitor_events ORDER BY sequence')
            .all(),
        ).toEqual(
          ['step-1', 'step-2', 'step-3'].map((summary) => ({ summary })),
        );
        expect(errors).toHaveLength(retainedSuffix ? 1 : 0);
      } finally {
        interpretation.release();
        await handle.stop();
      }
    });
  }

  for (const failure of ['state', 'outbox', 'empty-state'] as const) {
    it(`preserves the old baseline and stops before any newer pull on ${failure} admission failure`, async () => {
      let resumed = false;
      let cleaned = false;
      const observedStates: unknown[] = [];
      const producer = source(async function* () {
        try {
          yield failure === 'empty-state'
            ? { observations: [], nextState: 'advanced' }
            : batch();
          resumed = true;
          yield { observations: [], nextState: 'too-new' };
        } finally {
          cleaned = true;
        }
      });
      producer.observe = (_config, context) => {
        observedStates.push(context.previousState);
        return Promise.resolve(batch('replayed'));
      };
      const interpretation = barrier();
      const f = fixture(producer, interpretation.adapter);
      const before = {
        sourceState: 'old',
        notifyState: { suppressedUntil: new Date(0).toISOString() },
      };
      f.store.setMonitorState('watched', f.root, before);
      if (failure === 'outbox') f.store.failSnapshot = true;
      const table =
        failure === 'outbox' ? 'materialization_retry_outbox' : 'monitor_state';
      const operation = failure === 'outbox' ? 'INSERT' : 'UPDATE';
      // Only the batch's own state write advances the observation clock;
      // startup's notify-identity learning (002 §4.6) must still succeed.
      const when =
        failure === 'outbox'
          ? ''
          : ' WHEN NEW.last_observation_at IS NOT OLD.last_observation_at';
      // The actual insert/update runs after earlier sibling writes, exercising outer rollback.
      f.writer.client.exec(
        `CREATE TRIGGER admission_failure BEFORE ${operation} ON ${table}${when} BEGIN SELECT RAISE(ABORT, 'admission failed'); END;`,
      );
      const errors: Error[] = [];
      const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root, {
        onError: (_id, error) => errors.push(error),
      });
      try {
        await vi.waitFor(() => expect(errors).toHaveLength(1));
        await vi.waitFor(() => expect(cleaned).toBe(true));
        expect(resumed).toBe(false);
        // Startup recorded only the private pacing identity; the batch changed nothing.
        expect(f.reader.getMonitorState('watched', f.root)).toEqual({
          ...before,
          notifyState: {
            ...before.notifyState,
            policyKey: expect.any(String),
          },
        });
        expect(f.reader.listEvents()).toEqual([]);
        expect(f.reader.listMaterializationRetries()).toEqual([]);
        expect(interpretation.calls).toEqual([]);
        for (const durableTable of [
          'session_event_state',
          'session_object_cursor',
          'monitor_snapshots',
        ]) {
          expect(
            f.observer.client.prepare(`SELECT * FROM ${durableTable}`).all(),
          ).toEqual([]);
        }
        f.writer.client.exec('DROP TRIGGER admission_failure');
        const restarted = f.makeRuntime(new RuntimeStore(f.connect().db));
        interpretation.release();
        const replay = await restarted.tick(f.monitorsDir, f.root);
        expect(observedStates).toEqual(['old']);
        expect(replay.emittedEventIds).toHaveLength(3);
        expect(f.reader.getMonitorState('watched', f.root).sourceState).toBe(
          'replayed',
        );
      } finally {
        interpretation.release();
        await handle.stop();
      }
    });
  }

  it('accepts empty state batches and preserves omitted/undefined checkpoints while allowing null', async () => {
    const states: unknown[] = [];
    const producer = source(async function* () {
      for (const result of [
        { observations: [], nextState: 'new' },
        { observations: [] },
        { observations: [], nextState: undefined },
        { observations: [], nextState: null },
      ]) {
        yield result;
        states.push(f.reader.getMonitorState('watched', f.root).sourceState);
      }
    });
    const f = fixture(producer);
    f.store.setMonitorState('watched', '/other-workspace', {
      sourceState: 'other',
      notifyState: {},
    });
    const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root);
    try {
      await vi.waitFor(() => expect(states).toEqual(['new', 'new', 'new', {}]));
      expect(
        f.reader.getMonitorState('watched', '/other-workspace').sourceState,
      ).toBe('other');
      expect(
        f.observer.client
          .prepare(
            'SELECT source_state FROM monitor_state WHERE workspace_path = ?',
          )
          .get(f.root),
      ).toEqual({ source_state: '{}' });
      expect(f.reader.listEvents()).toEqual([]);
      expect(f.reader.listMaterializationRetries()).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it('refuses a legacy bare-observation yield without consuming newer input or changing state', async () => {
    let resumed = false;
    const f = fixture(
      source(async function* () {
        // Simulate a JavaScript plugin compiled against the previous public interface.
        yield { title: 'legacy event' } as unknown as ObservationResult;
        resumed = true;
        yield batch();
      }),
    );
    const errors: Error[] = [];
    const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root, {
      onError: (_id, error) => errors.push(error),
    });
    try {
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]?.message).toContain('observation batch');
      expect(resumed).toBe(false);
      expect(f.reader.listEvents()).toEqual([]);
      expect(f.reader.getMonitorState('watched', f.root)).toEqual({
        notifyState: {},
      });
    } finally {
      await handle.stop();
    }
  });

  it('stops before the next pull when aborted during Interpret without undoing the committed batch', async () => {
    const interpretation = barrier();
    let resumed = false;
    const f = fixture(
      source(async function* () {
        yield batch();
        resumed = true;
        yield batch('newer');
      }),
      interpretation.adapter,
    );
    const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root);
    try {
      await interpretation.entered;
      const stopped = handle.stop();
      interpretation.release();
      await stopped;
      expect(resumed).toBe(false);
      expect(f.reader.listEvents()).toHaveLength(3);
      expect(f.reader.getMonitorState('watched', f.root).sourceState).toBe(
        'advanced',
      );
    } finally {
      interpretation.release();
      await handle.stop();
    }
  });

  it('an older completed handle cannot stop or release its replacement watcher', async () => {
    let calls = 0;
    const f = fixture(
      source(async function* (_config, context) {
        calls += 1;
        const generation = calls;
        yield { observations: [], nextState: generation };
        if (generation > 1) await idle(context);
      }),
    );
    const old = await f.runtime.watchMonitors(f.monitorsDir, f.root);
    await vi.waitFor(() =>
      expect(f.reader.getMonitorState('watched', f.root).sourceState).toBe(1),
    );
    const current = await f.runtime.watchMonitors(f.monitorsDir, f.root);
    try {
      expect(current.monitorIds).toEqual(['watched']);
      await vi.waitFor(() =>
        expect(f.reader.getMonitorState('watched', f.root).sourceState).toBe(2),
      );
      await old.stop();
      const duplicate = await f.runtime.watchMonitors(f.monitorsDir, f.root);
      expect(duplicate.monitorIds).toEqual([]);
      await duplicate.stop();
      expect(calls).toBe(2);
    } finally {
      await old.stop();
      await current.stop();
    }
  });

  it('rejects a later batch when another writer advances the persisted source baseline', async () => {
    let resumedAfterConflict = false;
    const producer = source(async function* () {
      yield { observations: [], nextState: 'first' };
      f.reader.setMonitorState('watched', f.root, {
        sourceState: 'winner',
        notifyState: { suppressedUntil: '2030-01-01T00:00:00.000Z' },
      });
      yield batch('stale');
      resumedAfterConflict = true;
    });
    const f = fixture(producer);
    const errors: Error[] = [];
    const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root, {
      onError: (_id, error) => errors.push(error),
    });
    try {
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]?.message).toContain('source baseline changed');
      expect(resumedAfterConflict).toBe(false);
      expect(f.reader.getMonitorState('watched', f.root)).toEqual({
        sourceState: 'winner',
        notifyState: { suppressedUntil: '2030-01-01T00:00:00.000Z' },
      });
      expect(f.reader.listEvents()).toEqual([]);
      expect(f.reader.listMaterializationRetries()).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it('does not admit a late batch after stop aborts the watcher', async () => {
    const pulled = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const f = fixture(
      source(async function* () {
        pulled.resolve(undefined);
        await release.promise;
        yield batch('stale');
      }),
    );
    const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root);
    await pulled.promise;
    const stopped = handle.stop();
    release.resolve(undefined);
    await stopped;
    expect(f.reader.listEvents()).toEqual([]);
    expect(f.reader.getMonitorState('watched', f.root)).toEqual({
      notifyState: {},
    });
  });

  it('releases ownership after normal completion or a synchronous watch setup error', async () => {
    let calls = 0;
    const f = fixture(
      source(() => {
        calls += 1;
        if (calls === 1) throw new Error('setup failed');
        return (async function* () {
          yield { observations: [], nextState: calls };
        })();
      }),
    );
    const errors: Error[] = [];
    const first = await f.runtime.watchMonitors(f.monitorsDir, f.root, {
      onError: (_id, error) => errors.push(error),
    });
    // The source factory runs only after startup reconciliation opens the gate.
    await vi.waitFor(() =>
      expect(errors.map(({ message }) => message)).toEqual(['setup failed']),
    );
    await first.stop();
    expect(errors.map(({ message }) => message)).toEqual(['setup failed']);
    const second = await f.runtime.watchMonitors(f.monitorsDir, f.root);
    await vi.waitFor(() =>
      expect(f.reader.getMonitorState('watched', f.root).sourceState).toBe(2),
    );
    await second.stop();
    const third = await f.runtime.watchMonitors(f.monitorsDir, f.root);
    await vi.waitFor(() =>
      expect(f.reader.getMonitorState('watched', f.root).sourceState).toBe(3),
    );
    await third.stop();
  });
});
