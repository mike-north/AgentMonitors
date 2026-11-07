/** 002 §4.6: factory capability does not exempt existing scoped ownership from startup reconciliation. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  Observation,
  ObservationContext,
  ObservationResult,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Source barriers control actual observations, not runtime/admission implementations. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});
async function settle() {
  for (let i = 0; i < 12; i++) await turn();
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await turn();
  expect(predicate()).toBe(true);
}
const DEBOUNCE = 'notify:\n  strategy: debounce\n  settle-for: 1h\n';

/** Public watcher/poll ownership and actual SQLite make the pre-factory reconciliation boundary observable. */
async function fixture(mode: 'watch' | 'poll' | 'none') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-20T09:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'notify-observe-only-'));
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const file = path.join(dir, 'held.md');
  const dbPath = path.join(root, 'state.sqlite');
  const db = createDb(dbPath);
  // Native access injects real rollback faults and proves state after full close/reopen.
  const client = (db as unknown as { $client: Database }).$client;
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  const started = deferred<undefined>();
  const completion = deferred<ObservationResult>();
  let context: (ObservationContext & { signal: AbortSignal }) | undefined;
  let next: ((result: IteratorResult<Observation>) => void) | undefined;
  let factories = 0;
  let oldPollCalls = 0;
  let observeOnlyCalls = 0;
  let factoryToken: unknown;
  let healthyFactories = 0;
  const tasks: Promise<unknown>[] = [];
  const handles: { stop(): Promise<void> }[] = [];
  const errors: { monitorId: string; message: string }[] = [];
  registry.register({
    name: 'watched',
    stateful: true,
    scopeSchema: { type: 'object' },
    async observe() {
      oldPollCalls++;
      if (mode === 'watch')
        throw new Error('Established watcher must not poll');
      if (oldPollCalls === 1)
        return {
          observations: [{ title: 'A', snapshotText: 'A', objectKey: 'obj' }],
          nextState: { cursor: 1 },
        };
      if (oldPollCalls === 2) {
        started.resolve(undefined);
        return completion.promise;
      }
      throw new Error('Startup must not start another observation');
    },
    watch(config, ctx) {
      factories++;
      factoryToken = config.token;
      context = ctx;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<Observation>> {
          return new Promise((resolve) => {
            next = resolve;
            if (ctx.signal.aborted) resolve({ done: true, value: undefined });
            else
              ctx.signal.addEventListener(
                'abort',
                () => resolve({ done: true, value: undefined }),
                { once: true },
              );
          });
        },
      };
    },
  });
  registry.register({
    name: 'observe-only',
    stateful: true,
    scopeSchema: {
      type: 'object',
      properties: { token: { type: 'string' } },
      required: ['token'],
    },
    async observe() {
      observeOnlyCalls++;
      return { observations: [] };
    },
  });
  registry.register({
    name: 'healthy',
    scopeSchema: { type: 'object' },
    async observe() {
      throw new Error('Startup must not poll healthy sources');
    },
    watch(_config, ctx) {
      healthyFactories++;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<never>> {
          return new Promise((resolve) => {
            if (ctx.signal.aborted) resolve({ done: true, value: undefined });
            else
              ctx.signal.addEventListener(
                'abort',
                () => resolve({ done: true, value: undefined }),
                { once: true },
              );
          });
        },
      };
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  function text(
    source: string,
    token: string | number,
    notify: string,
    body: string,
  ) {
    return (
      '---\nwatch:\n  type: ' +
      source +
      '\n  interval: 1h\n  token: ' +
      JSON.stringify(token) +
      '\nbaseline-strategy: incremental\n' +
      notify +
      '---\n' +
      body +
      '\n'
    );
  }
  function edit(
    source = 'observe-only',
    token: string | number = 'new',
    notify = '',
  ) {
    writeFileSync(
      file,
      text(
        source,
        token,
        notify,
        source === 'watched' ? 'Original handling.' : 'Edited handling.',
      ),
    );
  }
  edit(
    mode === 'none' ? 'observe-only' : 'watched',
    mode === 'none' ? 7 : 'initial',
    mode === 'none' ? '' : DEBOUNCE,
  );
  const state = () => store.getMonitorState('held', root);
  const rows = () =>
    client
      .prepare(
        "SELECT summary, body, source_name FROM monitor_events WHERE monitor_id = 'held' ORDER BY rowid",
      )
      .all();
  const tick = () => {
    const task = runtime.tick(dir, root);
    tasks.push(task);
    return task;
  };
  const startup = async (scanDir = dir, workspace = root) => {
    const first = errors.length;
    const task = runtime.watchMonitors(scanDir, workspace, {
      onError: (monitorId, error) =>
        errors.push({ monitorId, message: error.message }),
    });
    tasks.push(task);
    const handle = await task;
    handles.push(handle);
    await settle();
    return { handle, errors: errors.slice(first) };
  };
  cleanups.push(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
    completion.resolve({
      observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
      nextState: { cursor: 2 },
    });
    await Promise.allSettled(tasks);
    if (client.open) client.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (mode === 'watch') {
    await startup();
    await until(() => next !== undefined);
  }
  if (mode === 'poll') await tick();
  return {
    root,
    dir,
    file,
    client,
    store,
    runtime,
    state,
    rows,
    tick,
    startup,
    edit,
    text,
    started,
    completion,
    get factories() {
      return factories;
    },
    get oldPollCalls() {
      return oldPollCalls;
    },
    get observeOnlyCalls() {
      return observeOnlyCalls;
    },
    get factoryToken() {
      return factoryToken;
    },
    get healthyFactories() {
      return healthyFactories;
    },
    async emit(title: string) {
      await until(() => next !== undefined);
      const accept = next;
      next = undefined;
      if (!accept) throw new Error('Source is not requesting input');
      accept({
        done: false,
        value: { title, snapshotText: title, objectKey: 'obj' },
      });
      await settle();
    },
    checkpoint() {
      if (!context?.checkpoint)
        throw new Error('Actual source checkpoint unavailable');
      const task = context.checkpoint({ cursor: 999 });
      tasks.push(task);
      return task;
    },
    due() {
      store.setMonitorState('held', root, {
        ...state(),
        lastObservationAt: new Date('2000-01-01T00:00:00Z'),
      });
    },
    healthy() {
      writeFileSync(
        path.join(dir, 'z-healthy.md'),
        text('healthy', 'healthy', '', 'Healthy'),
      );
    },
    owners: () =>
      (runtime as unknown as { notifyPolicyUsers: Map<string, unknown> })
        .notifyPolicyUsers,
    async reopen() {
      for (const handle of handles.splice(0)) await handle.stop();
      await Promise.allSettled(tasks);
      const expectedState = state();
      const expectedRows = rows();
      client.close();
      const reader = createDb(dbPath);
      const readerClient = (reader as unknown as { $client: Database }).$client;
      try {
        expect(new RuntimeStore(reader).getMonitorState('held', root)).toEqual(
          expectedState,
        );
        expect(
          readerClient
            .prepare(
              "SELECT summary, body, source_name FROM monitor_events WHERE monitor_id = 'held' ORDER BY rowid",
            )
            .all(),
        ).toEqual(expectedRows);
      } finally {
        readerClient.close();
      }
    },
  };
}

/** Pinned execution/handling produces the same old-source artifacts under newly reconciled pacing. */
const AB = [
  { summary: 'A', body: 'Original handling.', source_name: 'watched' },
  { summary: 'B', body: 'Original handling.', source_name: 'watched' },
];

for (const failure of ['scope', 'sqlite'] as const) {
  it(
    'observe-only startup ' +
      failure +
      ' blocks an existing watcher and recovers before checkpoint/yield',
    async () => {
      const f = await fixture('watch');
      await f.emit('A');
      const retained = f.state();
      f.edit('observe-only', failure === 'scope' ? 7 : 'new');
      f.healthy();
      if (failure === 'sqlite')
        f.client.exec(
          "CREATE TRIGGER startup_fault BEFORE INSERT ON monitor_events BEGIN SELECT RAISE(FAIL, 'owned startup drain fault'); END",
        );
      const failed = await f.startup();
      let settled = false;
      const checkpoint = f.checkpoint().then(() => {
        settled = true;
      });
      await f.emit('B');
      const blocked = f.state();
      const acceptedWhileBlocked = settled;
      const repeated = await f.startup();
      const afterRepeated = f.state();
      const acceptedAfterRepeat = settled;
      if (failure === 'sqlite') f.client.exec('DROP TRIGGER startup_fault');
      f.edit();
      const recovery = await f.startup();
      await settle();
      const recoveredByStartup = f.rows().length === 2;
      // Cleanup recovery for a parent regression occurs only after capturing its actual startup result.
      if (!recoveredByStartup) await f.tick();
      await checkpoint;
      await until(() => f.rows().length === 2);
      expect(
        failed.errors.some((item) =>
          item.message.includes(
            failure === 'scope'
              ? 'Invalid monitor definition'
              : 'owned startup drain fault',
          ),
        ),
      ).toBe(true);
      expect(repeated.errors).not.toEqual([]);
      expect(blocked).toEqual(retained);
      expect(afterRepeated).toEqual(retained);
      expect(acceptedWhileBlocked).toBe(false);
      expect(acceptedAfterRepeat).toBe(false);
      expect(recovery.errors).toEqual([]);
      expect(recoveredByStartup).toBe(true);
      expect(f.rows()).toEqual(AB);
      expect(f.state().sourceState).toEqual({ cursor: 999 });
      expect(f.factories).toBe(1);
      expect(f.factoryToken).toBe('initial');
      expect(f.observeOnlyCalls).toBe(0);
      expect(f.oldPollCalls).toBe(0);
      expect(f.healthyFactories).toBe(1);
      await f.reopen();
      expect(f.owners().size).toBe(0);
    },
  );
}

it('valid observe-only startup drains old work while preserving its established watcher and handling', async () => {
  const f = await fixture('watch');
  await f.emit('A');
  f.edit();
  const startup = await f.startup();
  const committedBeforeCheckpoint = f.rows();
  await f.checkpoint();
  await f.emit('B');
  const acceptedBeforeTick = f.rows();
  expect(startup.errors).toEqual([]);
  expect(startup.handle.monitorIds).toEqual([]);
  expect(committedBeforeCheckpoint).toEqual([AB[0]]);
  expect(acceptedBeforeTick).toEqual(AB);
  expect(f.factories).toBe(1);
  expect(f.factoryToken).toBe('initial');
  expect(f.observeOnlyCalls).toBe(0);
  expect(f.oldPollCalls).toBe(0);
  expect(f.state().notifyState.pendingDebounce).toBeUndefined();
  await f.reopen();
});

for (const blocked of [false, true]) {
  it(
    'observe-only startup reconciles an evaluating or retained poll, blocked=' +
      blocked,
    async () => {
      const f = await fixture('poll');
      f.due();
      const slow = f.tick();
      await f.started.promise;
      const retained = f.state();
      f.edit('observe-only', blocked ? 7 : 'new');
      const first = await f.startup();
      f.completion.resolve({
        observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
        nextState: { cursor: 2 },
      });
      await slow;
      const afterPoll = f.state();
      if (blocked) {
        f.edit();
        const recovery = await f.startup();
        const recoveredByStartup = f.rows().length === 2;
        if (!recoveredByStartup) await f.tick();
        expect(
          first.errors.some((item) =>
            item.message.includes('Invalid monitor definition'),
          ),
        ).toBe(true);
        expect(afterPoll).toEqual(retained);
        expect(recovery.errors).toEqual([]);
        expect(recoveredByStartup).toBe(true);
      } else expect(first.errors).toEqual([]);
      expect(f.rows()).toEqual(AB);
      expect(f.state().sourceState).toEqual({ cursor: 2 });
      expect(f.oldPollCalls).toBe(2);
      expect(f.observeOnlyCalls).toBe(0);
      expect(f.factories).toBe(0);
      expect(f.owners().size).toBe(0);
      await f.reopen();
    },
  );
}

it('unowned observe-only scope stays untouched even when another local watcher is started', async () => {
  const f = await fixture('none');
  f.store.setMonitorState('held', f.root, {
    sourceState: { cursor: 55 },
    notifyState: { suppressedUntil: '2026-03-20T10:00:00Z' },
    lastObservationAt: new Date('2026-03-20T09:00:00Z'),
  });
  const before = f.client
    .prepare("SELECT * FROM monitor_state WHERE monitor_id = 'held'")
    .get();
  vi.setSystemTime(new Date('2026-03-20T09:00:02Z'));
  f.healthy();
  const startup = await f.startup();
  const repeated = await f.startup();
  expect(startup.errors).toEqual([]);
  expect(repeated.errors).toEqual([]);
  expect(startup.handle.monitorIds).toEqual(['z-healthy']);
  expect(repeated.handle.monitorIds).toEqual([]);
  expect(
    f.client
      .prepare("SELECT * FROM monitor_state WHERE monitor_id = 'held'")
      .get(),
  ).toEqual(before);
  expect(f.owners().has(JSON.stringify([f.root, 'held']))).toBe(false);
  expect(f.observeOnlyCalls).toBe(0);
  expect(f.oldPollCalls).toBe(0);
  expect(f.factories).toBe(0);
  expect(f.healthyFactories).toBe(1);
  await f.reopen();
});

it('same-ID foreign live ownership cannot cause startup to reconcile an unowned local observe-only scope', async () => {
  const f = await fixture('none');
  f.store.setMonitorState('held', f.root, {
    sourceState: { cursor: 55 },
    notifyState: { suppressedUntil: '2026-03-20T10:00:00Z' },
    lastObservationAt: new Date('2026-03-20T09:00:00Z'),
  });
  const before = f.state();
  const foreign = path.join(f.root, 'foreign');
  mkdirSync(foreign);
  writeFileSync(
    path.join(foreign, 'held.md'),
    f.text('watched', 'foreign', DEBOUNCE, 'Foreign handling'),
  );
  await f.startup(foreign, foreign);
  expect(f.state()).toEqual(before);
  const local = await f.startup();
  expect(local.errors).toEqual([]);
  expect(local.handle.monitorIds).toEqual([]);
  expect(f.state()).toEqual(before);
  expect(f.owners().has(JSON.stringify([f.root, 'held']))).toBe(false);
  expect(f.owners().has(JSON.stringify([foreign, 'held']))).toBe(true);
  expect(f.observeOnlyCalls).toBe(0);
  expect(f.oldPollCalls).toBe(0);
  await f.reopen();
});
