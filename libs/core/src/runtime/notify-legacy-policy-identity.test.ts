/** 002 §4.6: successful unchanged reconciliation learns missing identity without retiring its clocks. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { SourceRegistry } from '../observation/registry.js';
import type { PolicyNotifyState } from './notify-policy.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Frozen time makes unchanged delivery clocks and same-minute rollup guards exact assertions. */
const START = new Date('2026-03-20T09:00:00Z');
const THROTTLE = 'notify:\n  strategy: throttle\n  suppress-for: 1h\n';
const ROLLUP = "notify:\n  strategy: rollup\n  window: '* * * * *'\n";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

/** Actual files, finite source effects and file-backed SQLite expose identity learning across restart. */
function fixture(policy: string) {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'notify-legacy-identity-'));
  const dir = path.join(root, 'monitors');
  mkdirSync(dir);
  const file = path.join(dir, 'held.md');
  const dbPath = path.join(root, 'state.sqlite');
  const previous: unknown[] = [];
  let calls = 0;
  const registry = new SourceRegistry();
  registry.register({
    name: 'identity-source',
    stateful: true,
    scopeSchema: { type: 'object', properties: { token: { type: 'string' } } },
    async observe(_config, context) {
      previous.push(context.previousState);
      calls++;
      const title = String.fromCharCode(64 + calls);
      return {
        observations: [{ title, snapshotText: title, objectKey: 'obj' }],
        nextState: { cursor: calls },
      };
    },
  });
  function open() {
    const db = createDb(dbPath);
    // Native access only seeds a controlled older persisted shape, injects faults and proves reopen.
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
  function edit(
    nextPolicy = policy,
    token?: number,
    source = 'identity-source',
  ) {
    writeFileSync(
      file,
      '---\nwatch:\n  type: ' +
        source +
        '\n  interval: 1h\n' +
        (token === undefined ? '' : '  token: ' + token + '\n') +
        'baseline-strategy: incremental\n' +
        nextPolicy +
        '---\nOriginal handling\n',
    );
  }
  edit();
  function state() {
    const value = current.store.getMonitorState('held', root);
    const notifyState: PolicyNotifyState = value.notifyState;
    return { ...value, notifyState };
  }
  cleanups.push(() => {
    if (current.client.open) current.client.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    edit,
    state,
    previous,
    get current() {
      return current;
    },
    get calls() {
      return calls;
    },
    tick: () => current.runtime.tick(dir, root),
    rows: () =>
      current.client
        .prepare('SELECT * FROM monitor_events ORDER BY rowid')
        .all(),
    summaries: () =>
      current.client
        .prepare('SELECT summary FROM monitor_events ORDER BY rowid')
        .pluck()
        .all(),
    durableArtifacts: () => ({
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
    }),
    /** Remove only private metadata from this owned compatibility fixture, never from a user database. */
    legacy() {
      current.client
        .prepare(
          "UPDATE monitor_state SET notify_state = json_remove(notify_state, '$.policyKey') WHERE monitor_id = 'held' AND workspace_path = ?",
        )
        .run(root);
    },
    restart() {
      current.client.close();
      current = open();
    },
    due() {
      current.store.setMonitorState('held', root, {
        ...state(),
        lastObservationAt: new Date('2000-01-01T00:00:00Z'),
      });
    },
  };
}

for (const kind of ['throttle', 'rollup-minute'] as const) {
  for (const restartAfterLearning of [false, true]) {
    it(
      kind +
        ' learns identity on an unchanged not-due scan, then resets a later edit, restart=' +
        restartAfterLearning,
      async () => {
        const policy = kind === 'throttle' ? THROTTLE : ROLLUP;
        const f = fixture(policy);
        await f.tick();
        const original = f.state();
        const knownKey = original.notifyState.policyKey;
        expect(knownKey).toEqual(expect.any(String));
        expect(f.summaries()).toEqual(['A']);
        f.legacy();
        f.restart();
        const legacy = f.state();
        const artifacts = f.durableArtifacts();
        vi.setSystemTime(new Date(START.getTime() + 2_000));
        const unchanged = await f.tick();
        expect(unchanged.erroredObservations).toEqual([]);
        expect(unchanged.emittedEventIds).toEqual([]);
        expect(
          unchanged.skippedMonitors.map((item) => item.monitorId),
        ).toContain('held');
        expect(f.calls).toBe(1);
        expect(f.state()).toEqual({
          ...legacy,
          notifyState: { ...legacy.notifyState, policyKey: knownKey },
        });
        expect(f.durableArtifacts()).toEqual(artifacts);
        if (restartAfterLearning) f.restart();
        expect(f.state().notifyState.policyKey).toBe(knownKey);
        // Normalized duration spelling and explicit/default UTC are effective-equivalent policies.
        const equivalent =
          kind === 'throttle'
            ? THROTTLE.replace('1h', '60m')
            : ROLLUP + '  timezone: UTC\n';
        f.edit(equivalent);
        await f.tick();
        expect(f.state()).toEqual({
          ...legacy,
          notifyState: { ...legacy.notifyState, policyKey: knownKey },
        });
        expect(f.durableArtifacts()).toEqual(artifacts);
        f.edit(kind === 'throttle' ? THROTTLE.replace('1h', '1s') : '');
        const changed = await f.tick();
        expect(changed.erroredObservations).toEqual([]);
        expect(changed.emittedEventIds).toEqual([]);
        expect(f.calls).toBe(1);
        expect(f.state().notifyState.suppressedUntil).toBeUndefined();
        expect(f.state().notifyState.rollupLastFiredMinute).toBeUndefined();
        expect(f.state().notifyState.policyKey).not.toBe(knownKey);
        f.due();
        const work = await f.tick();
        expect(work.emittedEventIds).toHaveLength(1);
        expect(f.summaries()).toEqual(['A', 'B']);
        expect(f.rows()[0]).toEqual(artifacts.events[0]);
        expect(f.state().sourceState).toEqual({ cursor: 2 });
        if (kind === 'throttle')
          expect(f.state().notifyState.suppressedUntil).toBe(
            new Date(START.getTime() + 3_000).toISOString(),
          );
        const final = f.state();
        const rows = f.rows();
        f.restart();
        expect(f.state()).toEqual(final);
        expect(f.rows()).toEqual(rows);
      },
    );
  }
}

for (const policy of [
  'notify:\n  strategy: debounce\n  settle-for: 1h\n',
  "notify:\n  strategy: rollup\n  window: '0 10 * * *'\n",
]) {
  it(
    'learns missing identity without flushing an identical legacy hold: ' +
      policy,
    async () => {
      const f = fixture(policy);
      await f.tick();
      const knownKey = f.state().notifyState.policyKey;
      expect(f.summaries()).toEqual([]);
      f.legacy();
      f.restart();
      const legacy = f.state();
      vi.setSystemTime(new Date(START.getTime() + 2_000));
      await f.tick();
      expect(f.state()).toEqual({
        ...legacy,
        notifyState: { ...legacy.notifyState, policyKey: knownKey },
      });
      expect(f.calls).toBe(1);
      expect(f.summaries()).toEqual([]);
      f.restart();
      expect(f.state().notifyState.policyKey).toBe(knownKey);
    },
  );
}

it('learns the first known current policy without inferring an unknowable earlier edit', async () => {
  const f = fixture(THROTTLE);
  await f.tick();
  const oldKey = f.state().notifyState.policyKey;
  const oldGuard = f.state().notifyState.suppressedUntil;
  f.legacy();
  f.restart();
  f.edit(THROTTLE.replace('1h', '1s'));
  await f.tick();
  const learnedKey = f.state().notifyState.policyKey;
  expect(learnedKey).toEqual(expect.any(String));
  expect(learnedKey).not.toBe(oldKey);
  expect(f.state().notifyState.suppressedUntil).toBe(oldGuard);
  await f.tick();
  expect(f.state().notifyState.suppressedUntil).toBe(oldGuard);
  expect(f.state().notifyState.policyKey).toBe(learnedKey);
  f.edit(THROTTLE.replace('1h', '2s'));
  await f.tick();
  expect(f.state().notifyState.suppressedUntil).toBeUndefined();
  expect(f.state().notifyState.policyKey).not.toBe(learnedKey);
});

it('failed identity persistence leaves original guards/baseline/events and retries under the writer', async () => {
  const f = fixture(THROTTLE);
  await f.tick();
  const key = f.state().notifyState.policyKey;
  f.legacy();
  f.restart();
  const legacy = f.state();
  const artifacts = f.durableArtifacts();
  f.current.client.exec(
    "CREATE TRIGGER identity_fault BEFORE UPDATE ON monitor_state WHEN json_extract(NEW.notify_state, '$.policyKey') IS NOT NULL AND json_extract(OLD.notify_state, '$.policyKey') IS NULL BEGIN SELECT RAISE(FAIL, 'owned identity write fault'); END",
  );
  const result = await f.tick();
  expect(
    result.erroredObservations.some((item) =>
      item.message.includes('owned identity write fault'),
    ),
  ).toBe(true);
  expect(f.state()).toEqual(legacy);
  expect(f.durableArtifacts()).toEqual(artifacts);
  expect(f.calls).toBe(1);
  f.restart();
  expect(f.state().notifyState.policyKey).toBeUndefined();
  f.current.client.exec('DROP TRIGGER identity_fault');
  await f.tick();
  expect(f.state()).toEqual({
    ...legacy,
    notifyState: { ...legacy.notifyState, policyKey: key },
  });
});

it('held-work source validation must succeed before missing identity is learned', async () => {
  const f = fixture('notify:\n  strategy: debounce\n  settle-for: 1h\n');
  await f.tick();
  const key = f.state().notifyState.policyKey;
  f.legacy();
  f.restart();
  const legacy = f.state();
  f.edit(undefined, 7);
  const invalid = await f.tick();
  // Source-config preflight (002 §2.0) skips the scope before notify
  // preparation, so held work and the missing identity stay untouched.
  expect(invalid.skippedMonitors).toEqual([
    expect.objectContaining({ validationError: expect.any(String) }),
  ]);
  expect(f.state()).toEqual(legacy);
  f.restart();
  expect(f.state()).toEqual(legacy);
  f.edit();
  await f.tick();
  expect(f.state()).toEqual({
    ...legacy,
    notifyState: { ...legacy.notifyState, policyKey: key },
  });
  expect(f.calls).toBe(1);
});

for (const invalid of ['frontmatter', 'unknown-source'] as const) {
  it(
    invalid + ' cannot learn a false successful identity for guard-only state',
    async () => {
      const f = fixture(THROTTLE);
      await f.tick();
      const key = f.state().notifyState.policyKey;
      f.legacy();
      f.restart();
      const legacy = f.state();
      if (invalid === 'frontmatter')
        writeFileSync(f.file, '---\nwatch: invalid\n---');
      else f.edit(undefined, undefined, 'absent-source');
      const failure = await f.tick().then(
        () => undefined,
        (error: unknown) => error,
      );
      if (invalid === 'unknown-source')
        expect(String(failure)).toContain('unknown source');
      expect(f.state()).toEqual(legacy);
      expect(f.calls).toBe(1);
      f.edit();
      await f.tick();
      expect(f.state().notifyState.policyKey).toBe(key);
      expect(f.state().notifyState.suppressedUntil).toBe(
        legacy.notifyState.suppressedUntil,
      );
    },
  );
}

it('an already identified unchanged guard does not require another state write', async () => {
  const f = fixture(THROTTLE);
  await f.tick();
  const state = f.state();
  f.current.client.exec(
    "CREATE TRIGGER no_rewrite BEFORE UPDATE ON monitor_state BEGIN SELECT RAISE(FAIL, 'unchanged state must not rewrite'); END",
  );
  const result = await f.tick();
  expect(result.erroredObservations).toEqual([]);
  expect(f.state()).toEqual(state);
  expect(f.calls).toBe(1);
});

it('identity learning refuses an externally owned transaction and succeeds after rollback', async () => {
  const f = fixture(THROTTLE);
  await f.tick();
  const key = f.state().notifyState.policyKey;
  f.legacy();
  f.restart();
  const legacy = f.state();
  f.current.client.exec('BEGIN');
  try {
    const failed = await f.tick();
    expect(
      failed.erroredObservations.some((item) =>
        item.message.includes('owned writer transaction'),
      ),
    ).toBe(true);
    expect(f.state()).toEqual(legacy);
  } finally {
    f.current.client.exec('ROLLBACK');
  }
  await f.tick();
  expect(f.state()).toEqual({
    ...legacy,
    notifyState: { ...legacy.notifyState, policyKey: key },
  });
});

it('a fresh scope retains undefined previousState until its first actual observation', async () => {
  const f = fixture(THROTTLE);
  await f.tick();
  expect(f.previous).toEqual([undefined]);
  expect(f.calls).toBe(1);
  expect(f.summaries()).toEqual(['A']);
});

it('identity-only learning preserves raw legacy source representation and fingerprint columns', async () => {
  const f = fixture(THROTTLE);
  await f.tick();
  const key = f.state().notifyState.policyKey;
  f.legacy();
  // Older persisted source representations remain opaque to notify identity learning.
  f.current.client
    .prepare(
      "UPDATE monitor_state SET source_state = 'null', last_fingerprint = 'legacy-fingerprint' WHERE monitor_id = 'held' AND workspace_path = ?",
    )
    .run(f.root);
  f.restart();
  const legacy = f.state();
  const rawBaseline = () =>
    f.current.client
      .prepare(
        "SELECT source_state, last_fingerprint, last_observation_at FROM monitor_state WHERE monitor_id = 'held' AND workspace_path = ?",
      )
      .get(f.root);
  const before = rawBaseline();
  const artifacts = f.durableArtifacts();
  await f.tick();
  expect(f.state()).toEqual({
    ...legacy,
    notifyState: { ...legacy.notifyState, policyKey: key },
  });
  expect(rawBaseline()).toEqual(before);
  expect(f.durableArtifacts()).toEqual(artifacts);
  expect(f.calls).toBe(1);
});
