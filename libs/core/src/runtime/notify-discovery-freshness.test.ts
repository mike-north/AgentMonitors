/** 002 §4.6: discovered files must still authorize policy mutation after earlier scopes await. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationSource } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Barriers suspend real source/Interpret work; no runtime or store method is replaced. */
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
const DEBOUNCE = 'notify:\n  strategy: debounce\n  settle-for: 1h\n';
const ROLLUP = "notify:\n  strategy: rollup\n  window: '0 0 1 1 *'\n";

/** Both discovery entry points operate on real files and the same durable scoped state. */
function fixture(older: 'tick' | 'startup', initialHeld = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-20T08:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'notify-discovery-'));
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const dbPath = path.join(root, 'state.sqlite');
  const db = createDb(dbPath);
  // Native access is solely for fault injection and independent SQLite reopen assertions.
  const client = (db as unknown as { $client: Database }).$client;
  const store = new RuntimeStore(db);
  const entered = deferred<undefined>();
  const release = deferred<undefined>();
  let blocking = false;
  let bCalls = 0;
  const tasks: Promise<unknown>[] = [];
  const handles: { stop(): Promise<void> }[] = [];
  const registry = new SourceRegistry();
  const source: ObservationSource = {
    name: 'discovery-source',
    stateful: true,
    scopeSchema: { type: 'object' },
    async observe(config) {
      if (config.label === 'a') {
        if (blocking && older === 'tick') {
          entered.resolve(undefined);
          await release.promise;
        }
        return {
          observations:
            older === 'startup' && !blocking
              ? [{ title: 'A', snapshotText: 'A' }]
              : [],
        };
      }
      bCalls++;
      return {
        observations:
          bCalls === 1
            ? initialHeld
              ? [
                  {
                    title: 'Initial B',
                    snapshotText: 'Initial B',
                    objectKey: 'obj',
                  },
                ]
              : []
            : [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
        nextState: { cursor: bCalls },
      };
    },
    async *watch(config, context) {
      if (config.label === 'b' && bCalls === 1 && !initialHeld) {
        bCalls++;
        yield {
          observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
        };
      }
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
    },
  };
  registry.register(source);
  const runtime = new AgentMonitorRuntime(
    store,
    registry,
    [claudeCodeAdapter],
    {
      name: 'controlled-interpret',
      async interpret(input) {
        if (input.monitorId === 'a' && blocking) {
          entered.resolve(undefined);
          await release.promise;
        }
        return { decision: 'deliver', digest: 'A interpreted' };
      },
    },
  );
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'owner',
      workspacePath: root,
    }),
  );
  function edit(id: string, notify: string) {
    writeFileSync(
      path.join(dir, `${id}.md`),
      `---\nwatch:\n  type: discovery-source\n  label: ${id}\n  interval: 1h\nbaseline-strategy: incremental\n${id === 'a' && older === 'startup' ? 'payload:\n  form: prose\n' : ''}${notify}---\nAuthored ${id}\n`,
    );
  }
  edit('a', older === 'startup' ? DEBOUNCE : '');
  edit('b', DEBOUNCE);
  const tick = () => {
    const task = runtime.tick(dir, root);
    tasks.push(task);
    return task;
  };
  const watch = async () => {
    const task = runtime.watchMonitors(dir, root);
    tasks.push(task);
    const handle = await task;
    handles.push(handle);
    return handle;
  };
  const state = () => store.getMonitorState('b', root);
  cleanups.push(async () => {
    release.resolve(undefined);
    await Promise.allSettled(tasks);
    for (const handle of handles) await handle.stop();
    if (client.open) client.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dir,
    client,
    store,
    runtime,
    session,
    edit,
    tick,
    watch,
    state,
    get bCalls() {
      return bCalls;
    },
    rows: () =>
      client
        .prepare(
          "SELECT summary FROM monitor_events WHERE monitor_id = 'b' ORDER BY rowid",
        )
        .pluck()
        .all(),
    async suspend() {
      await tick();
      for (const id of ['a', 'b'])
        store.setMonitorState(id, root, {
          ...store.getMonitorState(id, root),
          lastObservationAt: new Date('2000-01-01T00:00:00Z'),
        });
      blocking = true;
      if (older === 'startup') edit('a', '');
      const task = older === 'tick' ? tick() : watch();
      await entered.promise;
      return {
        finish: async () => {
          release.resolve(undefined);
          await task;
        },
      };
    },
    reopen() {
      const reader = createDb(dbPath);
      const readerClient = (reader as unknown as { $client: Database }).$client;
      try {
        return new RuntimeStore(reader).getMonitorState('b', root);
      } finally {
        readerClient.close();
      }
    },
  };
}

for (const older of ['tick', 'startup'] as const) {
  for (const newer of ['tick', 'startup'] as const) {
    it(`older ${older} discovery cannot drain newer ${newer} rollup even when b is not due`, async () => {
      const f = fixture(older);
      const pending = await f.suspend();
      f.edit('b', ROLLUP);
      if (newer === 'tick') await f.tick();
      else await f.watch();
      // Watch consumption runs on microtasks; no clock or fabricated result controls admission.
      for (let i = 0; i < 64; i++) await Promise.resolve();
      const adopted = f.state();
      expect(adopted.notifyState.pendingRollup?.observations).toHaveLength(1);
      await pending.finish();
      expect(f.rows()).toEqual([]);
      expect(f.state().notifyState).toEqual(adopted.notifyState);
      expect(f.bCalls).toBe(2);
      expect(f.reopen().notifyState).toEqual(adopted.notifyState);
      // Returning to an earlier authored policy is a real edit, not a forbidden historical key.
      f.edit('b', DEBOUNCE);
      await f.tick();
      expect(f.rows()).toEqual(['B']);
      expect(f.state().notifyState.pendingRollup).toBeUndefined();
      expect(f.state().notifyState.policyKey).not.toEqual(
        adopted.notifyState.policyKey,
      );
    });
  }
}

for (const replacement of [
  'failed-edit',
  'invalid-file',
  'removed-file',
] as const) {
  it(`stale discovery cannot reopen the latest ${replacement} gate or change its durable work`, async () => {
    const f = fixture('tick');
    const pending = await f.suspend();
    // Establish actual rollup work while the older discovery is suspended on a.
    f.edit('b', ROLLUP);
    await f.tick();
    const held = f.state();
    await f.watch();
    if (replacement === 'failed-edit') {
      f.edit('b', '');
      f.client.exec(
        "CREATE TRIGGER fault BEFORE INSERT ON monitor_events WHEN NEW.monitor_id = 'b' BEGIN SELECT RAISE(FAIL, 'owned latest edit fault'); END",
      );
    } else if (replacement === 'invalid-file') {
      writeFileSync(path.join(f.dir, 'b.md'), '---\nwatch: invalid\n---');
    } else rmSync(path.join(f.dir, 'b.md'));
    const failed = await f.tick();
    expect(failed.erroredObservations.some((e) => e.monitorId === 'b')).toBe(
      true,
    );
    await pending.finish();
    expect(f.rows()).toEqual([]);
    expect(f.state()).toEqual(held);
    // Private inspection observes ownership only; the actual gate/reconciler is never replaced.
    const policies = (
      f.runtime as unknown as { watchPolicies: Map<string, unknown> }
    ).watchPolicies;
    expect(policies.get(JSON.stringify([f.root, 'b']))).toBeNull();
    expect(f.reopen()).toEqual(held);
  });
}

it('an older unchanged debounce cannot reopen a newer failed rollup edit gate', async () => {
  const f = fixture('tick', true);
  const pending = await f.suspend();
  await f.watch();
  const held = f.state();
  f.edit('b', ROLLUP);
  f.client.exec(
    "CREATE TRIGGER fault BEFORE INSERT ON monitor_events WHEN NEW.monitor_id = 'b' BEGIN SELECT RAISE(FAIL, 'owned latest edit fault'); END",
  );
  const newer = await f.tick();
  expect(
    newer.erroredObservations.some((error) =>
      error.message.includes('owned latest edit fault'),
    ),
  ).toBe(true);
  await pending.finish();
  expect(f.rows()).toEqual([]);
  expect(f.state()).toEqual(held);
  const policies = (
    f.runtime as unknown as { watchPolicies: Map<string, unknown> }
  ).watchPolicies;
  expect(policies.get(JSON.stringify([f.root, 'b']))).toBeNull();
  expect(f.reopen()).toEqual(held);
});
