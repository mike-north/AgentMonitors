/**
 * 002 §4.6 / accepted #556: watcher startup is an edit-reconciliation boundary.
 * Real restart and SQLite faults prove old holds precede every new watch batch
 * (its observations and its source baseline commit together, 002 §2.4).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationSource } from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Both original hold clocks remain closed at the offline edit instant. */
const START = new Date('2026-03-20T08:00:00Z');
const policies = {
  debounce: 'notify:\n  strategy: debounce\n  settle-for: 0s\n',
  rollup: "notify:\n  strategy: rollup\n  window: '0 0 1 1 *'\n",
  immediate: '',
};
const roots: string[] = [];
const clients: Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) {
    if (client.open) client.close();
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A source whose one baseline-advancing batch matches the daemon startup loss probe. */
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'notify-startup-'));
  roots.push(root);
  const dir = path.join(root, 'monitors', 'held');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'MONITOR.md');
  const dbPath = path.join(root, 'state.sqlite');
  const errors: string[] = [];
  const entries: {
    events: unknown[];
    cursor: unknown;
    transaction: boolean;
  }[] = [];
  let observeCalls = 0;
  let factories = 0;
  let completed = 0;
  const source: ObservationSource = {
    name: 'startup-source',
    stateful: true,
    scopeSchema: {
      type: 'object',
      properties: { interval: { type: 'string' } },
    },
    observe() {
      observeCalls++;
      return Promise.resolve({
        observations: [
          { title: 'A', snapshotText: 'A', objectKey: 'obj' },
          { title: 'B', snapshotText: 'B', objectKey: 'obj' },
        ],
        nextState: { cursor: 1 },
      });
    },
    async *watch(_config, context) {
      factories++;
      entries.push({
        events: rows(),
        cursor: current.store.getMonitorState(
          'held',
          context.workspacePath ?? root,
        ).sourceState,
        transaction: current.client.inTransaction,
      });
      if (
        typeof context.previousState === 'object' &&
        context.previousState !== null &&
        'cursor' in context.previousState &&
        context.previousState.cursor === 999
      )
        return;
      // One admission unit: C and its cursor commit together or not at all.
      yield {
        observations: [{ title: 'C', snapshotText: 'C', objectKey: 'obj' }],
        nextState: { cursor: 999 },
      };
      // Pulled again only after the batch above was fully admitted.
      completed++;
    },
  };
  const registry = new SourceRegistry();
  registry.register(source);
  function open() {
    const db = createDb(dbPath);
    // Native access is test-only instrumentation of the actual owned SQLite store.
    const client = (db as unknown as { $client: Database }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    return { client, store, runtime };
  }
  let current = open();
  current.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  function edit(policy: string, interval = '1h') {
    writeFileSync(
      file,
      `---\nname: Captured title\nwatch:\n  type: startup-source\n  interval: ${interval}\nurgency: normal\nbaseline-strategy: incremental\n${policy}---\nCaptured instructions\n`,
    );
  }
  function rows() {
    return current.client
      .prepare('SELECT summary FROM monitor_events ORDER BY rowid')
      .pluck()
      .all();
  }
  const state = () => current.store.getMonitorState('held', root);
  const tick = () => current.runtime.tick(path.join(root, 'monitors'), root);
  const watch = () =>
    current.runtime.watchMonitors(path.join(root, 'monitors'), root, {
      onError: (_id, error) => {
        errors.push(error.message);
      },
    });
  return {
    root,
    file,
    source,
    registry,
    errors,
    entries,
    edit,
    rows,
    state,
    tick,
    watch,
    get current() {
      return current;
    },
    get factories() {
      return factories;
    },
    get completed() {
      return completed;
    },
    get observeCalls() {
      return observeCalls;
    },
    reopen() {
      current.client.close();
      current = open();
    },
    async hold(mode: 'debounce' | 'rollup') {
      edit(policies[mode]);
      await tick();
      expect(
        state().notifyState[
          mode === 'debounce' ? 'pendingDebounce' : 'pendingRollup'
        ]?.observations,
      ).toHaveLength(2);
      vi.setSystemTime(new Date(START.getTime() + 2_000));
    },
  };
}

for (const mode of ['debounce', 'rollup'] as const) {
  it(`startup ${mode} offline edit drains atomically before the C batch, without a preceding tick`, async () => {
    const f = fixture();
    await f.hold(mode);
    f.edit('');
    f.reopen();
    const handle = await f.watch();
    try {
      // Exactly daemon order: no sleep or scheduling delay between these calls.
      const tick = await f.tick();
      await vi.waitFor(() => expect(f.completed).toBe(1));
      expect(tick.erroredObservations).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.entries[0]).toEqual({
        events: ['A', 'B'],
        cursor: { cursor: 1 },
        transaction: false,
      });
      expect(f.rows()).toEqual(['A', 'B', 'C']);
      expect(
        f.current.client
          .prepare('SELECT content FROM monitor_snapshots ORDER BY rowid')
          .pluck()
          .all(),
      ).toEqual(['A', 'B', 'C']);
      expect(f.current.store.latestSnapshot('held', 'obj', f.root)).toEqual({
        content: 'C',
      });
      expect(f.state().sourceState).toEqual({ cursor: 999 });
      expect(f.observeCalls).toBe(1);
    } finally {
      await handle.stop();
    }
    f.reopen();
    const resumed = await f.watch();
    try {
      await f.tick();
      expect(f.rows()).toEqual(['A', 'B', 'C']);
    } finally {
      await resumed.stop();
    }
  });

  it(`startup ${mode} later-batch fault preserves all holds/cursor and recovers before C after reopen`, async () => {
    const f = fixture();
    await f.hold(mode);
    const original = f.state();
    f.edit('');
    f.reopen();
    f.current.client.exec(
      "CREATE TRIGGER reject_b BEFORE INSERT ON monitor_events WHEN NEW.summary = 'B' BEGIN SELECT RAISE(ABORT, 'later B fault'); END",
    );
    const handle = await f.watch();
    const tick = await f.tick();
    await handle.stop();
    f.reopen();
    expect(f.state()).toEqual(original);
    expect(f.rows()).toEqual([]);
    expect(f.factories).toBe(0);
    expect(f.errors.some((e) => e.includes('later B fault'))).toBe(true);
    expect(
      tick.erroredObservations.some((e) => e.message.includes('later B fault')),
    ).toBe(true);
    for (const table of [
      'monitor_snapshots',
      'session_event_state',
      'session_object_cursor',
    ])
      expect(
        f.current.client.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),
      ).toBe(0);
    f.current.client.exec('DROP TRIGGER reject_b');
    f.reopen();
    const recovered = await f.watch();
    try {
      await vi.waitFor(() => expect(f.completed).toBe(1));
      expect(f.entries[0]).toEqual({
        events: ['A', 'B'],
        cursor: { cursor: 1 },
        transaction: false,
      });
      expect(f.rows()).toEqual(['A', 'B', 'C']);
      expect(f.state().sourceState).toEqual({ cursor: 999 });
      expect(f.current.store.latestSnapshot('held', 'obj', f.root)).toEqual({
        content: 'C',
      });
    } finally {
      await recovered.stop();
    }
    f.reopen();
    const again = await f.watch();
    try {
      await f.tick();
      expect(f.rows()).toEqual(['A', 'B', 'C']);
      expect(f.observeCalls).toBe(1);
    } finally {
      await again.stop();
    }
  });
}

for (const invalid of ['parse', 'scope', 'missing', 'unreadable'] as const) {
  it(`failed ${invalid} definition at startup retains holds and reports before creating the source`, async () => {
    const f = fixture();
    await f.hold('rollup');
    const original = f.state();
    f.edit('');
    f.reopen();
    if (invalid === 'parse') writeFileSync(f.file, '---\nnotify: invalid\n---');
    if (invalid === 'scope') f.edit('', '42');
    if (invalid === 'missing' || invalid === 'unreadable') {
      rmSync(f.file);
      if (invalid === 'unreadable') mkdirSync(f.file);
    }
    const handle = await f.watch();
    await handle.stop();
    expect(f.state()).toEqual(original);
    expect(f.rows()).toEqual([]);
    expect(f.factories).toBe(0);
    expect(f.errors.length).toBeGreaterThan(0);
    if (invalid === 'unreadable') rmSync(f.file, { recursive: true });
    f.edit('');
    f.reopen();
    const recovered = await f.watch();
    try {
      await vi.waitFor(() => expect(f.completed).toBe(1));
      expect(f.rows()).toEqual(['A', 'B', 'C']);
    } finally {
      await recovered.stop();
    }
  });
}

it('unchanged held policy and no-hold direct startup make progress without a tick', async () => {
  const f = fixture();
  f.edit('notify:\n  strategy: debounce\n  settle-for: 10m\n');
  await f.tick();
  f.reopen();
  const unchanged = await f.watch();
  try {
    await vi.waitFor(() => expect(f.completed).toBe(1));
    expect(f.rows()).toEqual([]);
    expect(f.state().notifyState.pendingDebounce?.observations).toHaveLength(3);
    expect(f.state().sourceState).toEqual({ cursor: 999 });
  } finally {
    await unchanged.stop();
  }
  const g = fixture();
  g.edit('');
  const ordinary = await g.watch();
  try {
    await vi.waitFor(() => expect(g.completed).toBe(1));
    expect(g.rows()).toEqual(['C']);
    expect(g.observeCalls).toBe(0);
  } finally {
    await ordinary.stop();
  }
});

it('stop cancels failed startup cleanly and direct retry needs no hidden first tick', async () => {
  const f = fixture();
  await f.hold('rollup');
  const original = f.state();
  f.edit('');
  f.reopen();
  f.current.client.exec(
    "CREATE TRIGGER reject_b BEFORE INSERT ON monitor_events WHEN NEW.summary = 'B' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
  const failed = await f.watch();
  await failed.stop();
  await failed.stop();
  expect(f.state()).toEqual(original);
  expect(f.factories).toBe(0);
  f.current.client.exec('DROP TRIGGER reject_b');
  const retry = await f.watch();
  try {
    await vi.waitFor(() => expect(f.completed).toBe(1));
    expect(f.rows()).toEqual(['A', 'B', 'C']);
  } finally {
    await retry.stop();
  }
});

it('a failed startup leaves healthy sibling/workspace watchers and cancellation independent', async () => {
  const f = fixture();
  await f.hold('rollup');
  const original = f.state();
  f.edit('');
  f.reopen();
  f.current.client.exec(
    "CREATE TRIGGER reject_b BEFORE INSERT ON monitor_events WHEN NEW.summary = 'B' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
  let stopped = false;
  f.registry.register({
    name: 'healthy',
    scopeSchema: { type: 'object' },
    observe() {
      return Promise.resolve({ observations: [] });
    },
    async *watch(_config, context) {
      yield {
        observations: [{ title: 'healthy' }],
        nextState: { healthy: true },
      };
      if (!context.signal.aborted)
        await new Promise<void>((resolve) =>
          context.signal.addEventListener(
            'abort',
            () => {
              stopped = true;
              resolve();
            },
            { once: true },
          ),
        );
    },
  });
  const healthy = path.join(f.root, 'monitors', 'healthy');
  mkdirSync(healthy);
  writeFileSync(
    path.join(healthy, 'MONITOR.md'),
    '---\nwatch:\n  type: healthy\n---',
  );
  const first = await f.watch();
  try {
    await vi.waitFor(() => expect(f.rows()).toEqual(['healthy']));
    expect(f.state()).toEqual(original);
    expect(f.factories).toBe(0);
    const foreign = mkdtempSync(path.join(tmpdir(), 'notify-startup-foreign-'));
    roots.push(foreign);
    const foreignDir = path.join(foreign, 'held');
    mkdirSync(foreignDir);
    writeFileSync(
      path.join(foreignDir, 'MONITOR.md'),
      '---\nwatch:\n  type: startup-source\n---',
    );
    const other = await f.current.runtime.watchMonitors(foreign, foreign);
    try {
      await vi.waitFor(() => expect(f.completed).toBe(1));
      expect(f.state()).toEqual(original);
      expect(
        f.current.store.getMonitorState('held', foreign).sourceState,
      ).toEqual({ cursor: 999 });
      expect(
        f.current.store
          .listEvents({ workspacePath: foreign })
          .map((e) => e.summary),
      ).toEqual(['C']);
    } finally {
      await other.stop();
    }
  } finally {
    await first.stop();
  }
  expect(stopped).toBe(true);
  expect(f.state()).toEqual(original);
});

it('startup Interpret uses old criteria and recipients only after the whole drain commits', async () => {
  const f = fixture();
  f.edit(policies.rollup + 'payload:\n  form: prose\n');
  await f.tick();
  f.edit('');
  f.reopen();
  let interpretations = 0;
  f.current.runtime = new AgentMonitorRuntime(
    f.current.store,
    f.registry,
    [claudeCodeAdapter],
    {
      async interpret(input) {
        expect(f.current.client.inTransaction).toBe(false);
        expect(f.rows()).toEqual(['A', 'B']);
        expect(f.factories).toBe(0);
        expect(input.criteria).toBe('Captured instructions');
        interpretations++;
        return { decision: 'deliver', digest: 'old delta' };
      },
    },
  );
  const handle = await f.watch();
  try {
    await vi.waitFor(() => expect(f.completed).toBe(1));
    expect(interpretations).toBe(2);
    expect(f.rows()).toEqual(['A', 'B', 'C']);
    expect(
      f.current.client
        .prepare(
          'SELECT interpret_decision FROM session_event_state ORDER BY rowid',
        )
        .pluck()
        .all(),
    ).toEqual(['deliver', 'deliver', null]);
  } finally {
    await handle.stop();
  }
});
