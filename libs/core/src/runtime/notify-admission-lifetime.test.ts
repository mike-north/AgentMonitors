/** 002 §4.6 / accepted #556: asynchronous admissions retain work and release retired snapshots. */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { parseMonitor } from '../parser/parse-monitor.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationResult,
  ObservationSource,
  ObservationContext,
} from '../observation/types.js';
import type { MonitorDefinition } from '../schema/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Explicit barriers control observations and admission continuations without timing races. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const roots: string[] = [];
const clients: Database[] = [];
const handles: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  vi.useRealTimers();
  for (const client of clients.splice(0)) if (client.open) client.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function turns() {
  for (let i = 0; i < 32; i++) await Promise.resolve(undefined);
}
const DEBOUNCE = 'notify:\n  strategy: debounce\n  settle-for: 1h\n';

/** Actual files, source effects and owned SQLite expose both public and precise admission boundaries. */
function fixture(watched = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-20T08:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'notify-admission-'));
  roots.push(root);
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const file = path.join(dir, 'held.md');
  const started = deferred<undefined>();
  const observation = deferred<ObservationResult>();
  let calls = 0;
  let factories = 0;
  let inputs = 0;
  let label: unknown;
  let factoryCursor: unknown;
  const source: ObservationSource = {
    name: 'admission-source',
    stateful: true,
    scopeSchema: {
      type: 'object',
      properties: { interval: { type: 'string' }, label: { type: 'string' } },
    },
    async observe() {
      calls++;
      if (calls === 1)
        return {
          observations: [{ title: 'A', snapshotText: 'A', objectKey: 'obj' }],
          nextState: { cursor: 1 },
        };
      if (calls !== 2)
        throw new Error('A second observation is already in flight');
      started.resolve(undefined);
      return observation.promise;
    },
    ...(watched
      ? {
          watch(
            config: Record<string, unknown>,
            context: ObservationContext & { signal: AbortSignal },
          ) {
            factories++;
            label = config.label;
            factoryCursor = context.previousState;
            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              next(): Promise<IteratorResult<never>> {
                inputs++;
                return new Promise((resolve) => {
                  if (context.signal.aborted)
                    resolve({ done: true, value: undefined });
                  else
                    context.signal.addEventListener(
                      'abort',
                      () => resolve({ done: true, value: undefined }),
                      { once: true },
                    );
                });
              },
            };
          },
        }
      : {}),
  };
  const registry = new SourceRegistry();
  registry.register(source);
  const dbPath = path.join(root, 'state.sqlite');
  function open() {
    const db = createDb(dbPath);
    // Native driver access is solely for real fault injection and reopen assertions.
    const client = (db as unknown as { $client: Database }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    return {
      client,
      store,
      runtime: new AgentMonitorRuntime(
        store,
        registry,
        [claudeCodeAdapter],
        undefined,
        { sessionDormancyMs: 1_000 },
      ),
    };
  }
  let current = open();
  const session = current.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  function edit(
    policy = DEBOUNCE,
    nextLabel = 'old',
    body = 'Captured instructions',
  ) {
    writeFileSync(
      file,
      `---\nwatch:\n  type: admission-source\n  interval: 1h\n  label: ${nextLabel}\nbaseline-strategy: incremental\n${policy}---\n${body}\n`,
    );
    const monitor = parseMonitor(readFileSync(file, 'utf8'), file).monitor;
    if (!monitor) throw new Error('Invalid test definition');
    return monitor;
  }
  edit();
  const state = () => current.store.getMonitorState('held', root);
  const rows = () =>
    current.client
      .prepare('SELECT summary FROM monitor_events ORDER BY rowid')
      .pluck()
      .all();
  return {
    root,
    dir,
    file,
    registry,
    source,
    session,
    started,
    observation,
    edit,
    state,
    rows,
    get current() {
      return current;
    },
    get calls() {
      return calls;
    },
    get factories() {
      return factories;
    },
    get inputs() {
      return inputs;
    },
    get label() {
      return label;
    },
    get factoryCursor() {
      return factoryCursor;
    },
    tick: () => current.runtime.tick(dir, root),
    due() {
      current.store.setMonitorState('held', root, {
        ...state(),
        lastObservationAt: new Date('2000-01-01T00:00:00Z'),
      });
    },
    fault() {
      current.client.exec(
        "CREATE TRIGGER reject_a BEFORE INSERT ON monitor_events WHEN NEW.summary = 'A' BEGIN SELECT RAISE(FAIL, 'owned admission fault'); END",
      );
    },
    recover() {
      current.client.exec('DROP TRIGGER reject_a');
    },
    reopen() {
      current.client.close();
      current = open();
    },
    async watch() {
      const handle = await current.runtime.watchMonitors(dir, root);
      handles.push(handle);
      return handle;
    },
    async prepare(monitor: MonitorDefinition) {
      const acc = {
        evaluated: [],
        emittedEventIds: [],
        erroredObservations: [],
        skippedMonitors: [],
      };
      // Boundary instrumentation calls the real reconciler; no gate, store or waiter result is fabricated.
      const runtime = current.runtime as unknown as {
        prepareNotifyPolicy(
          m: MonitorDefinition,
          w: string,
          a: typeof acc,
        ): Promise<boolean>;
      };
      return runtime.prepareNotifyPolicy(monitor, root, acc);
    },
    policies() {
      return (
        current.runtime as unknown as {
          watchPolicies: Map<string, MonitorDefinition | null>;
        }
      ).watchPolicies;
    },
  };
}

for (const recovery of ['tick', 'startup'] as const) {
  it(`public overlapping polls retain B across a blocked edit and ${recovery} recovery without deadlocking the rescan`, async () => {
    const f = fixture(recovery === 'startup');
    await f.tick();
    f.due();
    const slow = f.tick();
    await f.started.promise;
    f.edit('', 'new', 'New instructions');
    f.fault();
    const failed = await f.tick();
    expect(
      failed.erroredObservations.some((e) =>
        e.message.includes('owned admission fault'),
      ),
    ).toBe(true);
    const original = f.state();
    f.observation.resolve({
      observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
      nextState: { cursor: 999 },
    });
    // The public tick must finish without waiting for a future tick to recover its gate.
    await slow;
    expect(f.state()).toEqual(original);
    expect(f.rows()).toEqual([]);
    expect(f.calls).toBe(2);
    if (recovery === 'startup') {
      await f.watch();
      await turns();
      expect(f.factories).toBe(0);
    }
    f.recover();
    if (recovery === 'startup') {
      await f.watch();
      await turns();
      expect(f.factories).toBe(1);
    } else await f.tick();
    expect(f.rows()).toEqual(['A', 'B']);
    expect(f.state().sourceState).toEqual({ cursor: 999 });
    expect(f.calls).toBe(2);
    expect(
      f.current.store
        .listEvents({ sessionId: f.session.id })
        .find((e) => e.summary === 'B')?.body,
    ).toBe('Captured instructions');
    expect(f.current.store.latestSnapshot('held', 'obj', f.root)?.content).toBe(
      'B',
    );
    for (const handle of handles.splice(0)) await handle.stop();
    f.reopen();
    expect(f.rows()).toEqual(['A', 'B']);
    expect(f.state().sourceState).toEqual({ cursor: 999 });
    await f.tick();
    expect(f.rows()).toEqual(['A', 'B']);
  });
}

it('a newer successful policy governs the in-flight poll while captured handling and healthy siblings/workspaces stay independent', async () => {
  const f = fixture();
  await f.tick();
  f.due();
  const slow = f.tick();
  await f.started.promise;
  const healthy: ObservationSource = {
    name: 'healthy',
    scopeSchema: { type: 'object' },
    async observe() {
      return {
        observations: [{ title: 'healthy' }],
        nextState: { healthy: true },
      };
    },
  };
  f.registry.register(healthy);
  writeFileSync(
    path.join(f.dir, 'sibling.md'),
    '---\nwatch:\n  type: healthy\n---',
  );
  f.edit(
    "notify:\n  strategy: rollup\n  window: '0 0 1 1 *'\n",
    'new',
    'Edited instructions',
  );
  await f.tick();
  const foreign = path.join(f.root, 'foreign');
  mkdirSync(foreign);
  writeFileSync(
    path.join(foreign, 'held.md'),
    '---\nwatch:\n  type: healthy\n---',
  );
  await f.current.runtime.tick(foreign, foreign);
  f.observation.resolve({
    observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
    nextState: { cursor: 999 },
  });
  await slow;
  expect(f.state().notifyState.pendingRollup?.observations).toHaveLength(1);
  expect(
    f.state().notifyState.pendingRollup?.observations[0]?.monitor.instructions,
  ).toBe('Captured instructions');
  expect(f.state().sourceState).toEqual({ cursor: 999 });
  expect(f.calls).toBe(2);
  expect(f.current.store.getMonitorState('held', foreign).sourceState).toEqual({
    healthy: true,
  });
  expect(f.rows().filter((row) => row === 'healthy')).toHaveLength(2);
});

for (const action of ['blocked', 'abort', 'newer'] as const) {
  it(`watch source creation rereads ${action} admission at the actual factory turn`, async () => {
    const f = fixture(true);
    await f.tick();
    const captured = deferred<undefined>();
    const resume = deferred<undefined>();
    const runtime = f.current.runtime as unknown as {
      waitForWatchDefinition(
        id: string,
        workspace: string,
        signal: AbortSignal,
      ): Promise<MonitorDefinition | undefined>;
    };
    const original = runtime.waitForWatchDefinition.bind(runtime);
    let first = true;
    runtime.waitForWatchDefinition = async (...args) => {
      const result = await original(...args);
      if (first) {
        first = false;
        captured.resolve(undefined);
        await resume.promise;
      }
      return result;
    };
    const handle = await f.watch();
    await captured.promise;
    let stopping: Promise<void> | undefined;
    if (action === 'abort') stopping = handle.stop();
    else {
      const edited = f.edit('', 'new', 'New handling');
      if (action === 'blocked') f.fault();
      await f.prepare(edited);
    }
    resume.resolve(undefined);
    await turns();
    if (action === 'newer') {
      expect(f.factories).toBe(1);
      expect(f.inputs).toBe(1);
      expect(f.label).toBe('new');
    } else {
      expect(f.factories).toBe(0);
      expect(f.inputs).toBe(0);
      if (action === 'blocked') {
        expect(f.rows()).toEqual([]);
        f.recover();
        await f.prepare(f.edit('', 'new'));
        await turns();
        expect(f.factories).toBe(1);
        expect(f.label).toBe('new');
      }
    }
    await stopping;
  });
}

for (const retirement of ['cancel', 'close', 'dormant'] as const) {
  it(`poll-only declaration ${retirement} releases all private snapshots without touching durable history`, async () => {
    const f = fixture();
    f.registry.register({
      name: 'ephemeral',
      scopeSchema: { type: 'object' },
      async observe() {
        return { observations: [{ title: 'accepted ephemeral' }] };
      },
    });
    rmSync(f.file);
    for (let i = 0; i < 12; i++) {
      const session =
        retirement === 'cancel'
          ? f.session
          : f.current.runtime.openSession(
              claudeCodeAdapter.createSessionInput({
                hostSessionId: `lead-${i}`,
                workspacePath: f.root,
              }),
            );
      const record = f.current.runtime.declareEphemeralMonitor({
        sessionId: session.id,
        source: 'ephemeral',
        scope: {},
        instruction: `private-retired-${i}-${'x'.repeat(4096)}`,
      });
      await f.tick();
      if (retirement === 'cancel')
        f.current.runtime.cancelEphemeralMonitor(session.id, record.id);
      else if (retirement === 'close')
        f.current.runtime.closeSession(session.id);
      else {
        vi.setSystemTime(new Date(Date.now() + 2_000));
        await f.tick();
      }
      expect(f.current.runtime.listEphemeralMonitors(session.id)).toEqual([]);
      expect(f.policies().size).toBe(0);
    }
    expect(f.rows()).toHaveLength(12);
    expect(JSON.stringify([...f.policies().values()])).not.toContain(
      'private-retired-',
    );
  });
}

it('persistent poll snapshots retire after deletion; live blocked watcher state survives until its own stop', async () => {
  const f = fixture(true);
  await f.tick();
  expect(f.policies().size).toBe(0);
  const handle = await f.watch();
  await turns();
  expect(f.policies().size).toBe(1);
  const original = f.state();
  rmSync(f.file);
  await f.tick();
  expect(f.state()).toEqual(original);
  expect(f.policies().size).toBe(1);
  await handle.stop();
  expect(f.policies().size).toBe(0);
  expect(f.state()).toEqual(original);
  f.edit();
  await f.tick();
  expect(f.policies().size).toBe(0);
});

for (const retirement of ['cancel', 'close', 'dormant'] as const) {
  it(`${retirement} retires an in-flight ephemeral admission without resurrecting timing or retaining its definition`, async () => {
    const f = fixture();
    rmSync(f.file);
    const record = f.current.runtime.declareEphemeralMonitor({
      sessionId: f.session.id,
      source: f.source.name,
      scope: { interval: '1h' },
      instruction: 'Private lifetime',
    });
    await f.tick();
    const state = () => f.current.store.getMonitorState(record.id, f.root);
    f.current.store.setMonitorState(record.id, f.root, {
      ...state(),
      lastObservationAt: new Date('2000-01-01T00:00:00Z'),
    });
    const original = state();
    const slow = f.tick();
    await f.started.promise;
    if (retirement === 'cancel')
      f.current.runtime.cancelEphemeralMonitor(f.session.id, record.id);
    else if (retirement === 'close')
      f.current.runtime.closeSession(f.session.id);
    else {
      vi.setSystemTime(new Date(Date.now() + 2_000));
      await f.tick();
    }
    f.observation.resolve({
      observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
      nextState: { cursor: 999 },
    });
    await slow;
    expect(state()).toEqual(original);
    expect(f.rows()).toEqual(['A']);
    expect(f.policies().size).toBe(0);
  });
}

it('startup waits for an in-flight public poll before creating a source with the admitted baseline', async () => {
  const f = fixture(true);
  await f.tick();
  f.due();
  const slow = f.tick();
  await f.started.promise;
  f.edit('', 'new', 'New handling');
  await f.watch();
  await turns();
  expect(f.factories).toBe(0);
  expect(f.rows()).toEqual(['A']);
  f.observation.resolve({
    observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
    nextState: { cursor: 999 },
  });
  await slow;
  await turns();
  expect(f.factories).toBe(1);
  expect(f.inputs).toBe(1);
  expect(f.label).toBe('new');
  expect(f.factoryCursor).toEqual({ cursor: 999 });
  expect(f.rows()).toEqual(['A', 'B']);
});

it('reopen before deferred admission preserves accepted holds/cursor and reobserves from that durable cursor', async () => {
  const f = fixture();
  await f.tick();
  f.due();
  const slow = f.tick();
  await f.started.promise;
  f.edit('');
  f.fault();
  await f.tick();
  const original = f.state();
  f.observation.resolve({
    observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
    nextState: { cursor: 999 },
  });
  await slow;
  expect(f.state()).toEqual(original);
  f.recover();
  f.reopen();
  expect(f.state()).toEqual(original);
  expect(f.rows()).toEqual([]);
  // The process-local result is not a durable outbox. Restart must resume the
  // source from its old persisted cursor, allowing the source to return B again.
  f.source.observe = async (_config, context) => {
    expect(context.previousState).toEqual({ cursor: 1 });
    return {
      observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
      nextState: { cursor: 999 },
    };
  };
  await f.tick();
  expect(f.rows()).toEqual(['A', 'B']);
  expect(f.state().sourceState).toEqual({ cursor: 999 });
  await f.tick();
  expect(f.rows()).toEqual(['A', 'B']);
});
