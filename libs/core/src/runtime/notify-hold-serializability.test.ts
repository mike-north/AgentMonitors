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
import type { Observation, ObservationSource } from '../observation/types.js';
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
  watched?: () => Observation[],
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
      `---\nname: Held\nwatch:\n  type: cursor-source\n  interval: 1s\nurgency: normal\nbaseline-strategy: incremental\n${nextPolicy}---\nInstructions\n`,
    );
  edit(policy);

  // Resolves once the watcher has finished ingesting every `watched` item: the
  // generator resumes only when the runtime pulls the next one.
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
    async watch() {
      const errors: { monitorId: string; message: string }[] = [];
      const handle = await current.runtime.watchMonitors(monitors, root, {
        onError: (monitorId, error) =>
          errors.push({ monitorId, message: error.message }),
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
        // History carries one durable `errored` row with the same message.
        expect(f.errored().map((row) => row.observationData)).toEqual([
          { error: first.erroredObservations[0]?.message },
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
  const f = fixture(policies.debounce, [], () => [
    observation('Bad', { count: 1n }),
    observation('A'),
  ]);

  const errors = await f.watch();
  expect(errors).toEqual([
    {
      monitorId: 'held',
      message: notHeldMessage('debounce', unserializable.bigint.reason),
    },
  ]);
  expect(f.heldTitles()).toEqual(['A']);
  expect(f.errored().map((row) => row.observationData)).toEqual([
    { error: errors[0]?.message },
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
    ['errored', { error: message }],
    // A mixed span keeps its `suppressed` row for the held sibling and says
    // how many of its observations were refused.
    ['errored', { error: message }],
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
