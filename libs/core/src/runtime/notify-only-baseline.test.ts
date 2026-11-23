/** 002 §3/§4.6 and 003 §2: pacing reconciliation cannot manufacture source-owned previousState. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationResult } from '../observation/types.js';
import type { PolicyNotifyState } from './notify-policy.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** All old policies produce either accepted work or a live guard at this exact instant. */
const START = new Date('2026-03-20T09:00:00Z');
const policies = {
  throttle: 'notify:\n  strategy: throttle\n  suppress-for: 1h\n',
  minute: "notify:\n  strategy: rollup\n  window: '* * * * *'\n",
  debounce: 'notify:\n  strategy: debounce\n  settle-for: 1h\n',
  rollup: "notify:\n  strategy: rollup\n  window: '0 10 * * *'\n",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

/** Actual source calls, startup, files and SQLite preserve the opaque representation across reopen. */
function fixture(policy: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'notify-only-baseline-'));
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const file = path.join(dir, 'held.md');
  const dbPath = path.join(root, 'state.sqlite');
  const previous: unknown[] = [];
  /** previousState handed to each live source factory the runtime admitted. */
  const watched: unknown[] = [];
  const handles: { stop(): Promise<void> }[] = [];
  const registry = new SourceRegistry();
  registry.register({
    name: 'baseline-source',
    stateful: true,
    scopeSchema: { type: 'object' },
    async observe(_config, context) {
      previous.push(context.previousState);
      const title = String.fromCharCode(64 + previous.length);
      return {
        observations: [{ title, snapshotText: title, objectKey: 'obj' }],
        nextState: { cursor: previous.length },
      };
    },
    watch(_config, context) {
      watched.push(context.previousState);
      // A silent live source admits no batch, so startup reconciliation is
      // observable without any source-owned baseline write.
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<ObservationResult>> {
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
  function open() {
    const db = createDb(dbPath);
    // Native access is limited to controlled legacy shapes, fault injection and raw durability proof.
    const client = (db as unknown as { $client: Database }).$client;
    const store = new RuntimeStore(db);
    return {
      client,
      store,
      runtime: new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]),
    };
  }
  let current = open();
  const session = current.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  function edit(notify = policy, body = 'Original handling') {
    writeFileSync(
      file,
      '---\nwatch:\n  type: baseline-source\n  interval: 1h\nbaseline-strategy: incremental\n' +
        notify +
        '---\n' +
        body +
        '\n',
    );
  }
  edit();
  const raw = () =>
    current.client
      .prepare(
        "SELECT source_state,last_fingerprint,last_observation_at FROM monitor_state WHERE monitor_id='held' AND workspace_path=?",
      )
      .get(root);
  const state = () => current.store.getMonitorState('held', root);
  const summaries = () =>
    current.client
      .prepare('SELECT summary FROM monitor_events ORDER BY rowid')
      .pluck()
      .all();
  const artifacts = () => ({
    events: current.client
      .prepare('SELECT * FROM monitor_events ORDER BY rowid')
      .all(),
    snapshot: current.store.latestSnapshot('held', 'obj', root),
    cursor: current.store.getSessionObjectCursor(
      session.id,
      'held',
      'obj',
      root,
    ),
  });
  async function stop() {
    for (const handle of handles.splice(0)) await handle.stop();
  }
  cleanups.push(async () => {
    await stop();
    if (current.client.open) current.client.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    edit,
    raw,
    state,
    summaries,
    artifacts,
    previous,
    watched,
    stop,
    get current() {
      return current;
    },
    tick: () => current.runtime.tick(dir, root),
    /** Start live watching and wait until the gate admits the source factory. */
    async startup() {
      const errors: { monitorId: string; message: string }[] = [];
      const factories = watched.length;
      handles.push(
        await current.runtime.watchMonitors(dir, root, {
          onError: (error) => errors.push(error),
        }),
      );
      await vi.waitFor(() => expect(watched).toHaveLength(factories + 1));
      return errors;
    },
    /** Seed only source-owned compatibility columns and absent private identity on this owned fixture. */
    legacy(rawSource: string) {
      current.client
        .prepare(
          "UPDATE monitor_state SET source_state=?,last_fingerprint='legacy-fingerprint',notify_state=json_remove(notify_state,'$.policyKey') WHERE monitor_id='held' AND workspace_path=?",
        )
        .run(rawSource, root);
    },
    restart() {
      current.client.close();
      current = open();
    },
    /** Scheduling must not accidentally normalize the very source baseline under test. */
    due() {
      current.client
        .prepare(
          "UPDATE monitor_state SET last_observation_at=1 WHERE monitor_id='held' AND workspace_path=?",
        )
        .run(root);
    },
  };
}

for (const [kind, policy] of Object.entries(policies)) {
  for (const route of ['tick', 'startup'] as const) {
    for (const rawSource of ['null', ' { "legacy" : [1, 2] } ']) {
      it(`${kind} ${route} preserves raw baseline through edit, reopen and actual next observe: ${rawSource}`, async () => {
        const f = fixture(policy);
        await f.tick();
        f.legacy(rawSource);
        f.restart();
        const baseline = f.raw();
        const before = f.artifacts();
        const held = kind === 'debounce' || kind === 'rollup';
        // Startup learns identity without entering the separate ordinary not-due rollup flush path.
        expect(await f.startup()).toEqual([]);
        await f.stop();
        expect(f.raw()).toEqual(baseline);
        const learned = f.state().notifyState as PolicyNotifyState;
        expect(learned.policyKey).toEqual(expect.any(String));
        f.restart();
        f.edit(
          'notify:\n  strategy: throttle\n  suppress-for: 1s\n',
          'Edited handling',
        );
        vi.setSystemTime(new Date(START.getTime() + 2_000));
        if (route === 'tick')
          expect((await f.tick()).erroredObservations).toEqual([]);
        else expect(await f.startup()).toEqual([]);
        expect(f.previous).toHaveLength(1);
        expect(f.raw()).toEqual(baseline);
        const notify = f.state().notifyState as PolicyNotifyState;
        expect(notify.policyKey).not.toBe(learned.policyKey);
        expect(notify.pendingDebounce).toBeUndefined();
        expect(notify.pendingRollup).toBeUndefined();
        expect(notify.suppressedUntil).toBeUndefined();
        expect(notify.rollupLastFiredMinute).toBeUndefined();
        expect(f.summaries()).toEqual(['A']);
        if (!held) expect(f.artifacts()).toEqual(before);
        else {
          expect(f.artifacts().snapshot?.content).toBe('A');
          expect(f.artifacts().cursor).toBeDefined();
          expect(
            f.current.client
              .prepare('SELECT body FROM monitor_events')
              .pluck()
              .get(),
          ).toContain('Original handling');
        }
        await f.stop();
        const committed = f.artifacts();
        f.restart();
        expect(f.raw()).toEqual(baseline);
        expect(f.artifacts()).toEqual(committed);
        f.due();
        expect((await f.tick()).erroredObservations).toEqual([]);
        expect(f.previous).toEqual([undefined, JSON.parse(rawSource)]);
        expect(f.summaries()).toEqual(['A', 'B']);
        // Every admitted live factory received the untouched opaque baseline.
        expect(f.watched).toEqual(
          Array.from({ length: route === 'tick' ? 1 : 2 }, () =>
            JSON.parse(rawSource),
          ),
        );
        f.restart();
        expect(f.summaries()).toEqual(['A', 'B']);
        expect(f.state().sourceState).toEqual({ cursor: 2 });
      });
    }
  }
}

for (const kind of ['throttle', 'debounce'] as const) {
  it(`${kind} failed notify-only write rolls back raw baseline and all materialization, then retries`, async () => {
    const f = fixture(policies[kind]);
    await f.tick();
    f.legacy('null');
    f.restart();
    await f.tick();
    const baseline = f.raw();
    const oldState = f.state();
    const oldArtifacts = f.artifacts();
    f.current.client.exec(
      "CREATE TRIGGER reject_notify BEFORE UPDATE OF notify_state ON monitor_state WHEN NEW.monitor_id='held' BEGIN SELECT RAISE(ABORT,'reject notify-only'); END",
    );
    f.edit('notify:\n  strategy: throttle\n  suppress-for: 1s\n');
    const failed = await f.tick();
    expect(failed.erroredObservations).toEqual([
      expect.objectContaining({
        monitorId: 'held',
        message: expect.stringContaining('reject notify-only'),
      }),
    ]);
    expect(f.previous).toHaveLength(1);
    expect(f.raw()).toEqual(baseline);
    expect(f.state()).toEqual(oldState);
    expect(f.artifacts()).toEqual(oldArtifacts);
    f.restart();
    expect(f.raw()).toEqual(baseline);
    expect(f.state()).toEqual(oldState);
    f.current.client.exec('DROP TRIGGER reject_notify');
    expect((await f.tick()).erroredObservations).toEqual([]);
    expect(f.raw()).toEqual(baseline);
    expect(f.summaries()).toEqual(['A']);
    f.restart();
    expect(f.raw()).toEqual(baseline);
    f.due();
    await f.tick();
    expect(f.previous).toEqual([undefined, null]);
    expect(f.summaries()).toEqual(['A', 'B']);
  });
}

it('unchanged effective policy retains the exact opaque baseline until the actual due source call', async () => {
  const f = fixture(policies.throttle);
  await f.tick();
  f.legacy('null');
  f.restart();
  await f.tick();
  const baseline = f.raw();
  f.edit(policies.throttle.replace('1h', '60m'), 'Body-only edit');
  expect((await f.tick()).erroredObservations).toEqual([]);
  expect(f.raw()).toEqual(baseline);
  expect(f.previous).toHaveLength(1);
  f.restart();
  expect(f.raw()).toEqual(baseline);
  f.due();
  await f.tick();
  expect(f.previous).toEqual([undefined, null]);
});
