/**
 * An observation a debounce or rollup hold refused (002 §4.7) is loss, like an
 * observation the retry outbox could not retain (002 §2): it is recorded with
 * the same drop identity, `doctor` and `explain` keep reporting it as
 * outstanding, and only supersession clears it. Quiet ticks, holds and
 * restarts do not.
 *
 * Regression for #575: a refusal used to be reported once, as an `errored`
 * history row and a tick-result entry, and was never outstanding loss.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#exceptions
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { Observation, ObservationSource } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Fixed first observation instant; the daily rollup window opens an hour later. */
const START = new Date('2026-03-20T08:00:00Z');
const MONITOR_ID = 'held';
const roots: string[] = [];
const clients: Database[] = [];

/**
 * The test clock. Native Date instances are preserved (as in
 * `unretainable-suffix-admission.test.ts`): retry envelopes reject subclassed
 * timestamps, which fake timers would produce.
 */
let clockTime = START.getTime();
beforeEach(() => {
  clockTime = START.getTime();
  vi.stubGlobal(
    'Date',
    new Proxy(Date, {
      construct(target, args) {
        return Reflect.construct(
          target,
          args.length === 0 ? [clockTime] : args,
        );
      },
      get(target, key, receiver) {
        return key === 'now'
          ? () => clockTime
          : Reflect.get(target, key, receiver);
      },
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const client of clients.splice(0)) {
    if (client.open) client.close();
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Authored notify policies whose observations wait in durable holds. */
const policies = {
  debounce: 'notify:\n  strategy: debounce\n  settle-for: 10s\n',
  rollup: "notify:\n  strategy: rollup\n  window: '0 9 * * *'\n",
} as const;
type HeldStrategy = keyof typeof policies;

/**
 * A file-backed runtime over a cursor-driven stateful source: it reports
 * `batches[cursor]` and advances only through its persisted `nextState`.
 * `restart()` closes the database and opens a new runtime on the same file.
 */
function fixture(
  policy: string,
  batches: (() => Observation[])[],
  urgency = 'normal',
) {
  const root = mkdtempSync(path.join(tmpdir(), 'hold-refusal-loss-'));
  roots.push(root);
  const monitorsDir = path.join(root, 'monitors');
  const dir = path.join(monitorsDir, MONITOR_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    `---\nname: Held\nwatch:\n  type: cursor-source\n  interval: 1s\nurgency: ${urgency}\nbaseline-strategy: incremental\n${policy}---\nInstructions\n`,
  );
  const source: ObservationSource = {
    name: 'cursor-source',
    stateful: true,
    scopeSchema: {
      type: 'object',
      properties: { interval: { type: 'string' } },
    },
    observe(_config, context) {
      const cursor =
        (context.previousState as { cursor?: number } | undefined)?.cursor ?? 0;
      return Promise.resolve({
        observations: batches[cursor]?.() ?? [],
        nextState: { cursor: cursor + 1 },
      });
    },
  };
  const dbPath = path.join(root, 'state.sqlite');
  function open() {
    const db = createDb(dbPath);
    // Test-only driver access lets the fixture close and reopen the real file.
    const client = (db as unknown as { $client: Database }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    const registry = new SourceRegistry();
    registry.register(source);
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    return { client, store, runtime };
  }
  let current = open();
  const session = current.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  return {
    /** Advance past the poll interval and run one tick. */
    async tick(ms = 2_000) {
      clockTime += ms;
      return current.runtime.tick(monitorsDir, root);
    },
    /** Move the clock to an absolute instant and run one tick. */
    async tickAt(iso: string) {
      clockTime = new Date(iso).getTime();
      return current.runtime.tick(monitorsDir, root);
    },
    restart() {
      current.client.close();
      current = open();
    },
    /** Test-only native SQL, used to install and clear storage faults. */
    exec: (sql: string) => current.client.exec(sql),
    pendingRetries: () =>
      current.store.materializationRetrySummary(MONITOR_ID, root).pending,
    /**
     * Complete the retained retry of the observation titled `title`, as a
     * retry drain would (`unretainable-suffix-admission.test.ts` does the
     * same): its event keeps the retry's admission position.
     */
    completeRetry(title: string) {
      const retry = current.store
        .listMaterializationRetries({
          monitorId: MONITOR_ID,
          workspacePath: root,
        })
        .find((candidate) => candidate.envelope.observation.title === title);
      if (!retry) throw new Error(`no retained retry for ${title}`);
      const { observation, observedAt } = retry.envelope;
      return current.store.completeMaterializationRetry(retry.id, {
        monitorId: MONITOR_ID,
        workspacePath: root,
        sourceName: 'cursor-source',
        urgency: 'normal',
        title: observation.title,
        body: '',
        summary: observation.title,
        payload: {},
        snapshotMetadata: {},
        snapshotText: observation.snapshotText ?? null,
        diffText: null,
        objectKey: observation.objectKey ?? MONITOR_ID,
        baselineStrategy: 'incremental',
        queryScope: {},
        tags: [],
        createdAt: observedAt,
      });
    },
    async doctorLoss() {
      const report = await current.runtime.doctorReport({
        monitorsDir,
        workspacePath: root,
      });
      const [rollup] = report.monitors;
      if (!rollup) throw new Error('doctor reported no monitor');
      return rollup.unretainedObservationLoss;
    },
    async explainMaterialization() {
      const report = await current.runtime.explainMonitor({
        monitorsDir,
        monitorId: MONITOR_ID,
        workspacePath: root,
      });
      return report.stages.find((stage) => stage.id === 'materialization');
    },
    newestHistoryResult: () =>
      current.store.listObservationHistory({
        monitorId: MONITOR_ID,
        workspacePath: root,
        limit: 1,
      })[0]?.result,
    refusalRows: () =>
      current.store
        .listObservationHistory({
          monitorId: MONITOR_ID,
          workspacePath: root,
        })
        .filter((row) =>
          String(row.observationData['error']).includes('was not held'),
        ),
    heldTitles() {
      const notify = current.store.getMonitorState(
        MONITOR_ID,
        root,
      ).notifyState;
      return (
        notify.pendingDebounce?.observations ??
        notify.pendingRollup?.observations ??
        []
      ).map((envelope) => envelope.observation.title);
    },
    eventSummaries: () =>
      current.store
        .listEvents({ sessionId: session.id })
        .reverse()
        .map((event) => event.summary),
  };
}
type Fixture = ReturnType<typeof fixture>;

/** A plain observation; `key` defaults to the title, `null` omits it. */
const obs = (
  title: string,
  options: { key?: string | null; payload?: Record<string, unknown> } = {},
): Observation => ({
  title,
  snapshotText: title,
  ...(options.key === null ? {} : { objectKey: options.key ?? title }),
  ...(options.payload ? { payload: options.payload } : {}),
});

/** A payload `JSON.stringify` rejects, so no hold can accept it. */
const bigint = (): Record<string, unknown> => ({ count: 10n });

/** The refusal's §4.7 outcome text for an observation titled `title`. */
const refusalText = (title: string, strategy: HeldStrategy) =>
  expect.stringMatching(
    new RegExp(
      `^Observation "${title}" was not held for ${strategy}: it cannot be serialized \\(.*BigInt.*\\)\\.$`,
      'u',
    ),
  );

/** Flush whatever the hold has accumulated: past the settle window, or at the next window. */
const flushAt: Record<
  HeldStrategy,
  (f: Fixture) => ReturnType<Fixture['tick']>
> = {
  debounce: (f) => f.tick(30_000),
  rollup: (f) => f.tickAt('2026-03-20T09:00:00Z'),
};
/** A second, later flush for a hold started after the first one. */
const secondFlushAt: Record<
  HeldStrategy,
  (f: Fixture) => ReturnType<Fixture['tick']>
> = {
  debounce: (f) => f.tick(30_000),
  rollup: (f) => f.tickAt('2026-03-21T09:00:00Z'),
};

/** Doctor and explain both report one outstanding loss naming the refusal. */
async function expectOutstanding(
  f: Fixture,
  strategy: HeldStrategy,
  identity: { count: number; objectKey?: string; title: string },
) {
  const loss = await f.doctorLoss();
  expect(loss).toMatchObject({
    count: identity.count,
    title: identity.title,
    error: refusalText(identity.title, strategy),
  });
  if (identity.objectKey === undefined) {
    expect(loss).not.toHaveProperty('objectKey');
  } else {
    expect(loss?.objectKey).toBe(identity.objectKey);
  }
  const stage = await f.explainMaterialization();
  expect(stage?.status).toBe('failure');
  expect(stage?.reason).toContain('was not held for');
  expect(stage?.reason).toContain(`"${identity.title}"`);
}

async function expectCleared(f: Fixture) {
  expect(await f.doctorLoss()).toBeUndefined();
  expect((await f.explainMaterialization())?.status).not.toBe('failure');
}

for (const strategy of ['debounce', 'rollup'] as const) {
  describe(`a ${strategy} hold refusal is outstanding loss (#575)`, () => {
    it('with an object key: kept through quiet ticks, holds, a restart and other keys, cleared by a later event of its key', async () => {
      const f = fixture(policies[strategy], [
        () => [obs('Bad', { payload: bigint() }), obs('A')],
        () => [],
        () => [obs('B')],
        () => [],
        () => [obs('Bad')],
      ]);

      const first = await f.tick();
      // The refusal keeps its own report (002 §4.7).
      expect(first.erroredObservations).toEqual([
        { monitorId: MONITOR_ID, message: refusalText('Bad', strategy) },
      ]);
      expect(f.refusalRows()).toHaveLength(1);
      expect(f.heldTitles()).toEqual(['A']);
      await expectOutstanding(f, strategy, {
        count: 1,
        objectKey: 'Bad',
        title: 'Bad',
      });

      // A quiet tick and a hold write newer history rows; neither clears it.
      await f.tick();
      await f.tick();
      expect(f.heldTitles()).toEqual(['A', 'B']);
      expect(f.newestHistoryResult()).toBe('suppressed');
      await expectOutstanding(f, strategy, {
        count: 1,
        objectKey: 'Bad',
        title: 'Bad',
      });

      f.restart();
      await expectOutstanding(f, strategy, {
        count: 1,
        objectKey: 'Bad',
        title: 'Bad',
      });

      // The flush materializes events for other keys only: still outstanding.
      const flushed = await flushAt[strategy](f);
      expect(flushed.emittedEventIds).toHaveLength(2);
      expect(f.newestHistoryResult()).toBe('triggered');
      await expectOutstanding(f, strategy, {
        count: 1,
        objectKey: 'Bad',
        title: 'Bad',
      });

      // A later observation of the same key is held, which is not yet an event.
      await f.tick();
      await f.tick();
      expect(f.heldTitles()).toEqual(['Bad']);
      await expectOutstanding(f, strategy, {
        count: 1,
        objectKey: 'Bad',
        title: 'Bad',
      });

      // Its event supersedes the refusal.
      await secondFlushAt[strategy](f);
      expect(f.eventSummaries()).toEqual(['A', 'B', 'Bad']);
      await expectCleared(f);
      // The refusal itself was reported once and is never re-observed.
      expect(f.refusalRows()).toHaveLength(1);
    });

    it('without an object key: kept through quiet ticks, holds and a restart, cleared by a later span that materializes and drops nothing', async () => {
      const f = fixture(policies[strategy], [
        () => [obs('Bad', { key: null, payload: bigint() }), obs('A')],
        () => [],
        () => [obs('B')],
      ]);

      await f.tick();
      await expectOutstanding(f, strategy, { count: 1, title: 'Bad' });

      await f.tick();
      await f.tick();
      expect(f.heldTitles()).toEqual(['A', 'B']);
      expect(f.newestHistoryResult()).toBe('suppressed');
      await expectOutstanding(f, strategy, { count: 1, title: 'Bad' });

      f.restart();
      await expectOutstanding(f, strategy, { count: 1, title: 'Bad' });

      // The flush is a later span that materializes events and loses nothing.
      await flushAt[strategy](f);
      expect(f.eventSummaries()).toEqual(['A', 'B']);
      await expectCleared(f);
    });
  });
}

describe('which spans supersede a debounce refusal (#575)', () => {
  it('a span that materializes but refuses again does not clear an unkeyed refusal; a clean span clears both', async () => {
    const f = fixture(policies.debounce, [
      () => [obs('Bad', { key: null, payload: bigint() }), obs('A')],
      // Arrives on the tick A's settle window has passed: A is flushed and
      // materialized by the same span that refuses Bad2.
      () => [obs('Bad2', { key: null, payload: bigint() }), obs('B')],
    ]);

    await f.tick();
    const mixed = await f.tick(30_000);
    expect(mixed.emittedEventIds).toHaveLength(1);
    expect(f.eventSummaries()).toEqual(['A']);
    expect(f.heldTitles()).toEqual(['B']);
    expect(f.newestHistoryResult()).toBe('triggered');
    // That span's own batch row counts its refusal, so it supersedes nothing.
    await expectOutstanding(f, 'debounce', { count: 2, title: 'Bad2' });

    f.restart();
    await f.tick(30_000);
    expect(f.eventSummaries()).toEqual(['A', 'B']);
    await expectCleared(f);
  });

  it('an earlier sibling of the same key in the refusing span does not supersede it', async () => {
    const f = fixture(
      policies.debounce,
      [
        () => [obs('H')],
        // The escalated K flushes [H, K] now (002 §4.1); Bad, refused after
        // it, is a newer observation of key K.
        () => [
          { ...obs('K'), salience: 'high' as const },
          obs('Bad', { key: 'K', payload: bigint() }),
        ],
      ],
      'normal..high',
    );
    await f.tick();
    await f.tick();
    expect(f.eventSummaries()).toEqual(['H', 'K']);
    await expectOutstanding(f, 'debounce', {
      count: 1,
      objectKey: 'K',
      title: 'Bad',
    });
  });

  it('a later sibling of the same key in the refusing span supersedes it', async () => {
    const f = fixture(
      policies.debounce,
      [
        () => [obs('H')],
        () => [
          obs('Bad', { key: 'K', payload: bigint() }),
          { ...obs('K'), salience: 'high' as const },
        ],
      ],
      'normal..high',
    );
    await f.tick();
    const span = await f.tick();
    expect(span.erroredObservations).toEqual([
      { monitorId: MONITOR_ID, message: refusalText('Bad', 'debounce') },
    ]);
    expect(f.eventSummaries()).toEqual(['H', 'K']);
    await expectCleared(f);
  });

  it('held work from an earlier tick, flushed by a later escalation in the refusing span, does not supersede it', async () => {
    const f = fixture(
      policies.debounce,
      [
        () => [obs('H', { key: 'K' })],
        // Bad is refused while H is held; the escalated E then flushes [H, E]
        // (002 §4.1). H is older than Bad, so its event is not a later one.
        () => [
          obs('Bad', { key: 'K', payload: bigint() }),
          { ...obs('E'), salience: 'high' as const },
        ],
      ],
      'normal..high',
    );
    await f.tick();
    expect(f.heldTitles()).toEqual(['H']);
    const span = await f.tick();
    expect(span.erroredObservations).toEqual([
      { monitorId: MONITOR_ID, message: refusalText('Bad', 'debounce') },
    ]);
    expect(f.eventSummaries()).toEqual(['H', 'E']);
    await expectOutstanding(f, 'debounce', {
      count: 1,
      objectKey: 'K',
      title: 'Bad',
    });
  });

  it('an older sibling held in the refusing span and flushed by a later escalation does not supersede it', async () => {
    const f = fixture(
      policies.debounce,
      [
        () => [],
        // A is held, Bad is refused, and the escalated E flushes [A, E]. A
        // arrived before Bad, so its event is not a later one.
        () => [
          obs('A', { key: 'K' }),
          obs('Bad', { key: 'K', payload: bigint() }),
          { ...obs('E'), salience: 'high' as const },
        ],
      ],
      'normal..high',
    );
    await f.tick();
    await f.tick();
    expect(f.eventSummaries()).toEqual(['A', 'E']);
    await expectOutstanding(f, 'debounce', {
      count: 1,
      objectKey: 'K',
      title: 'Bad',
    });
  });

  it('a newer sibling held after the refusal and flushed by a later escalation supersedes it', async () => {
    const f = fixture(
      policies.debounce,
      [
        () => [],
        // Bad is refused with nothing held; C is held after it, and the
        // escalated E flushes [C, E]. C is newer than Bad and is the first
        // envelope of the span, so this pins the refusal's place exactly.
        () => [
          obs('Bad', { key: 'K', payload: bigint() }),
          obs('C', { key: 'K' }),
          { ...obs('E'), salience: 'high' as const },
        ],
      ],
      'normal..high',
    );
    await f.tick();
    await f.tick();
    expect(f.eventSummaries()).toEqual(['C', 'E']);
    await expectCleared(f);
  });

  it('a retry of an older sibling queued in the refusing span does not supersede it', async () => {
    const f = fixture(
      policies.debounce,
      [
        () => [obs('H')],
        // Dispatch order: the escalated K flushes [H, K]; Bad (key K) is
        // refused after them; X is held and the escalated Y flushes [X, Y].
        () => [
          { ...obs('K'), salience: 'high' as const },
          obs('Bad', { key: 'K', payload: bigint() }),
          obs('X'),
          { ...obs('Y'), salience: 'high' as const },
        ],
        () => [],
        () => [obs('K2', { key: 'K' })],
      ],
      'normal..high',
    );
    await f.tick();
    // K cannot materialize, so it and every later sibling are retained in
    // order (002 §2); the refusal comes after K in that order.
    f.exec(
      "CREATE TRIGGER fault_k BEFORE INSERT ON monitor_events WHEN NEW.summary = 'K' BEGIN SELECT RAISE(ABORT, 'native fault on K'); END",
    );
    await f.tick();
    expect(f.eventSummaries()).toEqual(['H']);
    expect(f.pendingRetries()).toBe(3);
    await expectOutstanding(f, 'debounce', {
      count: 1,
      objectKey: 'K',
      title: 'Bad',
    });

    f.exec('DROP TRIGGER fault_k');
    f.completeRetry('K');
    expect(f.pendingRetries()).toBe(2);
    // K's retried event is an older observation of the key than Bad.
    await expectOutstanding(f, 'debounce', {
      count: 1,
      objectKey: 'K',
      title: 'Bad',
    });

    // A newer observation of the key supersedes it once it materializes.
    f.completeRetry('X');
    f.completeRetry('Y');
    await f.tick();
    await f.tick();
    await f.tick(30_000);
    expect(f.eventSummaries()).toContain('K2');
    await expectCleared(f);
  });
});
