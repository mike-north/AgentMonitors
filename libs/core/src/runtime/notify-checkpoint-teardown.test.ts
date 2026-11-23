/**
 * 002 §2.4 / §4.6: a watch batch waiting at a closed admission gate keeps its
 * watcher's scope. It is admitted in one transaction when the gate reopens, or
 * dropped unadmitted on abort or supersession; only then does the source end
 * and the watcher release its slot and cached-policy lease to a successor.
 */
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

/** Promise barriers expose actual source pulls and polling without timing guesses. */
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

/** One started watch iterator: its context, pull count and the pull it has not answered. */
interface WatchedSource {
  context: ObservationContext;
  /** Every next() call; a pull after a batch means that batch was fully admitted. */
  pulls: number;
  /** The outstanding next() the test answers with a batch, completion or failure. */
  waiting?: ReturnType<typeof deferred<IteratorResult<ObservationResult>>>;
  /** The runtime closed the iterator early (a dropped batch breaks the consumer loop). */
  returned: boolean;
}

/** All handles, callbacks, database connections and controlled results belong to this fixture. */
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-20T08:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'notify-batch-teardown-'));
  roots.push(root);
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const file = path.join(dir, 'held.md');
  const dbPath = path.join(root, 'state.sqlite');
  const sources: WatchedSource[] = [];
  const pollStarted = deferred<undefined>();
  const pollResult = deferred<ObservationResult>();
  const previous: unknown[] = [];
  const durableAtPoll: unknown[] = [];
  const errors: string[] = [];
  let calls = 0;
  let cleanupFailure = false;
  function open() {
    const db = createDb(dbPath);
    // Native access injects real SQLite faults and opens independent durable readers.
    const client = (db as unknown as { $client: Database }).$client;
    clients.push(client);
    return { client, store: new RuntimeStore(db) };
  }
  const { client, store } = open();
  const source: ObservationSource = {
    name: 'batch-teardown',
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
      const watched: WatchedSource = { context, pulls: 0, returned: false };
      sources.push(watched);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          watched.pulls++;
          const pull = deferred<IteratorResult<ObservationResult>>();
          watched.waiting = pull;
          if (context.signal?.aborted)
            pull.resolve({ done: true, value: undefined });
          else
            context.signal?.addEventListener(
              'abort',
              () => pull.resolve({ done: true, value: undefined }),
              { once: true },
            );
          return pull.promise;
        },
        return() {
          watched.returned = true;
          return cleanupFailure
            ? Promise.reject(new Error('Owned iterator failure'))
            : Promise.resolve({ done: true, value: undefined });
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
      `---\nwatch:\n  type: batch-teardown\n  interval: 1h\nbaseline-strategy: incremental\n${policy}---\nCaptured handling\n`,
    );
  edit('notify:\n  strategy: debounce\n  settle-for: 1h\n');
  const key = JSON.stringify([root, 'held']);
  const internals = runtime as unknown as {
    activeWatchers: Map<string, symbol>;
    watchPolicies: Map<string, unknown>;
    watchPolicyWaiters: Map<string, Set<() => void>>;
    retainNotifyPolicy(id: string, workspace: string): void;
    releaseNotifyPolicy(id: string, workspace: string): void;
  };
  function watched(index: number) {
    const entry = sources[index];
    if (!entry) throw new Error('Source is not ready');
    return entry;
  }
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
    sources,
    previous,
    durableAtPoll,
    errors,
    pollStarted,
    pollResult,
    internals,
    watched,
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
    /** Errored history rows that carry the iterator cleanup failure. */
    cleanupHistory: () =>
      store
        .listObservationHistory({ monitorId: 'held', workspacePath: root })
        .filter((row) =>
          JSON.stringify(row).includes('Owned iterator failure'),
        ),
    tick: () => runtime.tick(dir, root),
    async start() {
      await runtime.tick(dir, root);
      store.setMonitorState('held', root, {
        ...state(),
        lastObservationAt: new Date('2000-01-01T00:00:00Z'),
      });
      const handle = await this.watch();
      await this.until(() => sources.length === 1, 'the source to start');
      return handle;
    },
    async watch() {
      const handle = await runtime.watchMonitors(dir, root, {
        onError: (_id, error) => errors.push(error.message),
      });
      handles.push(handle);
      await turns();
      return handle;
    },
    /** Bounded microtask polling for an observable runtime transition. */
    async until(done: () => boolean, label: string) {
      for (let round = 0; round < 40; round++) {
        if (done()) return;
        await turns();
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
    /** A batch is parked on the closed gate, not merely slow to be pulled. */
    gated: () => internals.watchPolicyWaiters.has(key),
    /** Answer the outstanding pull with a baseline-only batch. */
    send(cursor: number, index = 0) {
      const entry = watched(index);
      const pull = entry.waiting;
      if (!pull) throw new Error('Source is not waiting for a pull');
      entry.waiting = undefined;
      pull.resolve({
        done: false,
        value: { observations: [], nextState: { cursor } },
      });
    },
    finish(error = false, index = 0) {
      const entry = watched(index);
      const pull = entry.waiting;
      if (!pull) throw new Error('Source is not waiting for a pull');
      entry.waiting = undefined;
      if (error) pull.reject(new Error('Owned iterator failure'));
      else pull.resolve({ done: true, value: undefined });
    },
    failCleanup() {
      cleanupFailure = true;
    },
    async block() {
      edit('');
      client.exec(
        "CREATE TRIGGER reject_a BEFORE INSERT ON monitor_events BEGIN SELECT RAISE(FAIL, 'owned closed gate fault'); END",
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
    it(`a batch waiting at a closed gate keeps ${successor} out until it is admitted and the source's ${ending} settles`, async () => {
      const f = fixture();
      const original = await f.start();
      await f.block();
      f.send(111);
      await f.until(f.gated, 'the batch to wait at the closed gate');
      await turns();
      // Backpressure: the waiting batch is neither admitted nor followed by a newer pull.
      expect(f.state().sourceState).toEqual({ cursor: 1 });
      expect(f.readPersisted().sourceState).toEqual({ cursor: 1 });
      expect(f.watched(0).pulls).toBe(1);
      const reservedWhileWaiting = f.internals.activeWatchers.has(f.key);
      // A due poll cannot overtake the waiting batch's baseline while the edit stays blocked.
      expect((await f.tick()).erroredObservations).toHaveLength(1);
      expect(f.calls).toBe(1);
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
      await f.until(
        () => f.watched(0).pulls === 2,
        'the admitted batch to release the next pull',
      );
      expect(f.calls).toBe(1);
      expect(f.state().sourceState).toEqual({ cursor: 111 });
      expect(f.readPersisted().sourceState).toEqual({ cursor: 111 });
      // Admission alone does not hand over the scope; the source still owns it.
      const reservedAfterAdmission = f.internals.activeWatchers.has(f.key);
      f.finish(ending === 'error');
      await f.until(
        () => !f.internals.activeWatchers.has(f.key),
        'the ended watcher to release its scope',
      );
      expect(f.internals.watchPolicies.size).toBe(0);
      if (successor === 'poll') {
        // The admitted empty batch counts as an observation; make the scope due again.
        vi.setSystemTime(new Date('2026-03-20T09:00:01Z'));
        const next = f.tick();
        await f.pollStarted.promise;
        f.pollResult.resolve({
          observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
          nextState: { cursor: 999 },
        });
        await next;
        expect(f.previous[1]).toEqual({ cursor: 111 });
        expect(f.durableAtPoll[0]).toEqual({ cursor: 111 });
        expect(f.rows()).toEqual(['A', 'B']);
        expect(f.state().sourceState).toEqual({ cursor: 999 });
        expect(f.readPersisted().sourceState).toEqual({ cursor: 999 });
        expect(f.watched(0).context.signal?.aborted).toBe(false);
      } else {
        expect(prematureReplacement).toEqual([]);
        expect(f.readPersisted().sourceState).toEqual({ cursor: 111 });
        const replacement = await f.watch();
        expect(replacement.monitorIds).toEqual(['held']);
        await f.until(() => f.sources.length === 2, 'the replacement source');
        expect(f.watched(1).context.previousState).toEqual({ cursor: 111 });
        const token = f.internals.activeWatchers.get(f.key);
        await original.stop();
        expect(f.internals.activeWatchers.get(f.key)).toBe(token);
        // The ended source is never pulled again; only the replacement advances.
        expect(f.watched(0).pulls).toBe(2);
        f.send(444, 1);
        await f.until(
          () => f.watched(1).pulls === 2,
          'the replacement batch to be admitted',
        );
        expect(f.state().sourceState).toEqual({ cursor: 444 });
        expect(f.readPersisted().sourceState).toEqual({ cursor: 444 });
      }
      expect(reservedWhileWaiting).toBe(true);
      expect(reservedAfterAdmission).toBe(true);
      expect(f.errors).toEqual([
        ...(successor === 'watch'
          ? [
              'Notify edit blocked; accepted holds retained: owned closed gate fault',
            ]
          : []),
        ...(ending === 'error' ? ['Owned iterator failure'] : []),
      ]);
      expect(f.calls).toBe(successor === 'poll' ? 2 : 1);
    });
  }
}

for (const error of [false, true]) {
  it(`stop drops a batch waiting at a closed gate without writes or leaked ownership, cleanupError=${error}`, async () => {
    const f = fixture();
    const handle = await f.start();
    await f.block();
    const original = f.state();
    if (error) f.failCleanup();
    f.send(111);
    await f.until(f.gated, 'the batch to wait at the closed gate');
    await handle.stop();
    // Dropping the batch closes the iterator; a failing cleanup after abort is not reported.
    expect(f.watched(0).returned).toBe(true);
    expect(f.watched(0).pulls).toBe(1);
    expect(f.state()).toEqual(original);
    expect(f.readPersisted()).toEqual(original);
    expect(f.internals.activeWatchers.has(f.key)).toBe(false);
    expect(f.internals.watchPolicies.size).toBe(0);
    expect(f.errors).toEqual([]);
    expect(f.cleanupHistory()).toEqual([]);
    // Reconciliation after stop cannot resurrect the dropped batch's baseline.
    f.recover();
    const next = f.tick();
    await f.pollStarted.promise;
    expect(f.durableAtPoll[0]).toEqual({ cursor: 1 });
    f.pollResult.resolve({ observations: [], nextState: { cursor: 999 } });
    await next;
    expect(f.previous[1]).toEqual({ cursor: 1 });
    expect(f.state().sourceState).toEqual({ cursor: 999 });
  });
}

it('a batch waiting when its watcher is superseded is never admitted and releases only its own lease', async () => {
  const f = fixture();
  const handle = await f.start();
  await f.block();
  f.send(111);
  await f.until(f.gated, 'the batch to wait at the closed gate');
  // This precise token seam represents a distinct owner; it neither fakes the
  // actual batch/waiter nor allows the old owner to remove the successor.
  const successor = Symbol('successor');
  f.internals.retainNotifyPolicy('held', f.root);
  f.internals.activeWatchers.set(f.key, successor);
  try {
    f.recover();
    // Reopening the gate wakes the batch, whose admission rechecks ownership in
    // that same turn; the successor's scope also keeps this tick from polling.
    await f.tick();
    await f.until(
      () => f.watched(0).returned,
      'the superseded watcher to close its source',
    );
    await handle.stop();
    expect(f.watched(0).pulls).toBe(1);
    expect(f.state().sourceState).toEqual({ cursor: 1 });
    expect(f.readPersisted().sourceState).toEqual({ cursor: 1 });
    expect(f.rows()).toEqual(['A']);
    expect(f.calls).toBe(1);
    expect(f.errors).toEqual([]);
    expect(f.internals.activeWatchers.get(f.key)).toBe(successor);
    expect(f.internals.watchPolicies.size).toBe(1);
  } finally {
    f.internals.activeWatchers.delete(f.key);
    f.internals.releaseNotifyPolicy('held', f.root);
  }
});

it('a watcher with a batch waiting at a closed gate excludes only its own monitor/workspace while foreign polling advances', async () => {
  const f = fixture();
  const handle = await f.start();
  await f.block();
  f.send(111);
  await f.until(f.gated, 'the batch to wait at the closed gate');
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
  const stillGated = f.gated();
  expect(f.store.getMonitorState('held', foreign).sourceState).toEqual({
    cursor: 555,
  });
  expect(f.store.getMonitorState('sibling', f.root).sourceState).toEqual({
    cursor: 555,
  });
  await handle.stop();
  expect(reserved).toBe(true);
  expect(stillGated).toBe(true);
  expect(f.calls).toBe(1);
  expect(f.state().sourceState).toEqual({ cursor: 1 });
  expect(f.readPersisted().sourceState).toEqual({ cursor: 1 });
});

it('completion without a pending batch promptly releases polling and cached policy ownership', async () => {
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
