/**
 * An observation that cannot be serialized never enters held notify work
 * (002 §4.7). Debounce and rollup holds persist their envelopes in
 * `monitor_state.notify_state`; one BigInt or cyclic payload must not stop the
 * monitor, and the observation that carried it ends as a visible `errored`
 * outcome while its batch siblings and later observations proceed.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#exceptions
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  Observation,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

/** Fixed first observation instant; the rollup window opens an hour later. */
const START = new Date('2026-03-20T08:00:00Z');
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

/** Authored notify policies that hold observations in durable notify state. */
const policies = {
  debounce: 'notify:\n  strategy: debounce\n  settle-for: 10s\n',
  rollup: "notify:\n  strategy: rollup\n  window: '0 9 * * *'\n",
  immediate: '',
} as const;

/**
 * Payloads `JSON.stringify` rejects. Each factory builds a fresh value so a
 * source can report it again on every observe() call.
 */
const unserializable = {
  bigint: {
    payload: (): Record<string, unknown> => ({ count: 10n }),
    reason: /BigInt/u,
  },
  cycle: {
    payload: (): Record<string, unknown> => {
      const loop: Record<string, unknown> = { name: 'loop' };
      loop['self'] = loop;
      return loop;
    },
    reason: /circular/iu,
  },
} as const;

type PayloadKind = keyof typeof unserializable;
type HeldStrategy = 'debounce' | 'rollup';

/**
 * A file-backed runtime over a cursor-driven source. The source reports
 * `batches[cursor]` and advances the cursor only through its persisted
 * `nextState`, exactly as a real stateful source does: if the runtime cannot
 * commit the batch, the same batch is observed again on the next tick.
 */
function fixture(
  policy: string,
  batches: (() => Observation[])[],
  watched?: () => Iterable<ObservationResult>,
  urgency = 'normal',
) {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const root = mkdtempSync(path.join(tmpdir(), 'notify-hold-serialize-'));
  roots.push(root);
  const monitors = path.join(root, 'monitors');
  const dir = path.join(monitors, 'held');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'MONITOR.md');
  const edit = (nextPolicy: string) =>
    writeFileSync(
      file,
      `---\nname: Held\nwatch:\n  type: cursor-source\n  interval: 1s\nurgency: ${urgency}\nbaseline-strategy: incremental\n${nextPolicy}---\nInstructions\n`,
    );
  edit(policy);

  // Resolves once the watcher has finished admitting every `watched` batch:
  // the generator resumes only when the runtime pulls the next one.
  let drained!: () => void;
  const watchDrained = new Promise<void>((resolve) => {
    drained = resolve;
  });
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
    ...(watched
      ? {
          async *watch(_config, context) {
            yield* watched();
            drained();
            await new Promise<void>((resolve) => {
              context.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          },
        }
      : {}),
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
    edit,
    tick: () => current.runtime.tick(monitors, root),
    async watch(onError?: (monitorId: string, error: Error) => void) {
      const errors: { monitorId: string; message: string }[] = [];
      const handle = await current.runtime.watchMonitors(monitors, root, {
        onError: (monitorId, error) => {
          errors.push({ monitorId, message: error.message });
          onError?.(monitorId, error);
        },
      });
      await watchDrained;
      await handle.stop();
      return errors;
    },
    history: () =>
      current.store
        .listObservationHistory({ monitorId: 'held', workspacePath: root })
        .reverse()
        .map((row) => [row.result, row.observationData]),
    restart() {
      current.client.close();
      current = open();
    },
    state: () => current.store.getMonitorState('held', root),
    /** Test-only native SQL, used to install and clear storage faults. */
    exec: (sql: string) => current.client.exec(sql),
    loss: () =>
      current.store.outstandingUnretainedObservationLoss('held', root),
    heldTitles() {
      const notify = current.store.getMonitorState('held', root).notifyState;
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
    errored: () =>
      current.store
        .listObservationHistory({ monitorId: 'held', workspacePath: root })
        .filter((row) => row.result === 'errored'),
    advance(ms: number) {
      vi.setSystemTime(new Date(Date.now() + ms));
    },
    at(iso: string) {
      vi.setSystemTime(new Date(iso));
    },
  };
}

const observation = (title: string, payload?: Record<string, unknown>) => ({
  title,
  snapshotText: title,
  objectKey: title,
  ...(payload ? { payload } : {}),
});

/**
 * A refusal's loss row (002 §2, §4.7): the outcome text, the marker and the
 * lost observation's identity. `observation()` keys every observation by its
 * title, and every refused observation here is titled "Bad".
 */
const refusalRow = (error: unknown) => ({
  error,
  holdRefused: true,
  objectKey: 'Bad',
  title: 'Bad',
});

/** The documented outcome text: names the observation, the hold, and why. */
const notHeldMessage = (strategy: HeldStrategy, reason: RegExp) =>
  expect.stringMatching(
    new RegExp(
      `^Observation "Bad" was not held for ${strategy}: it cannot be serialized \\(.*${reason.source}.*\\)\\.$`,
      'iu',
    ),
  );

for (const strategy of ['debounce', 'rollup'] as const) {
  for (const kind of ['bigint', 'cycle'] as const satisfies PayloadKind[]) {
    for (const restart of [false, true]) {
      it(`${strategy} rejects a ${kind} payload at hold acceptance; siblings and later observations materialize (restart=${restart})`, async () => {
        const { payload, reason } = unserializable[kind];
        const f = fixture(policies[strategy], [
          () => [observation('Bad', payload()), observation('A')],
          () => [observation('B')],
        ]);

        const first = await f.tick();
        // The offending observation is reported on the tick result, naming
        // the monitor and the reason (issue #570).
        expect(first.erroredObservations).toEqual([
          { monitorId: 'held', message: notHeldMessage(strategy, reason) },
        ]);
        // Its batch sibling is held; the rejected observation is not.
        expect(f.heldTitles()).toEqual(['A']);
        // The source baseline advanced: the batch is not observed again.
        expect(f.state().sourceState).toEqual({ cursor: 1 });
        // History carries one durable `errored` loss row with the same
        // message, naming the lost observation (#575).
        expect(f.errored().map((row) => row.observationData)).toEqual([
          refusalRow(first.erroredObservations[0]?.message),
        ]);

        if (restart) f.restart();

        f.advance(2_000);
        const second = await f.tick();
        expect(second.erroredObservations).toEqual([]);
        expect(f.heldTitles()).toEqual(['A', 'B']);

        if (strategy === 'debounce') f.advance(30_000);
        else f.at('2026-03-20T09:00:00Z');
        const flush = await f.tick();
        expect(flush.erroredObservations).toEqual([]);
        expect(flush.emittedEventIds).toHaveLength(2);
        expect(f.eventSummaries()).toEqual(['A', 'B']);
        expect(f.heldTitles()).toEqual([]);
        // The rejection is reported once, never re-observed.
        expect(f.errored()).toHaveLength(1);
      });
    }
  }
}

it('a batch whose only observation is unserializable records just its errored outcome and does not wedge the monitor', async () => {
  const f = fixture(policies.debounce, [
    () => [observation('Bad', { count: 1n })],
    () => [observation('A')],
  ]);

  const first = await f.tick();
  expect(first.erroredObservations).toHaveLength(1);
  expect(f.heldTitles()).toEqual([]);
  expect(f.state().notifyState.pendingDebounce).toBeUndefined();
  expect(f.state().sourceState).toEqual({ cursor: 1 });
  expect(f.errored()).toHaveLength(1);

  f.advance(2_000);
  await f.tick();
  expect(f.heldTitles()).toEqual(['A']);
  f.advance(30_000);
  await f.tick();
  expect(f.eventSummaries()).toEqual(['A']);
});

it('serializable siblings on either side of a rejected observation keep their order in the hold', async () => {
  const f = fixture(policies.rollup, [
    () => [
      observation('A'),
      observation('Bad', unserializable.cycle.payload()),
      observation('B'),
    ],
  ]);

  const first = await f.tick();
  expect(first.erroredObservations).toEqual([
    {
      monitorId: 'held',
      message: notHeldMessage('rollup', unserializable.cycle.reason),
    },
  ]);
  expect(f.heldTitles()).toEqual(['A', 'B']);
  f.at('2026-03-20T09:00:00Z');
  await f.tick();
  expect(f.eventSummaries()).toEqual(['A', 'B']);
});

it('an effective notify edit after a rejection drains the accepted hold and admits later observations', async () => {
  const f = fixture(policies.debounce, [
    () => [observation('Bad', { count: 1n }), observation('A')],
    () => [observation('B')],
  ]);

  await f.tick();
  expect(f.heldTitles()).toEqual(['A']);

  // An effective pacing edit drains captured holds (002 §4.6). The rejected
  // observation never entered the hold, so the drain and the admission gate
  // that guards it see only serializable work.
  f.edit(policies.immediate);
  f.advance(2_000);
  const result = await f.tick();
  expect(result.erroredObservations).toEqual([]);
  expect(f.eventSummaries()).toEqual(['A', 'B']);
  expect(f.state().notifyState.pendingDebounce).toBeUndefined();
});

it('the watch path rejects an unserializable observation at hold acceptance, reports it through onError, and holds the next one', async () => {
  // One finite batch (002 §2.4): the refusal and its held sibling are decided
  // in the same admission transaction that advances the watch baseline.
  const f = fixture(policies.debounce, [], () => [
    {
      observations: [observation('Bad', { count: 1n }), observation('A')],
      nextState: { cursor: 1 },
    },
  ]);

  const errors = await f.watch();
  expect(errors).toEqual([
    {
      monitorId: 'held',
      message: notHeldMessage('debounce', unserializable.bigint.reason),
    },
  ]);
  expect(f.heldTitles()).toEqual(['A']);
  expect(f.state().sourceState).toEqual({ cursor: 1 });
  expect(f.errored().map((row) => row.observationData)).toEqual([
    refusalRow(errors[0]?.message),
  ]);
});

it('history gives a rejected observation its own errored row and counts it out of the batch row', async () => {
  const f = fixture(policies.debounce, [
    () => [observation('Bad', { count: 1n })],
    () => [observation('A'), observation('Bad', { count: 2n })],
  ]);

  await f.tick();
  f.advance(2_000);
  await f.tick();

  const message = notHeldMessage('debounce', unserializable.bigint.reason);
  expect(f.history()).toEqual([
    // A span made only of a refused observation has no batch row: nothing
    // was held or emitted, so `suppressed` and `no-change` would both be false.
    ['errored', refusalRow(message)],
    // A mixed span keeps its `suppressed` row for the held sibling and says
    // how many of its observations were refused.
    ['errored', refusalRow(message)],
    ['suppressed', { observed: 2, emitted: 0, notHeld: 1 }],
  ]);
});

it('JSON-encodable payloads are still held: undefined members and Dates are not rejected', async () => {
  const f = fixture(policies.rollup, [
    () => [
      observation('A', {
        optional: undefined,
        when: new Date('2026-03-20T07:00:00Z'),
        nested: { list: [1, 'two', null] },
      }),
    ],
  ]);

  const first = await f.tick();
  expect(first.erroredObservations).toEqual([]);
  expect(f.heldTitles()).toEqual(['A']);
  expect(f.errored()).toEqual([]);
});

it('a throwing watcher onError cannot lose a debounce batch flushed in the same dispatch as a refusal (#570 review F1)', async () => {
  // A is held; 60s later a dispatch flushes it (due) and refuses Bad. The
  // report callback throws, as a caller's logger can. The flushed batch and
  // the refusal row are committed work and must survive that.
  const f = fixture(policies.debounce, [], function* () {
    yield { observations: [observation('A')], nextState: { cursor: 1 } };
    f.advance(60_000);
    yield {
      observations: [observation('Bad', { count: 1n })],
      nextState: { cursor: 2 },
    };
  });
  await f.watch(() => {
    throw new Error('logger down');
  });

  expect(f.eventSummaries()).toEqual(['A']);
  expect(f.state().notifyState.pendingDebounce).toBeUndefined();
  expect(f.state().sourceState).toEqual({ cursor: 2 });
  expect(
    f.errored().map((row) => (row.observationData as { error: string }).error),
  ).toEqual([
    expect.stringMatching(/^Observation "Bad" was not held for debounce:/u),
  ]);
});

it('a rejected observation sanitizes its title to one terminal-safe line (#570 review F3)', async () => {
  const f = fixture(policies.debounce, [
    () => [observation('\u001b[31mRED\u001b[0m\nline2\u0007', { n: 1n })],
  ]);
  const result = await f.tick();
  const message = result.erroredObservations[0]?.message ?? '';
  expect(message).toMatch(
    /^Observation "RED line2" was not held for debounce: it cannot be serialized \(/u,
  );
  // eslint-disable-next-line no-control-regex -- asserting no control bytes survive
  expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
});

it('a refusal does not reset the hold dueAt (#570 review F3, 002 §4.3/§4.7)', async () => {
  const f = fixture(policies.debounce, [
    () => [observation('A')],
    () => [observation('Bad', { n: 1n })],
  ]);
  await f.tick();
  const dueAt = f.state().notifyState.pendingDebounce?.dueAt;
  expect(dueAt).toBeDefined();
  f.advance(5_000);
  await f.tick();
  expect(f.errored()).toHaveLength(1);
  expect(f.state().notifyState.pendingDebounce?.dueAt).toBe(dueAt);
});

it('a long title is capped so the reason survives the 512-code-point display cap (#570 review F4)', async () => {
  const f = fixture(policies.debounce, [
    () => [observation('é'.repeat(600), { n: 1n })],
  ]);
  const result = await f.tick();
  const message = result.erroredObservations[0]?.message ?? '';
  expect(Array.from(message).length).toBeLessThanOrEqual(512);
  expect(message).toMatch(/it cannot be serialized \(.*BigInt.*\)\.$/u);
  expect(message).toContain('...');
});

it('a toJSON that throws a value whose toString throws still yields a refusal with a fixed reason and does not wedge (#570 review F5b)', async () => {
  const evil = {
    toString(): string {
      throw new Error('no string');
    },
  };
  const f = fixture(policies.debounce, [
    () => [
      observation('Evil', {
        x: {
          toJSON() {
            throw evil;
          },
        },
      }),
      observation('A'),
    ],
    () => [observation('B')],
  ]);
  const first = await f.tick();
  expect(first.erroredObservations).toEqual([
    {
      monitorId: 'held',
      message:
        'Observation "Evil" was not held for debounce: it cannot be serialized (unknown serialization error).',
    },
  ]);
  expect(f.heldTitles()).toEqual(['A']);
  expect(f.state().sourceState).toEqual({ cursor: 1 });
  f.advance(2_000);
  await f.tick();
  expect(f.heldTitles()).toEqual(['A', 'B']);
});

/**
 * 002 §2 and §4.7: one span can hold, refuse and drop. A debounce monitor with
 * an escalation band holds A, refuses Bad, then an escalated K flushes the
 * batch (§4.1); K's BigInt payload can neither persist as an event nor be
 * retained for retry, so span admission drops it. Each outcome is counted once
 * in the batch row, and both the refusal and the drop are outstanding loss
 * (#575).
 */
it('a span mixing a refusal, an admitted observation and an unretainable drop counts each once, and both losses are outstanding (#570, #497, #575)', async () => {
  const f = fixture(
    policies.debounce,
    [
      () => [
        observation('A'),
        observation('Bad', { count: 1n }),
        { ...observation('K', { count: 2n }), salience: 'high' as const },
      ],
    ],
    undefined,
    'normal..high',
  );

  const result = await f.tick();
  const refusal = notHeldMessage('debounce', unserializable.bigint.reason);
  expect(result.erroredObservations).toEqual([
    { monitorId: 'held', message: refusal },
    {
      monitorId: 'held',
      message: expect.stringContaining('Not retained for retry'),
    },
  ]);
  expect(f.eventSummaries()).toEqual(['A']);
  expect(f.heldTitles()).toEqual([]);
  expect(f.state().sourceState).toEqual({ cursor: 1 });
  expect(f.history()).toEqual([
    // Refusal first: it arrived before K, whose escalation emitted [A, K].
    ['errored', refusalRow(refusal)],
    [
      'errored',
      expect.objectContaining({
        notRetained: true,
        objectKey: 'K',
        title: 'K',
      }),
    ],
    ['triggered', { observed: 3, emitted: 1, notRetainedCount: 1, notHeld: 1 }],
  ]);
  // Both are loss; K is the newest.
  expect(f.loss()).toMatchObject({ count: 2, objectKey: 'K' });

  // Nothing is re-observed; the monitor keeps accepting work.
  f.advance(2_000);
  const next = await f.tick();
  expect(next.erroredObservations).toEqual([]);
  expect(f.errored()).toHaveLength(2);
});

/**
 * 002 §4.7 step 3: the refusal row commits in the span's admission
 * transaction. When a storage fault rolls that transaction back, the refusal
 * is neither recorded nor reported, the baseline stays, and the batch is
 * refused exactly once when it is observed again.
 */
it('a span whose admission rolls back records and reports no refusal, and the retry refuses once (#570, #497)', async () => {
  const f = fixture(policies.debounce, [
    () => [observation('A')],
    () => [observation('Bad', { count: 1n }), observation('B')],
    () => [],
  ]);
  await f.tick();
  expect(f.heldTitles()).toEqual(['A']);

  // Fail only the span's own state write, not identity bookkeeping.
  f.exec(
    "CREATE TRIGGER state_fault BEFORE UPDATE ON monitor_state WHEN NEW.last_observation_at IS NOT OLD.last_observation_at BEGIN SELECT RAISE(ABORT, 'state fault'); END",
  );
  f.advance(2_000);
  const failed = await f.tick();
  expect(failed.erroredObservations).toEqual([
    { monitorId: 'held', message: expect.stringContaining('state fault') },
  ]);
  expect(
    f
      .errored()
      .filter((row) =>
        JSON.stringify(row.observationData).includes('not held'),
      ),
  ).toEqual([]);
  expect(f.state().sourceState).toEqual({ cursor: 1 });
  expect(f.heldTitles()).toEqual(['A']);

  f.exec('DROP TRIGGER state_fault');
  f.advance(2_000);
  const retried = await f.tick();
  expect(retried.erroredObservations).toEqual([
    {
      monitorId: 'held',
      message: notHeldMessage('debounce', unserializable.bigint.reason),
    },
  ]);
  expect(
    f
      .errored()
      .filter((row) =>
        JSON.stringify(row.observationData).includes('not held'),
      ),
  ).toHaveLength(1);
  expect(f.state().sourceState).toEqual({ cursor: 2 });
  expect(f.heldTitles()).toEqual(['A', 'B']);
});

/**
 * 002 §4.7 step 3: the refusal row is the observation's durable outcome, not
 * a best-effort audit. If it cannot be written, the whole span rolls back with
 * it: the sibling is not held, the baseline stays, and nothing is reported as
 * refused. Once the fault clears, the batch is refused exactly once.
 */
it('a refusal row that cannot be written rolls back its span instead of advancing past an unrecorded refusal (#570, #497)', async () => {
  const f = fixture(policies.debounce, [
    () => [observation('Bad', { count: 1n }), observation('A')],
    () => [],
  ]);
  f.exec(
    "CREATE TRIGGER refusal_fault BEFORE INSERT ON observation_history WHEN NEW.observation_data LIKE '%was not held%' BEGIN SELECT RAISE(ABORT, 'history fault'); END",
  );
  const failed = await f.tick();
  expect(failed.erroredObservations).toEqual([
    { monitorId: 'held', message: expect.stringContaining('history fault') },
  ]);
  expect(f.heldTitles()).toEqual([]);
  expect(f.state().sourceState).toBeUndefined();

  f.exec('DROP TRIGGER refusal_fault');
  f.advance(2_000);
  const retried = await f.tick();
  expect(retried.erroredObservations).toEqual([
    {
      monitorId: 'held',
      message: notHeldMessage('debounce', unserializable.bigint.reason),
    },
  ]);
  expect(f.heldTitles()).toEqual(['A']);
  expect(f.state().sourceState).toEqual({ cursor: 1 });
});

/**
 * 002 §4.7: the hold-acceptance check covers an observation joining a held
 * batch, not one arriving on the tick the rollup window fires. That
 * observation goes straight to materialization, where 002 §2 drops it (it is
 * not retainable in the outbox) and records `notRetainedCount` on the batch
 * row. So it is a drop, not a refusal: no `notHeld` count, no "was not held"
 * row, and the unretained loss stays visible to doctor and explain.
 */
it('an unretainable observation arriving on a rollup firing tick is dropped at materialization, never refused by the hold check (002 §4.7, §2)', async () => {
  const f = fixture(policies.rollup, [
    () => [observation('A')],
    () => [observation('Bad', { count: 10n }), observation('C')],
  ]);

  await f.tick();
  expect(f.heldTitles()).toEqual(['A']);

  f.at('2026-03-20T09:00:00Z');
  const fired = await f.tick();

  // The held batch and the retainable arrival are emitted, in order; the
  // window is flushed.
  expect(f.eventSummaries()).toEqual(['A', 'C']);
  expect(fired.emittedEventIds).toHaveLength(2);
  expect(f.state().notifyState.pendingRollup).toBeUndefined();

  // The hold check did not run: the only report is the materialization drop,
  // and no refusal is reported or recorded.
  expect(fired.erroredObservations).toEqual([
    {
      monitorId: 'held',
      message: expect.stringContaining('Not retained for retry'),
    },
  ]);
  expect(
    fired.erroredObservations.filter((e) => e.message.includes('was not held')),
  ).toEqual([]);
  const refusals = f
    .errored()
    .filter((row) => JSON.stringify(row.observationData).includes('not held'));
  expect(refusals).toEqual([]);

  // Materialization dropped Bad: one durable drop row, and the batch row
  // counts it as not retained rather than not held.
  const drops = f
    .errored()
    .filter(
      (row) =>
        (row.observationData as { notRetained?: boolean }).notRetained === true,
    );
  expect(drops.map((row) => row.observationData)).toEqual([
    expect.objectContaining({ objectKey: 'Bad', notRetained: true }),
  ]);
  const batchRow = f.history().at(-1);
  expect(batchRow).toEqual([
    'triggered',
    { observed: 2, emitted: 2, notRetainedCount: 1 },
  ]);
  expect(batchRow?.[1]).not.toHaveProperty('notHeld');

  // The loss stays outstanding for doctor and explain.
  expect(f.loss()).toMatchObject({ count: 1, objectKey: 'Bad' });
});
