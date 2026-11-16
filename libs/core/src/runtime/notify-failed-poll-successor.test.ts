/** 002 §4.6: a failed poll's late diagnostics cannot retire a successor's live admission. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Source completion barriers control scheduling without replacing any runtime/admission method. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const roots: string[] = [];
const clients: Database[] = [];
const cleanups: (() => Promise<void>)[] = [];
const handles: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const handle of handles.splice(0)) await handle.stop();
  vi.useRealTimers();
  for (const client of clients.splice(0)) if (client.open) client.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function turns() {
  for (let i = 0; i < 48; i++) await Promise.resolve();
}
const START = new Date('2026-03-20T08:00:00Z');

/** Actual registered observations, SQLite writes and public ticks expose the ownership transfer. */
function fixture(
  failure: 'ingest' | 'observe' | 'none' | 'argument',
  watched = false,
) {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'notify-failed-successor-'));
  roots.push(root);
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const dbPath = path.join(root, 'state.sqlite');
  writeFileSync(
    path.join(dir, 'held.md'),
    '---\nwatch:\n  type: successor-source\n  interval: 1h\nbaseline-strategy: incremental\n---\nCaptured handling\n',
  );
  const first = deferred<ObservationResult>();
  const second = deferred<ObservationResult>();
  const started = deferred<undefined>();
  const secondStarted = deferred<undefined>();
  const tasks: Promise<unknown>[] = [];
  let calls = 0;
  let releaseFirst = false;
  let successor: unknown;
  let factories = 0;
  let factoryPrevious: unknown;
  // Settles once the watcher asks for input after its baseline batch, i.e. the
  // batch was admitted, or once the watcher is aborted without admitting it.
  const baselineSettled = deferred<undefined>();
  const registry = new SourceRegistry();
  const source: ObservationSource = {
    name: 'successor-source',
    stateful: true,
    scopeSchema: { type: 'object' },
    observe() {
      calls++;
      if (calls === 1) {
        started.resolve(undefined);
        if (failure === 'argument')
          return Promise.resolve({
            get observations() {
              throw new Error('Owned observation access failure');
            },
            nextState: { cursor: 1 },
          });
        return first.promise;
      }
      if (calls === 2) {
        successor = admissions().get(key);
        secondStarted.resolve(undefined);
        return second.promise;
      }
      return Promise.resolve({
        observations: [{ title: 'C', snapshotText: 'C', objectKey: 'obj' }],
        nextState: { cursor: calls },
      });
    },
    ...(watched
      ? {
          watch(
            _config: Record<string, unknown>,
            context: ObservationContext & { signal: AbortSignal },
          ) {
            factories++;
            factoryPrevious = context.previousState;
            let pulls = 0;
            const aborted = () =>
              new Promise<IteratorResult<ObservationResult>>((resolve) => {
                const done = () => {
                  baselineSettled.resolve(undefined);
                  resolve({ done: true, value: undefined });
                };
                if (context.signal.aborted) done();
                else
                  context.signal.addEventListener('abort', done, {
                    once: true,
                  });
              });
            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              next(): Promise<IteratorResult<ObservationResult>> {
                pulls++;
                // This real baseline-only batch may not cross the successor's outstanding poll.
                if (pulls === 1)
                  return Promise.resolve({
                    done: false,
                    value: { observations: [], nextState: { cursor: 777 } },
                  });
                baselineSettled.resolve(undefined);
                return aborted();
              },
            };
          },
        }
      : {}),
  };
  registry.register(source);
  const originalGet = registry.get.bind(registry);
  // Tick B has completed its actual scan here. Completing source A only
  // schedules A's continuation; registry resolution still returns the real source.
  registry.get = (name) => {
    if (name === source.name && releaseFirst) {
      releaseFirst = false;
      if (failure === 'observe')
        first.reject(new Error('Owned observation failure'));
      else
        first.resolve({
          observations: [{ title: 'A', snapshotText: 'A', objectKey: 'obj' }],
          nextState: { cursor: 1 },
        });
    }
    return originalGet(name);
  };
  function open() {
    const db = createDb(dbPath);
    // Native driver access is limited to real SQLite fault injection and durable reopen proof.
    const client = (db as unknown as { $client: Database }).$client;
    clients.push(client);
    return { client, store: new RuntimeStore(db) };
  }
  const { client, store } = open();
  const runtime = new AgentMonitorRuntime(
    store,
    registry,
    [claudeCodeAdapter],
    undefined,
    { sessionDormancyMs: 24 * 60 * 60 * 1_000 },
  );
  runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  const key = JSON.stringify([root, 'held']);
  function admissions() {
    return (runtime as unknown as { pollAdmissions: Map<string, unknown> })
      .pollAdmissions;
  }
  const policies = () =>
    (runtime as unknown as { watchPolicies: Map<string, unknown> })
      .watchPolicies;
  const tick = () => {
    const task = runtime.tick(dir, root);
    tasks.push(task);
    return task;
  };
  if (failure === 'ingest')
    client.exec(
      "CREATE TRIGGER reject_first BEFORE INSERT ON monitor_state WHEN json_extract(NEW.source_state, '$.cursor') = 1 BEGIN SELECT RAISE(FAIL, 'owned first ingestion fault'); END",
    );
  cleanups.push(async () => {
    first.resolve({ observations: [], nextState: { cursor: 1 } });
    second.resolve({
      observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
      nextState: { cursor: 2 },
    });
    await Promise.allSettled(tasks);
  });
  return {
    root,
    dir,
    runtime,
    registry,
    client,
    store,
    key,
    admissions,
    policies,
    get calls() {
      return calls;
    },
    get successor() {
      return successor;
    },
    get factories() {
      return factories;
    },
    get factoryPrevious() {
      return factoryPrevious;
    },
    state: () => store.getMonitorState('held', root),
    rows: () =>
      client
        .prepare(
          "SELECT summary FROM monitor_events WHERE workspace_path = ? AND monitor_id = 'held' ORDER BY rowid",
        )
        .pluck()
        .all(root),
    tick,
    async overlap() {
      const a = tick();
      await started.promise;
      // A's accepted observation time stays old; B is legitimately due even in the successful control.
      vi.setSystemTime(new Date(START.getTime() + 2 * 60 * 60 * 1_000));
      releaseFirst = true;
      const b = tick();
      await secondStarted.promise;
      return { resultA: await a, b };
    },
    async finish(b: Promise<unknown>) {
      second.resolve({
        observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
        nextState: { cursor: 2 },
      });
      await b;
      await turns();
    },
    async watch() {
      const handle = await runtime.watchMonitors(dir, root);
      handles.push(handle);
      await turns();
      return handle;
    },
    async finishBaselineBatch() {
      await turns();
      await baselineSettled.promise;
    },
    reopen() {
      client.close();
      const reader = open();
      const result = {
        state: reader.store.getMonitorState('held', root),
        events: reader.client
          .prepare(
            "SELECT summary FROM monitor_events WHERE workspace_path = ? AND monitor_id = 'held' ORDER BY rowid",
          )
          .pluck()
          .all(root),
        snapshot: reader.store.latestSnapshot('held', 'obj', root),
      };
      reader.client.close();
      return result;
    },
  };
}

for (const failure of ['ingest', 'observe', 'none'] as const) {
  it(`${failure} completion cannot remove a successor admission or permit a third source before it returns`, async () => {
    const f = fixture(failure);
    const { resultA, b } = await f.overlap();
    const retained = f.admissions().get(f.key) === f.successor;
    const before = f.state();
    await f.tick();
    const callsBeforeB = f.calls;
    const afterThird = f.state();
    const eventsBeforeB = f.rows();
    await f.finish(b);
    const stateAfterB = f.state();
    // A later, legitimately due source may now advance the completed successor.
    vi.setSystemTime(new Date(START.getTime() + 4 * 60 * 60 * 1_000));
    await f.tick();
    const persisted = f.reopen();
    expect(retained).toBe(true);
    expect(callsBeforeB).toBe(2);
    expect(afterThird).toEqual(before);
    expect(eventsBeforeB).toEqual(failure === 'none' ? ['A'] : []);
    expect(resultA.erroredObservations.map((e) => e.message)).toEqual(
      failure === 'ingest'
        ? ['owned first ingestion fault']
        : failure === 'observe'
          ? ['Owned observation failure']
          : [],
    );
    expect(stateAfterB.sourceState).toEqual({ cursor: 2 });
    expect(persisted.state.sourceState).toEqual({ cursor: 3 });
    expect(persisted.events).toEqual(
      failure === 'none' ? ['A', 'B', 'C'] : ['B', 'C'],
    );
    expect(persisted.snapshot?.content).toBe('C');
    expect(f.admissions().size).toBe(0);
    expect(f.policies().size).toBe(0);
  });
}

it('a failed predecessor cannot wake a watcher factory or admit its baseline batch through its successor poll', async () => {
  const f = fixture('ingest', true);
  const { resultA, b } = await f.overlap();
  const retained = f.admissions().get(f.key) === f.successor;
  const before = f.state();
  await f.watch();
  await turns();
  const factoriesBeforeB = f.factories;
  const stateBeforeB = f.state();
  await f.tick();
  await f.finish(b);
  await f.finishBaselineBatch();
  for (const handle of handles.splice(0)) await handle.stop();
  const persisted = f.reopen();
  expect(retained).toBe(true);
  expect(factoriesBeforeB).toBe(0);
  expect(stateBeforeB).toEqual(before);
  expect(resultA.erroredObservations[0]?.message).toBe(
    'owned first ingestion fault',
  );
  expect(f.factoryPrevious).toEqual({ cursor: 2 });
  expect(f.factories).toBe(1);
  expect(f.calls).toBe(2);
  expect(persisted.state.sourceState).toEqual({ cursor: 777 });
  expect(persisted.events).toEqual(['B']);
  expect(f.admissions().size).toBe(0);
  expect(f.policies().size).toBe(0);
});

it('successor exclusion remains local while healthy sibling and same-id foreign workspace polling progress', async () => {
  const f = fixture('ingest');
  const { b } = await f.overlap();
  f.registry.register({
    name: 'healthy',
    scopeSchema: { type: 'object' },
    async observe() {
      return { observations: [], nextState: { cursor: 909 } };
    },
  });
  const foreign = path.join(f.root, 'foreign');
  mkdirSync(foreign);
  writeFileSync(
    path.join(foreign, 'held.md'),
    '---\nwatch:\n  type: healthy\n---',
  );
  writeFileSync(
    path.join(f.dir, 'sibling.md'),
    '---\nwatch:\n  type: healthy\n---',
  );
  await f.runtime.tick(foreign, foreign);
  await f.tick();
  const retained = f.admissions().get(f.key) === f.successor;
  const callsBeforeB = f.calls;
  const foreignState = f.store.getMonitorState('held', foreign);
  const siblingState = f.store.getMonitorState('sibling', f.root);
  await f.finish(b);
  expect(retained).toBe(true);
  expect(callsBeforeB).toBe(2);
  expect(f.state().sourceState).toEqual({ cursor: 2 });
  expect(foreignState.sourceState).toEqual({ cursor: 909 });
  expect(siblingState.sourceState).toEqual({ cursor: 909 });
  expect(f.admissions().size).toBe(0);
  expect(f.policies().size).toBe(0);
});

it('an error before ingestion starts still retires its own admission and permits ordinary polling recovery', async () => {
  const f = fixture('argument');
  const failed = await f.tick();
  expect(failed.erroredObservations.map((e) => e.message)).toEqual([
    'Owned observation access failure',
  ]);
  expect(f.admissions().size).toBe(0);
  expect(f.policies().size).toBe(0);
  expect(f.state().sourceState).toBeUndefined();
  const next = f.tick();
  await f.finish(next);
  expect(f.calls).toBe(2);
  expect(f.state().sourceState).toEqual({ cursor: 2 });
  const persisted = f.reopen();
  expect(persisted.state.sourceState).toEqual({ cursor: 2 });
  expect(persisted.events).toEqual(['B']);
});
