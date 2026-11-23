/** 002 §4.6: every deferred-result handoff releases exactly its retained cache ownership. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationResult } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Suspend actual registered observation results rather than replacing admission or ingestion. */
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

for (const failure of [
  'observations',
  'nextState',
  'outcome',
  'ingest',
  'none',
] as const) {
  for (const watcher of [false, true]) {
    it(`${failure} handoff releases the deferred lease while preserving ${watcher ? 'a live watcher' : 'no other owner'}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-20T08:00:00Z'));
      const root = mkdtempSync(path.join(tmpdir(), 'notify-handoff-'));
      const dir = path.join(root, 'monitors');
      mkdirSync(dir);
      const file = path.join(dir, 'held.md');
      const dbPath = path.join(root, 'state.sqlite');
      const db = createDb(dbPath);
      // Real native triggers exercise the edit rollback and asynchronous ingestion-error exits.
      const client = (db as unknown as { $client: Database }).$client;
      const store = new RuntimeStore(db);
      const started = deferred<undefined>();
      const result = deferred<ObservationResult>();
      const tasks: Promise<unknown>[] = [];
      const handles: { stop(): Promise<void> }[] = [];
      let calls = 0;
      let accesses = 0;
      const registry = new SourceRegistry();
      registry.register({
        name: 'handoff-source',
        stateful: true,
        scopeSchema: { type: 'object' },
        async observe() {
          calls++;
          if (calls === 1)
            return {
              observations: [
                { title: 'A', snapshotText: 'A', objectKey: 'obj' },
              ],
              nextState: { cursor: 1 },
            };
          if (calls === 2) {
            started.resolve(undefined);
            return result.promise;
          }
          return { observations: [], nextState: { cursor: 3 } };
        },
        watch(_config, context) {
          // An idle watcher owns its scope until explicit cancellation, without
          // manufacturing observations or advancing the source baseline.
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            next(): Promise<IteratorResult<never>> {
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
      });
      const runtime = new AgentMonitorRuntime(store, registry, [
        claudeCodeAdapter,
      ]);
      const session = runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId: 'owner',
          workspacePath: root,
        }),
      );
      const key = JSON.stringify([root, 'held']);
      const state = () => store.getMonitorState('held', root);
      // Read-only lifetime assertions do not grant or revoke ownership themselves.
      const metadata = runtime as unknown as {
        notifyPolicyUsers: Map<
          string,
          number | { users: number; currentPath?: string }
        >;
        pollAdmissions: Map<string, unknown>;
        watchPolicies: Map<string, unknown>;
      };
      const leaseCount = () => {
        const owner = metadata.notifyPolicyUsers.get(key);
        return typeof owner === 'number' ? owner : (owner?.users ?? 0);
      };
      const counts = () => ({
        leases: leaseCount(),
        admissions: metadata.pollAdmissions.size,
        policies: metadata.watchPolicies.size,
      });
      const tick = () => {
        const task = runtime.tick(dir, root);
        tasks.push(task);
        return task;
      };
      function edit(notify: string) {
        writeFileSync(
          file,
          `---\nwatch:\n  type: handoff-source\n  interval: 1h\nbaseline-strategy: incremental\n${notify}---\nPRIVATE-RETIRED-INSTRUCTIONS-${'x'.repeat(2048)}\n`,
        );
      }
      cleanups.push(async () => {
        result.resolve({ observations: [] });
        await Promise.allSettled(tasks);
        for (const handle of handles) await handle.stop();
        if (client.open) client.close();
        rmSync(root, { recursive: true, force: true });
      });
      edit('notify:\n  strategy: debounce\n  settle-for: 1h\n');
      await tick();
      store.setMonitorState('held', root, {
        ...state(),
        lastObservationAt: new Date('2000-01-01T00:00:00Z'),
      });
      const slow = tick();
      await started.promise;
      edit('');
      client.exec(
        "CREATE TRIGGER fault BEFORE INSERT ON monitor_events BEGIN SELECT RAISE(FAIL, 'owned edit fault'); END",
      );
      await tick();
      const original = state();
      const returned: ObservationResult = {
        get observations() {
          accesses++;
          if (failure === 'observations')
            throw new Error('owned observations argument fault');
          return [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }];
        },
        get nextState() {
          if (failure === 'nextState')
            throw new Error('owned nextState argument fault');
          return { cursor: 2 };
        },
        get outcome() {
          if (failure === 'outcome')
            throw new Error('owned outcome argument fault');
          return undefined;
        },
      };
      result.resolve(returned);
      await slow;
      expect(accesses).toBe(0);
      expect(state()).toEqual(original);
      expect(counts()).toEqual({ leases: 1, admissions: 1, policies: 1 });
      if (watcher) handles.push(await runtime.watchMonitors(dir, root));
      client.exec('DROP TRIGGER fault');
      if (failure === 'ingest')
        client.exec(
          "CREATE TRIGGER ingest_fault BEFORE UPDATE ON monitor_state WHEN json_extract(NEW.source_state, '$.cursor') = 2 BEGIN SELECT RAISE(FAIL, 'owned deferred ingestion fault'); END",
        );
      const recovery = await tick();
      expect(counts()).toEqual({
        leases: watcher ? 1 : 0,
        admissions: 0,
        policies: watcher ? 1 : 0,
      });
      const errors = recovery.erroredObservations.map((e) => e.message);
      if (failure === 'none') expect(errors).toEqual([]);
      else {
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(
          'Deferred observation failed after notify reconciliation committed:',
        );
        expect(errors[0]).toContain(
          failure === 'ingest'
            ? 'owned deferred ingestion fault'
            : `owned ${failure} argument fault`,
        );
        expect(errors[0]).not.toContain('holds retained');
      }
      expect(state().notifyState.pendingDebounce).toBeUndefined();
      expect(
        store
          .listEvents({ sessionId: session.id })
          .some((event) => event.summary === 'A'),
      ).toBe(true);
      for (const handle of handles.splice(0)) await handle.stop();
      if (failure === 'ingest') client.exec('DROP TRIGGER ingest_fault');
      vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
      await tick();
      expect(calls).toBe(3);
      expect(state().sourceState).toEqual({ cursor: 3 });
      rmSync(file);
      await tick();
      expect(counts()).toEqual({ leases: 0, admissions: 0, policies: 0 });
      expect(
        JSON.stringify([...metadata.watchPolicies.values()]),
      ).not.toContain('PRIVATE-RETIRED-INSTRUCTIONS');
      const persisted = state();
      client.close();
      const reader = createDb(dbPath);
      const readerClient = (reader as unknown as { $client: Database }).$client;
      try {
        const reopened = new RuntimeStore(reader);
        expect(reopened.getMonitorState('held', root)).toEqual(persisted);
        expect(
          reopened
            .listEvents({ sessionId: session.id })
            .some((event) => event.summary === 'A'),
        ).toBe(true);
      } finally {
        readerClient.close();
      }
    });
  }
}

/**
 * 002 §4.7: a deferred poll result admitted after a notify edit (§4.6) reaches
 * hold acceptance through the handoff's own ingest call. An observation the
 * new hold cannot serialize is refused and reported on the recovery tick's
 * `erroredObservations`; its sibling is held and the cursor advances past the
 * batch (#570).
 */
it('a deferred result carrying an unserializable observation is refused at hold acceptance and reported on the recovery tick (#570)', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-20T08:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'notify-handoff-refuse-'));
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const file = path.join(dir, 'held.md');
  const db = createDb(path.join(root, 'state.sqlite'));
  const client = (db as unknown as { $client: Database }).$client;
  const store = new RuntimeStore(db);
  const started = deferred<undefined>();
  const result = deferred<ObservationResult>();
  const tasks: Promise<unknown>[] = [];
  let calls = 0;
  const registry = new SourceRegistry();
  registry.register({
    name: 'handoff-source',
    stateful: true,
    scopeSchema: { type: 'object' },
    async observe() {
      calls++;
      if (calls === 1)
        return {
          observations: [{ title: 'A', snapshotText: 'A', objectKey: 'obj' }],
          nextState: { cursor: 1 },
        };
      if (calls === 2) {
        started.resolve(undefined);
        return result.promise;
      }
      return { observations: [], nextState: { cursor: 3 } };
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'owner',
      workspacePath: root,
    }),
  );
  const state = () => store.getMonitorState('held', root);
  const tick = () => {
    const task = runtime.tick(dir, root);
    tasks.push(task);
    return task;
  };
  const edit = (notify: string) =>
    writeFileSync(
      file,
      `---\nwatch:\n  type: handoff-source\n  interval: 1h\nbaseline-strategy: incremental\n${notify}---\nInstructions\n`,
    );
  cleanups.push(async () => {
    result.resolve({ observations: [] });
    await Promise.allSettled(tasks);
    if (client.open) client.close();
    rmSync(root, { recursive: true, force: true });
  });

  edit('notify:\n  strategy: debounce\n  settle-for: 1h\n');
  await tick();
  store.setMonitorState('held', root, {
    ...state(),
    lastObservationAt: new Date('2000-01-01T00:00:00Z'),
  });
  const slow = tick();
  await started.promise;
  edit('notify:\n  strategy: debounce\n  settle-for: 2h\n');
  client.exec(
    "CREATE TRIGGER fault BEFORE INSERT ON monitor_events BEGIN SELECT RAISE(FAIL, 'owned edit fault'); END",
  );
  await tick();
  result.resolve({
    observations: [
      {
        title: 'Bad',
        snapshotText: 'Bad',
        objectKey: 'bad',
        payload: { n: 1n },
      },
      { title: 'B', snapshotText: 'B', objectKey: 'obj' },
    ],
    nextState: { cursor: 2 },
  });
  await slow;
  client.exec('DROP TRIGGER fault');

  const recovery = await tick();
  expect(recovery.erroredObservations).toEqual([
    {
      monitorId: 'held',
      message: expect.stringMatching(
        /^Observation "Bad" was not held for debounce: it cannot be serialized \(.*BigInt.*\)\.$/u,
      ),
    },
  ]);
  const heldTitles = (
    state().notifyState.pendingDebounce?.observations ?? []
  ).map((envelope) => envelope.observation.title);
  expect(heldTitles).toContain('B');
  expect(heldTitles).not.toContain('Bad');
  expect(state().sourceState).toEqual({ cursor: 2 });
  expect(
    store
      .listObservationHistory({ monitorId: 'held', workspacePath: root })
      .filter(
        (row) =>
          row.result === 'errored' &&
          JSON.stringify(row.observationData).includes('was not held'),
      )
      .map((row) => row.observationData),
  ).toEqual([
    // A refusal is a drop (002 §2, #575): its row names the lost observation.
    {
      error: recovery.erroredObservations[0]?.message,
      holdRefused: true,
      objectKey: 'bad',
      title: 'Bad',
    },
  ]);
});

/**
 * 002 §4.6: a poll result retained behind a failed notify edit is admitted
 * against the source baseline it was observed from, not the baseline read when
 * it resumes. If another connection advanced the baseline meanwhile, the
 * result is refused rather than rolling the durable baseline back and
 * replaying input that was already delivered.
 */
it('refuses a retained poll result whose source baseline another connection advanced while it waited', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-20T08:00:00Z'));
  const root = mkdtempSync(path.join(tmpdir(), 'notify-retained-baseline-'));
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const file = path.join(dir, 'held.md');
  const dbPath = path.join(root, 'state.sqlite');
  const db = createDb(dbPath);
  const client = (db as unknown as { $client: Database }).$client;
  const store = new RuntimeStore(db);
  const started = deferred<undefined>();
  const result = deferred<ObservationResult>();
  let calls = 0;
  const registry = new SourceRegistry();
  registry.register({
    name: 'handoff-source',
    stateful: true,
    scopeSchema: { type: 'object' },
    async observe() {
      calls++;
      if (calls === 1) {
        return {
          observations: [{ title: 'A', snapshotText: 'A', objectKey: 'obj' }],
          nextState: { cursor: 1 },
        };
      }
      if (calls === 2) {
        started.resolve(undefined);
        return result.promise;
      }
      return { observations: [], nextState: { cursor: 99 } };
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'owner',
      workspacePath: root,
    }),
  );
  const state = () => store.getMonitorState('held', root);
  const summaries = () =>
    store.listEvents({ sessionId: session.id }).map((event) => event.summary);
  const edit = (notify: string) =>
    writeFileSync(
      file,
      `---\nwatch:\n  type: handoff-source\n  interval: 1h\nbaseline-strategy: incremental\n${notify}---\nx\n`,
    );
  try {
    // A is held under a long debounce; the next poll starts and stays in flight.
    edit('notify:\n  strategy: debounce\n  settle-for: 1h\n');
    await runtime.tick(dir, root);
    store.setMonitorState('held', root, {
      ...state(),
      lastObservationAt: new Date('2000-01-01T00:00:00Z'),
    });
    const slow = runtime.tick(dir, root);
    await started.promise;

    // The pacing edit's drain fails, so the in-flight result is retained.
    edit('');
    client.exec(
      "CREATE TRIGGER fault BEFORE INSERT ON monitor_events BEGIN SELECT RAISE(FAIL, 'owned edit fault'); END",
    );
    await runtime.tick(dir, root);
    result.resolve({
      observations: [{ title: 'B', snapshotText: 'B', objectKey: 'obj' }],
      nextState: { cursor: 2 },
    });
    await slow;
    expect(state().sourceState).toEqual({ cursor: 1 });

    // Another connection admits newer source work while the result waits.
    const other = createDb(dbPath);
    const otherStore = new RuntimeStore(other);
    otherStore.setMonitorState('held', root, {
      ...otherStore.getMonitorState('held', root),
      sourceState: { cursor: 7 },
    });
    (other as unknown as { $client: Database }).$client.close();

    client.exec('DROP TRIGGER fault');
    const recovery = await runtime.tick(dir, root);
    expect(
      recovery.erroredObservations.map((errored) => errored.message).join(' '),
    ).toContain('source baseline changed');
    expect(state().sourceState).toEqual({ cursor: 7 });
    expect(summaries()).not.toContain('B');
  } finally {
    result.resolve({ observations: [] });
    if (client.open) client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
