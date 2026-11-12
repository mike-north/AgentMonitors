/** Accepted #556 / 002 §4.6: effective edits fence actual durable watcher acceptance. */
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
  Observation,
  ObservationContext,
  ObservationSource,
} from '../observation/types.js';
import type { MonitorDefinition } from '../schema/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import { notifyPolicyKey } from './notify-policy.js';

/** Holds have not settled when the effective policy is edited. */
const START = new Date('2026-03-20T08:00:00Z');
const DEBOUNCE = 'notify:\n  strategy: debounce\n  settle-for: 10s\n';
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

/** Explicit microtask turns expose the real serialization chain without clock-based races. */
async function turns() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

/** Own the SQLite file, authored definition, lead hook files, source and cancellation. */
function fixture(policy = DEBOUNCE, urgency = 'normal') {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'notify-boundaries-'));
  roots.push(root);
  const monitors = path.join(root, 'monitors');
  const file = path.join(monitors, 'held', 'MONITOR.md');
  mkdirSync(path.dirname(file), { recursive: true });
  const queue: Observation[] = [
    { title: 'A', snapshotText: 'A', objectKey: 'obj' },
  ];
  let context: (ObservationContext & { signal: AbortSignal }) | undefined;
  let releaseYield: ((value: IteratorResult<Observation>) => void) | undefined;
  let calls = 0;
  let finishImmediately = false;
  const source: ObservationSource = {
    name: 'boundary-source',
    stateful: true,
    scopeSchema: {
      type: 'object',
      properties: { interval: { type: 'string' } },
    },
    async observe() {
      calls++;
      return { observations: queue.splice(0), nextState: { cursor: 1 } };
    },
    watch(_config, ctx) {
      context = ctx;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<Observation>> {
          if (finishImmediately || ctx.signal.aborted)
            return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => {
            releaseYield = resolve;
            ctx.signal.addEventListener(
              'abort',
              () => resolve({ done: true, value: undefined }),
              { once: true },
            );
          });
        },
      };
    },
  };
  const registry = new SourceRegistry();
  registry.register(source);
  function open() {
    const db = createDb(path.join(root, 'state.sqlite'));
    // Test-only native driver access injects real SQLite failures, never fake store results.
    const client = (db as unknown as { $client: Database }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    return {
      client,
      store,
      runtime: new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]),
    };
  }
  let current = open();
  const lead = current.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  const foreignRoot = path.join(root, 'foreign');
  mkdirSync(foreignRoot);
  const foreign = current.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'foreign',
      workspacePath: foreignRoot,
    }),
  );
  function edit(next = policy, band = urgency, body = 'Captured instructions') {
    writeFileSync(
      file,
      `---\nwatch:\n  type: boundary-source\n  interval: 1h\nurgency: ${band}\nbaseline-strategy: incremental\n${next}---\n${body}\n`,
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
    queue,
    edit,
    source,
    lead,
    foreign,
    state,
    rows,
    get current() {
      return current;
    },
    get calls() {
      return calls;
    },
    tick: () => current.runtime.tick(monitors, root),
    reopen() {
      current.client.close();
      context = undefined;
      current = open();
    },
    hook(session = lead) {
      return JSON.parse(readFileSync(session.hookStatePath, 'utf8'));
    },
    async watch(complete = false) {
      finishImmediately = complete;
      const handle = await current.runtime.watchMonitors(monitors, root);
      handles.push(handle);
      await turns();
      expect(context).toBeDefined();
      return handle;
    },
    checkpoint() {
      if (!context?.checkpoint)
        throw new Error('Actual source checkpoint is not ready');
      return context.checkpoint({ cursor: 999 });
    },
    yieldC() {
      if (!releaseYield) throw new Error('Actual watcher is not waiting');
      releaseYield({
        done: false,
        value: { title: 'C', snapshotText: 'C', objectKey: 'obj' },
      });
    },
    async prepare(monitor: MonitorDefinition) {
      const acc = {
        evaluated: [],
        emittedEventIds: [],
        erroredObservations: [],
        skippedMonitors: [],
      };
      // Test-only access calls the actual owned transaction and gate transition. No gate/waiter is mocked.
      const runtime = current.runtime as unknown as {
        prepareNotifyPolicy(
          m: MonitorDefinition,
          w: string,
          a: typeof acc,
        ): Promise<boolean>;
      };
      const accepted = await runtime.prepareNotifyPolicy(monitor, root, acc);
      return { accepted, acc };
    },
    fault() {
      current.client.exec(
        "CREATE TRIGGER reject_a BEFORE INSERT ON monitor_events WHEN NEW.summary = 'A' BEGIN SELECT RAISE(FAIL, 'owned drain fault'); END",
      );
    },
    recover() {
      current.client.exec('DROP TRIGGER reject_a');
    },
  };
}

for (const restart of [false, true]) {
  it(`immediate escalation grant edit drains captured high work before the source is due, restart=${restart}`, async () => {
    const f = fixture('', 'low..high');
    f.queue[0] = {
      title: 'A',
      snapshotText: 'A',
      objectKey: 'obj',
      salience: 'high',
    };
    await f.tick();
    expect(f.state().notifyState.pendingDebounce?.observations).toHaveLength(1);
    f.edit('', 'normal..high', 'New instructions');
    if (restart) f.reopen();
    const result = await f.tick();
    expect(result.emittedEventIds).toHaveLength(1);
    expect(f.state().notifyState.pendingDebounce).toBeUndefined();
    expect(f.calls).toBe(1);
    expect(
      f.current.store.listEvents({ sessionId: f.lead.id })[0],
    ).toMatchObject({ body: 'Captured instructions', urgency: 'high' });
    expect(f.state().lastObservationAt?.toISOString()).toBe(
      START.toISOString(),
    );
  });
}

it('policy identity includes escalation in throttle and preserves scalar/equivalent controls', () => {
  const f = fixture();
  const throttle = 'notify:\n  strategy: throttle\n  suppress-for: 1m\n';
  expect(notifyPolicyKey(f.edit(throttle, 'low..high'))).not.toBe(
    notifyPolicyKey(f.edit(throttle, 'normal..high')),
  );
  expect(notifyPolicyKey(f.edit(throttle, 'low'))).toBe(
    notifyPolicyKey(f.edit(throttle, 'high')),
  );
  expect(notifyPolicyKey(f.edit(throttle, 'normal', 'Old'))).toBe(
    notifyPolicyKey(f.edit(throttle.replace('1m', '60s'), 'normal', 'New')),
  );
});

for (const operation of ['checkpoint', 'yield'] as const) {
  for (const timing of [
    'blocked',
    operation === 'checkpoint' ? 0 : 1,
  ] as const) {
    const interleave = timing !== 'blocked';
    it(`${operation} stays fenced by a failed edit, close-microtask=${timing}`, async () => {
      const f = fixture();
      await f.tick();
      await f.watch();
      const original = f.state();
      // A stale yield must not enter ordinary overdue flushing while its edit is blocked.
      if (operation === 'yield')
        vi.setSystemTime(new Date(START.getTime() + 11_000));
      const edited = f.edit('');
      f.fault();
      let pending: Promise<void> | undefined;
      const enqueue = () => {
        if (operation === 'checkpoint') pending = f.checkpoint();
        else f.yieldC();
      };
      if (interleave) {
        enqueue();
        // The operation has entered the actual watcher chain. Reconciliation then closes its gate.
        await new Promise<void>((resolve) => {
          const close = (remaining: number) =>
            queueMicrotask(() => {
              if (remaining > 0) close(remaining - 1);
              else void f.prepare(edited).then(() => resolve());
            });
          close(timing === 'blocked' ? 0 : timing);
        });
      } else {
        expect((await f.prepare(edited)).accepted).toBe(false);
        enqueue();
      }
      await turns();
      expect(f.state()).toEqual(original);
      expect(f.rows()).toEqual([]);
      expect(f.hook().unread.total).toBe(0);
      f.recover();
      expect((await f.prepare(edited)).accepted).toBe(true);
      await pending;
      await turns();
      expect(f.rows()).toEqual(operation === 'yield' ? ['A', 'C'] : ['A']);
      expect(f.state().sourceState).toEqual({
        cursor: operation === 'checkpoint' ? 999 : 1,
      });
      expect(
        f.current.store.latestSnapshot('held', 'obj', f.root)?.content,
      ).toBe(operation === 'yield' ? 'C' : 'A');
    });
  }
}

it('cancellation releases a checkpoint caught by the failed-drain gate without persisting it', async () => {
  const f = fixture();
  await f.tick();
  const handle = await f.watch();
  const original = f.state();
  f.fault();
  const edited = f.edit('');
  const pending = f.checkpoint();
  await new Promise<void>((resolve) =>
    queueMicrotask(() => {
      void f.prepare(edited).then(() => resolve());
    }),
  );
  await turns();
  await handle.stop();
  await pending;
  expect(f.state()).toEqual(original);
  expect(f.rows()).toEqual([]);
});

for (const complete of [false, true]) {
  it(`startup drain refreshes the actual lead hook without tick/yield, completes=${complete}`, async () => {
    const f = fixture();
    await f.tick();
    const foreignBefore = readFileSync(f.foreign.hookStatePath, 'utf8');
    expect(f.hook().unread.total).toBe(0);
    f.edit('');
    f.reopen();
    await f.watch(complete);
    expect(f.rows()).toEqual(['A']);
    expect(f.hook()).toMatchObject({
      unread: { normal: 1, total: 1 },
      hasPendingNormal: true,
    });
    expect(readFileSync(f.foreign.hookStatePath, 'utf8')).toBe(foreignBefore);
    expect(f.current.store.listEvents({ sessionId: f.foreign.id })).toEqual([]);
    expect(f.calls).toBe(1);
  });
}

it('a failed startup drain leaves the hook unchanged until committed retry without a tick', async () => {
  const f = fixture();
  await f.tick();
  f.edit('');
  f.reopen();
  f.fault();
  const before = readFileSync(f.lead.hookStatePath, 'utf8');
  const blocked = await f.current.runtime.watchMonitors(
    path.join(f.root, 'monitors'),
    f.root,
  );
  handles.push(blocked);
  await turns();
  expect(f.rows()).toEqual([]);
  expect(readFileSync(f.lead.hookStatePath, 'utf8')).toBe(before);
  f.recover();
  await f.watch();
  expect(f.rows()).toEqual(['A']);
  expect(f.hook().hasPendingNormal).toBe(true);
});

it('an admitted watcher span finishes its synchronous writes before Interpret can close the gate', async () => {
  const f = fixture(DEBOUNCE + 'payload:\n  form: prose\n');
  f.queue.push({ title: 'B', snapshotText: 'B', objectKey: 'obj' });
  await f.tick();
  expect(f.state().notifyState.pendingDebounce?.observations).toHaveLength(2);
  const interpreted: unknown[][] = [];
  let blocked: Promise<unknown> | undefined;
  const registry = new SourceRegistry();
  registry.register(f.source);
  f.current.runtime = new AgentMonitorRuntime(
    f.current.store,
    registry,
    [claudeCodeAdapter],
    {
      async interpret() {
        // Interpret is async external work. It must see the accepted span committed,
        // and a reentrant failed edit cannot strand a materialization continuation.
        interpreted.push(f.rows());
        expect(f.current.client.inTransaction).toBe(false);
        if (!blocked) {
          f.current.client.exec(
            "CREATE TRIGGER reject_c BEFORE INSERT ON monitor_events WHEN NEW.summary = 'C' BEGIN SELECT RAISE(FAIL, 'reentrant edit fault'); END",
          );
          blocked = f.prepare(f.edit(''));
        }
        return { decision: 'deliver', digest: 'accepted' };
      },
    },
  );
  await f.watch();
  vi.setSystemTime(new Date(START.getTime() + 11_000));
  f.yieldC();
  await turns();
  await blocked;
  await turns();
  expect(interpreted).toEqual([
    ['A', 'B'],
    ['A', 'B'],
  ]);
  expect(f.rows()).toEqual(['A', 'B']);
  expect(
    f
      .state()
      .notifyState.pendingDebounce?.observations.map(
        (item) => item.observation.title,
      ),
  ).toEqual(['C']);
  expect(f.state().sourceState).toEqual({ cursor: 1 });
});

it('a queued yield adopts the latest successful pacing edit while keeping its execution/handling snapshot', async () => {
  const f = fixture();
  await f.tick();
  const watcher = await f.watch();
  const rollup = "notify:\n  strategy: rollup\n  window: '0 0 1 1 *'\n";
  const edited = f.edit(rollup, 'normal', 'Edited instructions');
  f.yieldC();
  await new Promise<void>((resolve) =>
    queueMicrotask(() =>
      queueMicrotask(() => {
        void f.prepare(edited).then(() => resolve());
      }),
    ),
  );
  await turns();
  expect(f.rows()).toEqual(['A']);
  const captured = f.state().notifyState.pendingRollup?.observations;
  expect(captured).toHaveLength(1);
  expect(captured?.[0]).toMatchObject({
    monitor: { instructions: 'Captured instructions' },
    observation: { title: 'C' },
  });
  await watcher.stop();
  f.edit('');
  f.reopen();
  await f.watch();
  expect(f.rows()).toEqual(['A', 'C']);
  expect(
    f.current.store
      .listEvents({ sessionId: f.lead.id })
      .find((e) => e.summary === 'C')?.body,
  ).toBe('Captured instructions');
});

for (const kind of ['held', 'throttle'] as const) {
  it(`unchanged ${kind} policy preserves prior private-key clocks after restart/body edit`, async () => {
    const throttle = 'notify:\n  strategy: throttle\n  suppress-for: 1h\n';
    const f = fixture(
      kind === 'held' ? '' : throttle,
      kind === 'held' ? 'low..high' : 'normal',
    );
    if (kind === 'held')
      f.queue[0] = {
        title: 'A',
        salience: 'high',
        snapshotText: 'A',
        objectKey: 'obj',
      };
    await f.tick();
    const original = f.state();
    const key = notifyPolicyKey(
      f.edit(
        kind === 'held' ? '' : throttle,
        kind === 'held' ? 'low..high' : 'normal',
        'New body',
      ),
    );
    // Prior versions omitted escalation on immediate/throttle entries. Captured
    // held definitions remain the source of truth across this private encoding repair.
    const entries: unknown = JSON.parse(key);
    if (!Array.isArray(entries)) throw new Error('Invalid test policy key');
    const legacy = entries.map((entry: unknown) => {
      if (!Array.isArray(entry)) throw new Error('Invalid test policy entry');
      return entry[0] === 'immediate'
        ? entry.slice(0, 1)
        : entry[0] === 'throttle'
          ? entry.slice(0, 2)
          : entry;
    });
    const legacyState = {
      ...original,
      notifyState: {
        ...original.notifyState,
        policyKey: JSON.stringify(legacy),
      },
    };
    f.current.store.setMonitorState('held', f.root, legacyState);
    f.reopen();
    await f.tick();
    expect(f.state()).toEqual(legacyState);
    expect(f.rows()).toEqual(kind === 'held' ? [] : ['A']);
    expect(f.calls).toBe(1);
  });
}
