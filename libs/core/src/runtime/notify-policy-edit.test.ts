/** Accepted #556 outcomes: an effective pacing edit drains captured holds atomically. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { Observation, ObservationSource } from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import { withStoreWriter } from './store-writer.js';

/** Fixed observation instant; edit reconciliation occurs before either hold clock. */
const START = new Date('2026-03-20T08:00:00Z');
const roots: string[] = [];
const clients: Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) {
    if (c.open) c.close();
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
/** A policy is authored YAML; omission is effective immediate only below high. */
const policies = {
  debounce: 'notify:\n  strategy: debounce\n  settle-for: 10s\n',
  rollup: "notify:\n  strategy: rollup\n  window: '0 9 * * *'\n",
  immediate: '',
  throttle: 'notify:\n  strategy: throttle\n  suppress-for: 1h\n',
};

/** Own a file-backed store and a finite source; calls and cursors expose premature observation. */
function fixture(initial: string, urgency = 'normal') {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'notify-edit-'));
  roots.push(root);
  const dir = path.join(root, 'monitors', 'held');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'MONITOR.md');
  const queue: Observation[] = [
    {
      title: 'A',
      payload: { version: 'old' },
      snapshotText: 'A',
      objectKey: 'obj',
    },
    {
      title: 'B',
      body: 'observation body',
      snapshotText: 'B',
      objectKey: 'obj',
    },
  ];
  let calls = 0;
  const source: ObservationSource = {
    name: 'edit-source',
    stateful: true,
    scopeSchema: {
      type: 'object',
      properties: { interval: { type: 'string' } },
    },
    async observe() {
      calls++;
      return { observations: queue.splice(0), nextState: { cursor: calls } };
    },
  };
  function edit(
    policy: string,
    nextUrgency = urgency,
    body = 'old instructions',
    interval = '1h',
    name = 'Old name',
  ) {
    writeFileSync(
      file,
      `---\nname: ${name}\nwatch:\n  type: edit-source\n  interval: ${interval}\nurgency: ${nextUrgency}\nbaseline-strategy: incremental\n${policy}---\n${body}\n`,
    );
  }
  const dbPath = path.join(root, 'state.sqlite');
  function open() {
    const db = createDb(dbPath);
    // Test-only driver access allows real SQLite triggers, explicit close, and lock assertions.
    const client = (db as unknown as { $client: Database }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    const registry = new SourceRegistry();
    registry.register(source);
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    return { client, store, runtime, registry };
  }
  edit(initial);
  let current = open();
  const session = current.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  const tick = () => current.runtime.tick(path.join(root, 'monitors'), root);
  const state = () => current.store.getMonitorState('held', root);
  return {
    root,
    file,
    edit,
    queue,
    source,
    session,
    tick,
    state,
    open,
    get calls() {
      return calls;
    },
    get current() {
      return current;
    },
    restart() {
      current.client.close();
      current = open();
    },
    events: () => current.store.listEvents({ sessionId: session.id }),
    async accept() {
      await tick();
      expect(
        state().notifyState.pendingDebounce?.observations.length ??
          state().notifyState.pendingRollup?.observations.length,
      ).toBe(2);
      vi.setSystemTime(new Date(START.getTime() + 2_000));
    },
  };
}

for (const restart of [false, true]) {
  for (const from of ['debounce', 'rollup'] as const) {
    for (const to of [
      'immediate',
      'throttle',
      from === 'debounce' ? 'rollup' : 'debounce',
    ] as const) {
      it(`${from} -> ${to} drains before source due, restart=${restart}`, async () => {
        const f = fixture(policies[from]);
        await f.accept();
        f.edit(
          policies[to],
          to === 'immediate' ? 'low' : 'high',
          'new instructions',
          '1h',
          'New name',
        );
        if (restart) f.restart();
        const result = await f.tick();
        expect(result.emittedEventIds).toHaveLength(2);
        expect(f.calls).toBe(1);
        const events = f.events().reverse();
        expect(
          events.map((e) => [
            e.summary,
            e.urgency,
            e.title,
            e.body,
            e.sourceName,
            e.createdAt.toISOString(),
          ]),
        ).toEqual([
          [
            'A',
            'normal',
            'Old name',
            'old instructions',
            'edit-source',
            START.toISOString(),
          ],
          [
            'observation body',
            'normal',
            'Old name',
            'observation body',
            'edit-source',
            START.toISOString(),
          ],
        ]);
        expect(events[0]?.payload).toEqual({ version: 'old' });
        expect(f.state().notifyState.pendingDebounce).toBeUndefined();
        expect(f.state().notifyState.pendingRollup).toBeUndefined();
        f.restart();
        expect((await f.tick()).emittedEventIds).toEqual([]);
        expect(f.events()).toHaveLength(2);
      });
    }
  }
}

for (const [from, to, urgency] of [
  [policies.debounce, policies.debounce.replace('10s', '20s'), 'normal'],
  [policies.debounce, policies.debounce.replace('10s', '0s'), 'normal'],
  [policies.rollup, policies.rollup.replace('0 9', '0 10'), 'normal'],
  [
    policies.rollup,
    policies.rollup + '  timezone: America/Los_Angeles\n',
    'normal',
  ],
  ['', '', 'high'],
] as const) {
  it(`reconciles an effective parameter/default edit ${from} -> ${to} (${urgency})`, async () => {
    const f = fixture(from, urgency);
    await f.accept();
    f.edit(to, 'normal');
    f.restart();
    expect((await f.tick()).emittedEventIds).toHaveLength(2);
  });
}

for (const policy of [policies.debounce, policies.rollup, '']) {
  it(`body-only edit preserves clocks and captured content (${policy})`, async () => {
    const f = fixture(policy, policy ? 'normal' : 'high');
    await f.accept();
    const before = f.state();
    f.edit(policy, policy ? 'normal' : 'high', 'new instructions');
    f.restart();
    expect((await f.tick()).emittedEventIds).toEqual([]);
    expect(f.state()).toEqual(before);
  });
}

it('equivalent durations and default UTC do not constitute policy edits', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.edit(policies.rollup + '  timezone: UTC\n');
  expect((await f.tick()).emittedEventIds).toEqual([]);
  const g = fixture(policies.debounce.replace('10s', '60s'));
  await g.accept();
  g.edit(policies.debounce.replace('10s', '1m'));
  expect((await g.tick()).emittedEventIds).toEqual([]);
});

/** SQLite faults must roll back an entire old batch, not just the failing event. */
for (const fault of [
  'event',
  'projection',
  'cursor',
  'snapshot',
  'hold',
  'audit',
] as const) {
  it(`rolls back all holds/state on ${fault} write failure and recovers after restart`, async () => {
    const f = fixture(policies.rollup);
    await f.accept();
    const original = f.state();
    f.edit(policies.immediate);
    const table = {
      event: 'monitor_events',
      projection: 'session_event_state',
      cursor: 'session_object_cursor',
      snapshot: 'monitor_snapshots',
      hold: 'monitor_state',
      audit: 'observation_history',
    }[fault];
    const operation = fault === 'hold' ? 'UPDATE' : 'INSERT';
    const when =
      fault === 'event'
        ? 'WHEN (SELECT COUNT(*) FROM monitor_events) = 1'
        : fault === 'hold'
          ? "WHEN json_extract(NEW.notify_state, '$.pendingRollup') IS NULL"
          : '';
    f.current.client.exec(
      `CREATE TRIGGER edit_fault BEFORE ${operation} ON ${table} ${when} BEGIN SELECT RAISE(ABORT, 'edit write fault'); END`,
    );
    const failed = await f.tick();
    expect(failed.erroredObservations.some((e) => e.monitorId === 'held')).toBe(
      true,
    );
    expect(f.calls).toBe(1);
    expect(f.state()).toEqual(original);
    expect(f.events()).toEqual([]);
    for (const table of [
      'session_event_state',
      'session_object_cursor',
      'monitor_snapshots',
    ]) {
      expect(
        f.current.client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
    }
    f.current.client.exec('DROP TRIGGER edit_fault');
    f.restart();
    expect((await f.tick()).emittedEventIds).toHaveLength(2);
    expect(f.events()).toHaveLength(2);
  });
}

it('failed drain blocks only its monitor while a healthy sibling and other workspace progress', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.edit('');
  const sibling = path.join(f.root, 'monitors', 'sibling');
  mkdirSync(sibling);
  writeFileSync(
    path.join(sibling, 'MONITOR.md'),
    '---\nwatch:\n  type: edit-source\n---\nhealthy',
  );
  f.current.client.exec(
    `CREATE TRIGGER edit_fault BEFORE INSERT ON monitor_events WHEN NEW.monitor_id = 'held' AND NEW.workspace_path = '${f.root}' BEGIN SELECT RAISE(ABORT, 'blocked held'); END`,
  );
  f.queue.push({ title: 'healthy' });
  const r = await f.tick();
  expect(r.erroredObservations.map((e) => e.monitorId)).toContain('held');
  expect(r.emittedEventIds).toHaveLength(1);
  expect(f.calls).toBe(2);
  const g = fixture(policies.debounce);
  await g.accept();
  g.edit('');
  f.current.store.setMonitorState('held', g.root, g.state());
  expect(
    (await f.current.runtime.tick(path.join(g.root, 'monitors'), g.root))
      .emittedEventIds,
  ).toHaveLength(2);
});

for (const invalid of ['invalid', 'missing', 'unreadable']) {
  it(`retains and reports holds for ${invalid} definition`, async () => {
    const f = fixture(policies.rollup);
    await f.accept();
    const before = f.state();
    if (invalid === 'invalid')
      writeFileSync(f.file, '---\nnotify: nonsense\n---');
    else {
      rmSync(f.file);
      if (invalid === 'unreadable') mkdirSync(f.file);
    }
    const result = await f.tick();
    expect(f.state()).toEqual(before);
    expect(f.calls).toBe(1);
    expect(result.erroredObservations.some((e) => e.monitorId === 'held')).toBe(
      true,
    );
  });
}

it('two runtimes sharing SQLite drain exactly one committed batch', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.edit('');
  const second = f.open();
  const results = await Promise.all([
    f.tick(),
    second.runtime.tick(path.join(f.root, 'monitors'), f.root),
  ]);
  expect(results.flatMap((r) => r.emittedEventIds)).toHaveLength(2);
  expect(f.events()).toHaveLength(2);
});

/** Actual SIGKILL probes; no daemon, shell process group, or borrowed child is signalled. */
for (const boundary of ['before', 'after']) {
  it(`SIGKILL ${boundary} commit preserves hold/event complement on reopen`, async () => {
    const f = fixture(policies.rollup);
    await f.accept();
    const original = f.state();
    f.edit('');
    vi.useRealTimers();
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--import',
        path.resolve('src/runtime/__fixtures__/typescript-loader.ts'),
        path.resolve('src/runtime/__fixtures__/notify-policy-edit-child.ts'),
        f.root,
        boundary,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`child barrier timeout: ${stderr}`)),
          8_000,
        );
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          reject(new Error(`child exited before barrier: ${stderr}`));
        });
        child.stdout.on('data', (chunk) => {
          const line = String(chunk);
          if (line.includes(boundary === 'before' ? 'BEFORE' : 'AFTER')) {
            clearTimeout(timeout);
            resolve();
          } else if (line.includes('AFTER')) {
            clearTimeout(timeout);
            reject(new Error('expected a before-commit write barrier'));
          }
        });
      });
      child.kill('SIGKILL');
      expect((await exited).signal).toBe('SIGKILL');
      f.restart();
      if (boundary === 'before') {
        expect(f.state()).toEqual(original);
        expect(f.events()).toEqual([]);
      } else {
        expect(f.events()).toHaveLength(2);
        expect(f.state().notifyState.pendingRollup).toBeUndefined();
      }
      expect((await f.tick()).emittedEventIds).toHaveLength(
        boundary === 'before' ? 2 : 0,
      );
      expect(f.events()).toHaveLength(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
    }
  }, 12_000);
}

it('active watcher skip cannot strand a drain and a blocked batch backpressures the iterator', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  const firstBatch = Promise.withResolvers<undefined>();
  let factories = 0;
  let resumed = 0;
  async function* batches(signal: AbortSignal) {
    await firstBatch.promise;
    // The first batch carries both a live observation and a new source baseline.
    yield {
      observations: [{ title: 'watch C' }],
      nextState: { cursor: 999 },
    };
    resumed++;
    yield { observations: [{ title: 'watch D' }] };
    resumed++;
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
  }
  f.source.watch = (_config, context) => {
    factories++;
    if (!context.signal) throw new Error('Watcher signal was not supplied.');
    return batches(context.signal);
  };
  const handle = await f.current.runtime.watchMonitors(
    path.join(f.root, 'monitors'),
    f.root,
  );
  try {
    // The factory runs once the reconciled gate admits it, after startup returns.
    await vi.waitFor(() => expect(factories).toBe(1));
    f.edit('');
    f.current.client.exec(
      "CREATE TRIGGER edit_fault BEFORE INSERT ON monitor_events BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    expect((await f.tick()).erroredObservations).toHaveLength(1);
    const before = f.state();
    firstBatch.resolve(undefined);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    // The failed drain keeps the gate closed: the batch is neither admitted
    // nor dropped, and the iterator is not pulled for newer input.
    expect(resumed).toBe(0);
    expect(f.state()).toEqual(before);
    expect(f.state().sourceState).toEqual({ cursor: 1 });
    expect(f.events()).toHaveLength(0);
    f.current.client.exec('DROP TRIGGER edit_fault');
    expect((await f.tick()).emittedEventIds).toHaveLength(2);
    await vi.waitFor(() => {
      expect(resumed).toBe(2);
      expect(f.events()).toHaveLength(4);
    });
    // Recovery admits the held drain first, then both batches in order
    // (events are listed newest first).
    expect(
      f
        .events()
        .map((e) => e.summary)
        .reverse(),
    ).toEqual(['A', 'observation body', 'watch C', 'watch D']);
    // The second batch omitted nextState, so the first batch's baseline stands.
    expect(f.state().sourceState).toEqual({ cursor: 999 });
    expect(f.state().notifyState).toMatchObject({
      policyKey: expect.any(String),
    });
    expect(f.calls).toBe(1);
  } finally {
    firstBatch.resolve(undefined);
    await handle.stop();
  }
});

it('new work uses new pacing and guards while materialized old rows remain immutable', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  const held = f.state();
  f.current.store.setMonitorState('held', f.root, {
    ...held,
    notifyState: {
      ...held.notifyState,
      suppressedUntil: '2099-01-01T00:00:00Z',
      rollupLastFiredMinute: Math.floor(START.getTime() / 60_000),
    },
  });
  f.edit(policies.throttle, 'high', 'new instructions', '1s', 'New name');
  f.queue.push({ title: 'new C', payload: { version: 'new' } });
  const result = await f.tick();
  expect(result.emittedEventIds).toHaveLength(3);
  const old = f.events().filter((e) => e.urgency === 'normal');
  expect(old).toHaveLength(2);
  expect(f.events().find((e) => e.summary === 'new C')).toMatchObject({
    urgency: 'high',
    title: 'New name',
    body: 'new instructions',
    payload: { version: 'new' },
  });
  f.edit(policies.debounce, 'low', 'another body', '1s');
  await f.tick();
  expect(f.events().filter((e) => e.urgency === 'normal')).toEqual(old);
});

it('hydrates legacy urgency from captured semantics while the old source is unavailable', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.current.client.exec(
    "UPDATE monitor_state SET notify_state = json_remove(notify_state, '$.pendingRollup.observations[0].effectiveUrgency', '$.pendingRollup.observations[1].effectiveUrgency')",
  );
  f.edit('', 'high', 'new body');
  writeFileSync(
    f.file,
    (await import('node:fs'))
      .readFileSync(f.file, 'utf8')
      .replace('type: edit-source', 'type: new-source'),
  );
  const registry = new SourceRegistry();
  registry.register({ ...f.source, name: 'new-source' });
  const runtime = new AgentMonitorRuntime(f.current.store, registry);
  expect(
    (await runtime.tick(path.join(f.root, 'monitors'), f.root)).emittedEventIds,
  ).toHaveLength(2);
  expect(f.events().map((e) => [e.urgency, e.sourceName])).toEqual([
    ['normal', 'edit-source'],
    ['normal', 'edit-source'],
  ]);
});

it('incomplete captured semantics retain the full hold instead of using the new body', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.current.client.exec(
    "UPDATE monitor_state SET notify_state = json_remove(notify_state, '$.pendingRollup.observations[1].monitor.instructions')",
  );
  const before = f.state();
  f.edit('');
  expect((await f.tick()).erroredObservations[0]?.message).toContain(
    'incomplete captured semantics',
  );
  expect(f.state()).toEqual(before);
  expect(f.events()).toEqual([]);
  expect(f.calls).toBe(1);
});

it('Interpret runs outside the committed writer and retains each event recipient set', async () => {
  const f = fixture(policies.rollup + 'payload:\n  form: prose\n');
  await f.accept();
  f.edit('');
  const seen: string[] = [];
  const runtime = new AgentMonitorRuntime(
    f.current.store,
    f.current.registry,
    [claudeCodeAdapter],
    {
      async interpret(input) {
        expect(f.current.client.inTransaction).toBe(false);
        expect(f.events()).toHaveLength(2);
        expect(f.state().notifyState.pendingRollup).toBeUndefined();
        seen.push(input.delta);
        return { decision: 'deliver', digest: 'inspected' };
      },
    },
  );
  expect(
    (await runtime.tick(path.join(f.root, 'monitors'), f.root)).emittedEventIds,
  ).toHaveLength(2);
  expect(seen).toHaveLength(2);
  expect(
    f.current.client
      .prepare('SELECT interpret_decision FROM session_event_state')
      .all(),
  ).toEqual([
    { interpret_decision: 'deliver' },
    { interpret_decision: 'deliver' },
  ]);
});

it('independent processes reread holds under the writer after a stale pre-lock read', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.edit('');
  vi.useRealTimers();
  const { spawn } = await import('node:child_process');
  /** Each child owns its process and self-bounds its synchronous barriers. */
  function start(role: string) {
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--import',
        path.resolve('src/runtime/__fixtures__/typescript-loader.ts'),
        path.resolve('src/runtime/__fixtures__/notify-policy-edit-race.ts'),
        f.root,
        role,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    return {
      child,
      exited,
      get output() {
        return output;
      },
      get errors() {
        return errors;
      },
    };
  }
  const owned = [start('peer')];
  try {
    await vi.waitFor(() => expect(owned[0]?.output).toContain('READ'), {
      timeout: 5_000,
    });
    const owner = start('owner');
    owned.push(owner);
    await vi.waitFor(() => expect(owner.output).toContain('LOCKED'), {
      timeout: 5_000,
    });
    writeFileSync(path.join(f.root, 'start-peer'), 'go');
    writeFileSync(path.join(f.root, 'release-owner'), 'go');
    const codes = await Promise.all(owned.map((p) => p.exited));
    expect(codes).toEqual([0, 0]);
    const counts = owned.map(
      (p) =>
        JSON.parse(p.output.split('RESULT ')[1]?.trim() ?? 'null') as string[],
    );
    expect(counts.map((ids) => ids.length).sort()).toEqual([0, 2]);
    f.restart();
    expect(f.events()).toHaveLength(2);
    expect(f.state().notifyState.pendingRollup).toBeUndefined();
    expect(f.state().sourceState).toEqual({ cursor: 1 });
  } finally {
    for (const p of owned) {
      if (p.child.exitCode === null && p.child.signalCode === null)
        p.child.kill('SIGKILL');
    }
    await Promise.allSettled(owned.map((p) => p.exited));
  }
}, 15_000);

it('rejects invalid captured urgency without substituting the edited band', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.current.client.exec(
    "UPDATE monitor_state SET notify_state = json_set(notify_state, '$.pendingRollup.observations[0].effectiveUrgency', 'invalid')",
  );
  const before = f.state();
  f.edit('');
  expect((await f.tick()).erroredObservations).toHaveLength(1);
  expect(f.state()).toEqual(before);
  expect(f.events()).toEqual([]);
});

it('a changed-policy drain commits before a newly due source error', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.edit('', 'normal', 'new', '1s');
  f.source.observe = async () => {
    throw new Error('source unavailable');
  };
  const result = await f.tick();
  expect(result.emittedEventIds).toHaveLength(2);
  expect(result.erroredObservations[0]?.message).toBe('source unavailable');
  expect(f.state().notifyState.pendingRollup).toBeUndefined();
});

it('unchanged explicit pacing preserves held urgency while default pacing changes flush', async () => {
  const f = fixture(policies.debounce);
  await f.accept();
  f.edit(policies.debounce, 'high');
  expect((await f.tick()).emittedEventIds).toEqual([]);
  const g = fixture('', 'normal..high');
  // A second escalated observation would intentionally flush the first early
  // under 002 §4.1, so one observation isolates the edit-time default change.
  g.queue.splice(1);
  g.queue.forEach((o) => {
    o.salience = 'high';
  });
  await g.tick();
  expect(g.state().notifyState.pendingDebounce?.observations).toHaveLength(1);
  vi.setSystemTime(new Date(START.getTime() + 2_000));
  g.edit('', 'low');
  expect((await g.tick()).emittedEventIds).toHaveLength(1);
  expect(g.events().every((e) => e.urgency === 'high')).toBe(true);
});

it('guard-only effective edits clear retired throttle state before new work', async () => {
  const f = fixture(policies.throttle);
  await f.tick();
  expect(f.state().notifyState.suppressedUntil).toBeDefined();
  f.edit('');
  vi.setSystemTime(new Date(START.getTime() + 2_000));
  await f.tick();
  expect(f.state().notifyState.suppressedUntil).toBeUndefined();
  f.edit(policies.throttle, 'normal', 'new', '1s');
  f.queue.push({ title: 'new accepted' });
  expect((await f.tick()).emittedEventIds).toHaveLength(1);
});

it('an active ephemeral hold is not diagnosed as a missing authored file', async () => {
  const f = fixture('');
  rmSync(f.file);
  const declared = f.current.runtime.declareEphemeralMonitor({
    sessionId: f.session.id,
    source: 'edit-source',
    scope: { interval: '1h' },
    urgency: 'high',
  });
  await f.tick();
  expect(
    f.current.store.getMonitorState(declared.id, f.root).notifyState
      .pendingDebounce?.observations,
  ).toHaveLength(2);
  vi.setSystemTime(new Date(START.getTime() + 2_000));
  expect((await f.tick()).erroredObservations).toEqual([]);
});

it('changing granted whole-batch escalation changes effective debounce pacing (002 §4.1)', async () => {
  const f = fixture(policies.debounce, 'normal..high');
  await f.accept();
  f.edit(policies.debounce, 'high');
  expect((await f.tick()).emittedEventIds).toHaveLength(2);
  expect(f.events().every((e) => e.urgency === 'normal')).toBe(true);
});

it('an edit to rollup flushes old captures now while new work waits for its own window', async () => {
  const f = fixture(policies.debounce);
  await f.accept();
  f.edit(policies.rollup, 'high', 'new instructions', '1s', 'New name');
  f.queue.push({ title: 'new C' });
  expect((await f.tick()).emittedEventIds).toHaveLength(2);
  expect(f.events().every((e) => e.urgency === 'normal')).toBe(true);
  expect(f.state().notifyState.pendingRollup?.observations).toHaveLength(1);
  vi.setSystemTime(new Date('2026-03-20T09:00:00Z'));
  expect((await f.tick()).emittedEventIds).toHaveLength(1);
  expect(f.events().find((e) => e.summary === 'new C')).toMatchObject({
    title: 'New name',
    body: 'new instructions',
    urgency: 'high',
    createdAt: new Date(START.getTime() + 2_000),
  });
});

it('edit writer refuses an externally owned transaction and rolls back an async callback', () => {
  const f = fixture(policies.rollup);
  f.current.client.exec('BEGIN IMMEDIATE');
  try {
    expect(() => withStoreWriter(f.current.store, () => undefined)).toThrow(
      'owned writer transaction',
    );
  } finally {
    f.current.client.exec('ROLLBACK');
  }
  const before = f.state();
  expect(() =>
    withStoreWriter(f.current.store, () => {
      f.current.store.setMonitorState('held', f.root, { notifyState: {} });
      return Promise.resolve();
    }),
  ).toThrow('synchronous');
  expect(f.state()).toEqual(before);
});

it('another policy edit after a failed drain retains original captures across restart', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  f.edit('');
  const before = f.state();
  f.current.client.exec(
    "CREATE TRIGGER edit_fault BEFORE INSERT ON monitor_events BEGIN SELECT RAISE(ABORT, 'blocked edit'); END",
  );
  expect((await f.tick()).erroredObservations).toHaveLength(1);
  expect(f.state()).toEqual(before);
  f.edit(policies.throttle, 'high', 'edited again', '1h', 'Later name');
  f.current.client.exec('DROP TRIGGER edit_fault');
  f.restart();
  expect((await f.tick()).emittedEventIds).toHaveLength(2);
  expect(
    f.events().every((e) => e.urgency === 'normal' && e.title === 'Old name'),
  ).toBe(true);
  expect(f.events().find((e) => e.summary === 'A')?.body).toBe(
    'old instructions',
  );
  expect(f.calls).toBe(1);
});

it('live watchers adopt reconciled pacing without reloading execution or handling snapshots', async () => {
  const f = fixture(policies.rollup);
  await f.accept();
  const { promise: ready, resolve: release } =
    Promise.withResolvers<undefined>();
  let factories = 0;
  async function* batches(signal: AbortSignal) {
    await ready;
    yield { observations: [{ title: 'live C' }] };
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
  }
  f.source.watch = (_config, context) => {
    factories++;
    if (!context.signal) throw new Error('Watcher signal was not supplied.');
    return batches(context.signal);
  };
  const handle = await f.current.runtime.watchMonitors(
    path.join(f.root, 'monitors'),
    f.root,
  );
  try {
    // Establish the source (its execution and handling snapshot) before the edit.
    await vi.waitFor(() => expect(factories).toBe(1));
    f.edit('', 'low', 'new handling', '1h', 'New name');
    expect((await f.tick()).emittedEventIds).toHaveLength(2);
    release(undefined);
    await vi.waitFor(() => expect(f.events()).toHaveLength(3));
    expect(f.events().find((e) => e.summary === 'live C')).toMatchObject({
      urgency: 'low',
      body: 'old instructions',
      title: 'Old name',
      sourceName: 'edit-source',
    });
    expect(f.calls).toBe(1);
  } finally {
    release(undefined);
    await handle.stop();
  }
});
