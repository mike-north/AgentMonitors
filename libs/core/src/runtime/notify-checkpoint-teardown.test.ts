/** 002 §2.4 / §4.6: close admission before draining, and transfer scope only after accepted writes settle. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Promise barriers expose actual source completion and polling without timing guesses. */
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
const handles: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const client of clients.splice(0)) if (client.open) client.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function turns() {
  for (let n = 0; n < 48; n++) await Promise.resolve();
}

/** All handles, callbacks, database connections and controlled results belong to this fixture. */
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-20T08:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'notify-checkpoint-close-'));
  roots.push(root);
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const file = path.join(dir, 'held.md');
  const dbPath = path.join(root, 'state.sqlite');
  const contexts: (ObservationContext & { signal: AbortSignal })[] = [];
  const completions: ReturnType<
    typeof deferred<IteratorResult<Observation>>
  >[] = [];
  const pollStarted = deferred<undefined>();
  const pollResult = deferred<ObservationResult>();
  const previous: unknown[] = [];
  const durableAtPoll: unknown[] = [];
  const errors: string[] = [];
  let calls = 0;
  function open() {
    const db = createDb(dbPath);
    // Native access injects real SQLite faults and opens independent durable readers.
    const client = (db as unknown as { $client: Database }).$client;
    clients.push(client);
    return { client, store: new RuntimeStore(db) };
  }
  const { client, store } = open();
  const source: ObservationSource = {
    name: 'checkpoint-close',
    stateful: true,
    scopeSchema: { type: 'object' },
    async observe(_config, context) {
      calls++;
      previous.push(context.previousState);
      if (calls === 1)
        return {
          observations: [{ title: 'A', snapshotText: 'A', objectKey: 'obj' }],
          nextState: { cursor: 1 },
        };
      if (calls !== 2) throw new Error('Unexpected duplicate poll');
      const reader = open();
      durableAtPoll.push(
        reader.store.getMonitorState('held', root).sourceState,
      );
      reader.client.close();
      pollStarted.resolve(undefined);
      return pollResult.promise;
    },
    watch(_config, context) {
      contexts.push(context);
      const completion = deferred<IteratorResult<Observation>>();
      completions.push(completion);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          if (context.signal.aborted)
            completion.resolve({ done: true, value: undefined });
          else
            context.signal.addEventListener(
              'abort',
              () => completion.resolve({ done: true, value: undefined }),
              { once: true },
            );
          return completion.promise;
        },
      };
    },
  };
  const registry = new SourceRegistry();
  registry.register(source);
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  const state = () => store.getMonitorState('held', root);
  const edit = (policy: string) =>
    writeFileSync(
      file,
      `---\nwatch:\n  type: checkpoint-close\n  interval: 1h\nbaseline-strategy: incremental\n${policy}---\nCaptured handling\n`,
    );
  edit('notify:\n  strategy: debounce\n  settle-for: 1h\n');
  const key = JSON.stringify([root, 'held']);
  const internals = runtime as unknown as {
    activeWatchers: Map<string, symbol>;
    watchPolicies: Map<string, unknown>;
    retainNotifyPolicy(id: string, workspace: string): void;
    releaseNotifyPolicy(id: string, workspace: string): void;
  };
  return {
    root,
    dir,
    key,
    runtime,
    registry,
    source,
    client,
    store,
    state,
    contexts,
    previous,
    durableAtPoll,
    errors,
    pollStarted,
    pollResult,
    internals,
    get calls() {
      return calls;
    },
    rows: () =>
      client
        .prepare(
          "SELECT summary FROM monitor_events WHERE workspace_path = ? AND monitor_id = 'held' ORDER BY rowid",
        )
        .pluck()
        .all(root),
    tick: () => runtime.tick(dir, root),
    async start() {
      await runtime.tick(dir, root);
      store.setMonitorState('held', root, {
        ...state(),
        lastObservationAt: new Date('2000-01-01T00:00:00Z'),
      });
      return this.watch();
    },
    async watch() {
      const handle = await runtime.watchMonitors(dir, root, {
        onError: (_id, error) => errors.push(error.message),
      });
      handles.push(handle);
      await turns();
      return handle;
    },
    checkpoint(cursor: number, index = 0) {
      const checkpoint = contexts[index]?.checkpoint;
      if (!checkpoint) throw new Error('Actual checkpoint is not ready');
      return checkpoint({ cursor });
    },
    finish(error = false, index = 0) {
      const completion = completions[index];
      if (!completion) throw new Error('Source is not ready');
      if (error) completion.reject(new Error('Owned iterator failure'));
      else completion.resolve({ done: true, value: undefined });
    },
    async block() {
      edit('');
      client.exec(
        "CREATE TRIGGER reject_a BEFORE INSERT ON monitor_events BEGIN SELECT RAISE(FAIL, 'owned closing gate fault'); END",
      );
      const result = await runtime.tick(dir, root);
      expect(result.erroredObservations).toHaveLength(1);
    },
    recover() {
      client.exec('DROP TRIGGER reject_a');
    },
    readPersisted() {
      const reader = open();
      const result = reader.store.getMonitorState('held', root);
      reader.client.close();
      return result;
    },
  };
}

for (const ending of ['completion', 'error'] as const) {
  for (const successor of ['poll', 'watch'] as const) {
    it(`${ending} drains accepted checkpoints before ${successor} can own the scope`, async () => {
      const f = fixture();
      const original = await f.start();
      await f.block();
      const checkpoint = f.checkpoint(111);
      await turns();
      expect(f.state().sourceState).toEqual({ cursor: 1 });
      f.finish(ending === 'error');
      await turns();
      const reservedWhileDraining = f.internals.activeWatchers.has(f.key);
      const late = f.checkpoint(222);
      let lateSettled = false;
      void late.then(
        () => {
          lateSettled = true;
        },
        () => {
          lateSettled = true;
        },
      );
      await turns();
      const lateSettledBeforeRecovery = lateSettled;
      let prematureReplacement: string[] = [];
      if (successor === 'watch')
        prematureReplacement = (await f.watch()).monitorIds;
      f.recover();
      const recovery = f.tick();
      // An incorrect early release starts polling. Settle it too, so failure is
      // a concrete baseline assertion rather than an unresolved probe/deadlock.
      const winner = await Promise.race([
        recovery.then(() => 'returned'),
        f.pollStarted.promise.then(() => 'poll'),
      ]);
      if (winner === 'poll')
        f.pollResult.resolve({
          observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
          nextState: { cursor: 999 },
        });
      await recovery;
      await checkpoint;
      await late;
      await turns();
      if (successor === 'poll') {
        if (f.calls === 1) {
          const next = f.tick();
          await f.pollStarted.promise;
          f.pollResult.resolve({
            observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
            nextState: { cursor: 999 },
          });
          await next;
        }
        expect(f.previous[1]).toEqual({ cursor: 111 });
        expect(f.durableAtPoll[0]).toEqual({ cursor: 111 });
        expect(f.rows()).toEqual(['A', 'B']);
        expect(f.state().sourceState).toEqual({ cursor: 999 });
        expect(f.readPersisted().sourceState).toEqual({ cursor: 999 });
      } else {
        expect(prematureReplacement).toEqual([]);
        expect(f.readPersisted().sourceState).toEqual({ cursor: 111 });
        const replacement = await f.watch();
        expect(replacement.monitorIds).toEqual(['held']);
        expect(f.contexts[1]?.previousState).toEqual({ cursor: 111 });
        const token = f.internals.activeWatchers.get(f.key);
        await original.stop();
        expect(f.internals.activeWatchers.get(f.key)).toBe(token);
        await f.checkpoint(333);
        await f.checkpoint(444, 1);
        expect(f.state().sourceState).toEqual({ cursor: 444 });
        expect(f.readPersisted().sourceState).toEqual({ cursor: 444 });
      }
      if (successor === 'poll')
        expect(f.contexts[0]?.signal.aborted).toBe(false);
      expect(reservedWhileDraining).toBe(true);
      expect(lateSettledBeforeRecovery).toBe(true);
      expect(f.errors).toEqual([
        ...(ending === 'error' ? ['Owned iterator failure'] : []),
        ...(successor === 'watch'
          ? [
              'Notify edit blocked; accepted holds retained: owned closing gate fault',
            ]
          : []),
      ]);
      expect(f.calls).toBe(successor === 'poll' ? 2 : 1);
    });
  }
}

for (const error of [false, true]) {
  it(`stop cancels a blocked closing checkpoint without writes or leaked ownership, iteratorError=${error}`, async () => {
    const f = fixture();
    const handle = await f.start();
    await f.block();
    const original = f.state();
    const checkpoint = f.checkpoint(111);
    f.finish(error);
    await turns();
    await handle.stop();
    await checkpoint;
    expect(f.state()).toEqual(original);
    expect(f.readPersisted()).toEqual(original);
    expect(f.internals.activeWatchers.has(f.key)).toBe(false);
    expect(f.internals.watchPolicies.size).toBe(0);
    await f.checkpoint(222);
    expect(f.state()).toEqual(original);
  });
}

it('a checkpoint queued before supersession rechecks identity at its actual write and releases only its own lease', async () => {
  const f = fixture();
  const handle = await f.start();
  const checkpoint = f.checkpoint(111);
  // This precise token seam represents a distinct owner; it neither fakes the
  // actual checkpoint/waiter nor allows the old owner to remove the successor.
  const successor = Symbol('successor');
  f.internals.retainNotifyPolicy('held', f.root);
  f.internals.activeWatchers.set(f.key, successor);
  try {
    await checkpoint;
    f.finish();
    await turns();
    await handle.stop();
    expect(f.state().sourceState).toEqual({ cursor: 1 });
    expect(f.readPersisted().sourceState).toEqual({ cursor: 1 });
    expect(f.internals.activeWatchers.get(f.key)).toBe(successor);
    expect(f.internals.watchPolicies.size).toBe(1);
  } finally {
    f.internals.activeWatchers.delete(f.key);
    f.internals.releaseNotifyPolicy('held', f.root);
  }
});

it('a draining watcher excludes only its own monitor/workspace while foreign polling advances', async () => {
  const f = fixture();
  const handle = await f.start();
  await f.block();
  const checkpoint = f.checkpoint(111);
  f.finish();
  await turns();
  f.registry.register({
    name: 'healthy',
    scopeSchema: { type: 'object' },
    async observe() {
      return { observations: [], nextState: { cursor: 555 } };
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
  const reserved = f.internals.activeWatchers.has(f.key);
  expect(f.store.getMonitorState('held', foreign).sourceState).toEqual({
    cursor: 555,
  });
  expect(f.store.getMonitorState('sibling', f.root).sourceState).toEqual({
    cursor: 555,
  });
  await handle.stop();
  await checkpoint;
  expect(reserved).toBe(true);
  expect(f.state().sourceState).toEqual({ cursor: 1 });
});

it('completion without queued work promptly releases polling and cached policy ownership', async () => {
  const f = fixture();
  await f.start();
  f.finish();
  await turns();
  expect(f.internals.activeWatchers.has(f.key)).toBe(false);
  expect(f.internals.watchPolicies.size).toBe(0);
  f.pollResult.resolve({ observations: [], nextState: { cursor: 999 } });
  await f.tick();
  expect(f.previous[1]).toEqual({ cursor: 1 });
  expect(f.state().sourceState).toEqual({ cursor: 999 });
});
