/**
 * Admission when the retry outbox cannot take a failed observation's ordered
 * suffix: over capacity, or outside the outbox's plain-data domain.
 *
 * Every observation in a span must reach exactly one durable outcome, committed
 * with the source/notify state: an event, a queued retry, or an `errored`
 * observation-history row naming why it was not retained. The source baseline
 * advances once every observation has an outcome, so a failure that would
 * recur on replay can never stop the monitor. The cases run through real
 * ticks, real watch batches and real rollup window flushes, with native SQLite
 * `RAISE(ABORT)` / `RAISE(ROLLBACK)` triggers and real non-serializable
 * payloads rather than mocked store methods.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2 (admission outcomes)
 * @see ../../../../docs/specs/002-runtime-delivery.md `materialization_retry_outbox` (256 rows / 8 MiB, plain-data domain)
 * @see ../../../../docs/specs/002-runtime-delivery.md `observation_history` (`errored` sub-cases)
 * @see ../../../../docs/specs/004-validation-testing.md (admission scenarios)
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import { MATERIALIZATION_RETRY_MAX_RECORDS } from './types.js';

const sql = String.raw;

/** 12:00:00 UTC: a rollup window of `1 * * * *` opens one minute later. */
const NOW = new Date('2026-11-01T12:00:00.000Z');
const MONITOR_ID = 'suffix';

/** Only this suite's SQLite clients and directories are cleaned up. */
const resources: { root: string; clients: BetterSQLiteClient[] }[] = [];

/** Preserve native Date instances: retry envelopes reject subclass/augmented timestamps. */
let clockTime = NOW.getTime();
beforeEach(() => {
  clockTime = NOW.getTime();
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
  for (const resource of resources.splice(0)) {
    for (const client of resource.clients) if (client.open) client.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

/** `b<batch>-<index>`: names one observation of one source batch. */
function label(batch: number, index: number): string {
  return `b${String(batch)}-${String(index)}`;
}

/** A batch of distinct objects, so each observation is its own event and snapshot. */
function observations(
  batch: number,
  count: number,
  payloads: Record<number, unknown> = {},
): Observation[] {
  return Array.from({ length: count }, (_, index) => ({
    title: label(batch, index),
    summary: label(batch, index),
    objectKey: `object-${String(index)}`,
    snapshotText: `content-${label(batch, index)}`,
    ...(index in payloads ? { payload: payloads[index] } : {}),
  }));
}

/** Every label the source emitted in one batch, in order. */
function labels(batch: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => label(batch, index));
}

type Mode = 'poll' | 'rollup' | 'watch';

/**
 * One monitor whose poll source returns `plan(cursor)` and advances the cursor
 * by one per batch. Two lead sessions receive every event.
 */
function fixture(
  mode: Mode,
  plan: (cursor: number) => Observation[],
  watch?: ObservationSource['watch'],
) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-unretainable-'));
  const owned = { root, clients: [] as BetterSQLiteClient[] };
  resources.push(owned);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(path.join(monitorsDir, MONITOR_ID), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, MONITOR_ID, 'MONITOR.md'),
    `---
name: Suffix
watch:
  type: suffix-source
  interval: ${mode === 'rollup' ? '1h' : '1s'}
urgency: normal
baseline-strategy: incremental
${mode === 'rollup' ? 'notify:\n  strategy: rollup\n  window: "1 * * * *"\n  timezone: UTC\n' : ''}---
Inspect the changes.
`,
  );
  const source: ObservationSource = {
    name: 'suffix-source',
    scopeSchema: { type: 'object' },
    stateful: true,
    observe(_config, context) {
      const cursor =
        (context.previousState as { cursor?: number } | undefined)?.cursor ?? 0;
      return Promise.resolve({
        observations: plan(cursor),
        nextState: { cursor: cursor + 1 },
      });
    },
    ...(watch ? { watch } : {}),
  };
  const dbPath = path.join(root, 'runtime.db');
  const connect = () => {
    const db = createDb(dbPath);
    // InboxDb intentionally hides its SQLite client; tests use it only to
    // install native faults and for independent durable-row assertions.
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    owned.clients.push(client);
    return { db, client };
  };
  const writer = connect();
  const store = new RuntimeStore(writer.db);
  const registry = new SourceRegistry();
  registry.register(source);
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  for (const hostSessionId of ['lead-a', 'lead-b']) {
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId,
        workspacePath: root,
      }),
    );
  }
  // An independent connection sees only committed rows.
  const observer = connect();
  const reader = new RuntimeStore(observer.db);
  return { root, monitorsDir, writer, observer, reader, runtime };
}

type Fixture = ReturnType<typeof fixture>;

/** Native savepoint-local fault: the owning transaction stays alive (002 §2). */
function abortOn(f: Fixture, summary: string): void {
  f.writer.client.exec(sql`
    CREATE TRIGGER fault_${summary.replace('-', '_')} BEFORE INSERT ON monitor_events
    WHEN NEW.summary = '${summary}'
    BEGIN SELECT RAISE(ABORT, 'native fault on ${summary}'); END;
  `);
}

function erroredRows(f: Fixture): string[] {
  return f.reader
    .listObservationHistory({
      monitorId: MONITOR_ID,
      workspacePath: f.root,
      limit: 10_000,
    })
    .filter(({ result }) => result === 'errored')
    .map(({ observationData }) => String(observationData['error']));
}

/**
 * The three-outcome invariant for one span. `emitted` is every observation the
 * span dispatched; `retained` is the expected ordered outbox content and
 * `errored` the expected unretained observations. Everything else must be an
 * event, projected to both lead sessions, with no observation in two places.
 */
function expectOutcomes(
  f: Fixture,
  span: {
    emitted: string[];
    retained: string[];
    errored: { label: string; reason: RegExp }[];
    priorEvents?: string[];
    priorRetained?: string[];
    priorErrored?: number;
  },
): void {
  const events = f.reader
    .listEvents({ monitorId: MONITOR_ID, workspacePath: f.root, limit: 10_000 })
    .map(({ summary }) => summary);
  const prior = new Set(span.priorEvents ?? []);
  const spanEvents = events.filter((summary) => !prior.has(summary));
  const retained = f.reader
    .listMaterializationRetries({
      monitorId: MONITOR_ID,
      workspacePath: f.root,
    })
    .map(({ envelope }) => envelope.observation.summary)
    .slice((span.priorRetained ?? []).length);
  const erroredLabels = span.errored.map(({ label: name }) => name);
  const expectedEvents = span.emitted.filter(
    (name) => !span.retained.includes(name) && !erroredLabels.includes(name),
  );

  expect([...spanEvents].sort()).toEqual([...expectedEvents].sort());
  expect(retained).toEqual(span.retained);
  // Each emitted observation has exactly one outcome.
  for (const name of span.emitted) {
    const places = [
      spanEvents.includes(name),
      retained.includes(name),
      erroredLabels.includes(name),
    ].filter(Boolean);
    expect(places, name).toHaveLength(1);
  }
  // Unretained outcomes are distinct from the audit row a retained suffix's
  // first failure also receives (002 observation_history, savepoint sub-case).
  const unretained = erroredRows(f).filter((row) =>
    row.includes('Not retained for retry'),
  );
  expect(unretained).toHaveLength(
    (span.priorErrored ?? 0) + span.errored.length,
  );
  const rows = unretained.slice(0, span.errored.length);
  for (const expected of span.errored) {
    expect(
      rows.some((row) => expected.reason.test(row)),
      `${expected.label}: ${rows.join(' | ')}`,
    ).toBe(true);
  }
  // Every event reaches both lead sessions.
  expect(
    f.observer.client
      .prepare('SELECT count(*) AS n FROM session_event_state')
      .get(),
  ).toEqual({ n: events.length * 2 });
}

const CAPACITY = /retry outbox capacity is exhausted/;
const DOMAIN = /not serializable for the retry outbox/;

/** Advance past the 1s poll interval so the next tick observes again. */
async function nextPoll(f: Fixture) {
  clockTime += 2_000;
  return f.runtime.tick(f.monitorsDir, f.root);
}

describe('poll admission when the outbox cannot take the suffix', () => {
  it('records the failed observation errored, materializes the rest and advances when its suffix exceeds outbox capacity', async () => {
    // 600 observations with a fault at index 299 leave a 301-record suffix,
    // larger than the 256-record outbox (002 materialization_retry_outbox).
    const f = fixture('poll', (cursor) =>
      cursor === 0 ? observations(0, 600) : observations(cursor, 3),
    );
    abortOn(f, 'b0-299');

    const first = await f.runtime.tick(f.monitorsDir, f.root);

    expectOutcomes(f, {
      emitted: labels(0, 600),
      retained: [],
      errored: [{ label: 'b0-299', reason: CAPACITY }],
    });
    expect(first.emittedEventIds).toHaveLength(599);
    expect(first.erroredObservations).toEqual([
      { monitorId: MONITOR_ID, message: expect.stringMatching(CAPACITY) },
    ]);
    expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toEqual({
      cursor: 1,
    });
    // Diagnostics read the same durable row.
    const explained = await f.runtime.explainMonitor({
      monitorsDir: f.monitorsDir,
      monitorId: MONITOR_ID,
      workspacePath: f.root,
    });
    expect(
      explained.observations.some(
        ({ result, observationData }) =>
          result === 'errored' &&
          CAPACITY.test(String(observationData['error'])),
      ),
    ).toBe(true);

    // The next tick makes progress from the advanced baseline.
    const second = await nextPoll(f);
    expect(second.emittedEventIds).toHaveLength(3);
    expect(second.erroredObservations).toEqual([]);
    expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toEqual({
      cursor: 2,
    });
  });

  // An outbox filled by earlier partial failures: 251 rows from the first tick,
  // so 5 records remain. A 5-record suffix fits exactly; a 6-record one does not.
  for (const [faultIndex, fits] of [
    [5, true],
    [4, false],
  ] as const) {
    it(`retains a suffix that fits the remaining capacity and errors one that does not (fault at index ${String(faultIndex)})`, async () => {
      const f = fixture('poll', (cursor) =>
        cursor === 0
          ? observations(0, 260)
          : cursor === 1
            ? observations(1, 10)
            : cursor === 2
              ? observations(2, 3)
              : observations(cursor, 2),
      );
      abortOn(f, 'b0-9');
      abortOn(f, label(1, faultIndex));
      abortOn(f, 'b2-1');

      await f.runtime.tick(f.monitorsDir, f.root);
      const firstRetained = labels(0, 260).slice(9);
      expectOutcomes(f, {
        emitted: labels(0, 260),
        retained: firstRetained,
        errored: [],
      });
      expect(firstRetained).toHaveLength(251);
      const priorEvents = labels(0, 9);

      await nextPoll(f);
      const secondRetained = fits ? labels(1, 10).slice(faultIndex) : [];
      expectOutcomes(f, {
        emitted: labels(1, 10),
        retained: secondRetained,
        errored: fits
          ? []
          : [{ label: label(1, faultIndex), reason: CAPACITY }],
        priorEvents,
        priorRetained: firstRetained,
      });
      const retainedTotal = firstRetained.length + secondRetained.length;
      expect(retainedTotal).toBe(
        fits ? MATERIALIZATION_RETRY_MAX_RECORDS : 251,
      );

      // Terminal and pending rows both hold capacity; with the outbox full,
      // a later single failure cannot be retained but must not stall the span.
      if (fits) {
        const third = await nextPoll(f);
        expectOutcomes(f, {
          emitted: labels(2, 3),
          retained: [],
          errored: [{ label: 'b2-1', reason: CAPACITY }],
          priorEvents: [...priorEvents, ...labels(1, faultIndex)],
          priorRetained: [...firstRetained, ...secondRetained],
        });
        expect(third.emittedEventIds).toHaveLength(2);
        expect(
          f.reader.getMonitorState(MONITOR_ID, f.root).sourceState,
        ).toEqual({ cursor: 3 });
        const fourth = await nextPoll(f);
        expect(fourth.emittedEventIds).toHaveLength(2);
        expect(
          f.reader.getMonitorState(MONITOR_ID, f.root).sourceState,
        ).toEqual({ cursor: 4 });
      }
    });
  }

  it('records a non-serializable observation errored and materializes its siblings (BigInt payload)', async () => {
    // A BigInt fails event persistence and is outside the retry domain.
    const f = fixture('poll', (cursor) =>
      cursor === 0
        ? observations(0, 10, { 4: { n: 1n } })
        : observations(cursor, 3),
    );

    const first = await f.runtime.tick(f.monitorsDir, f.root);

    expectOutcomes(f, {
      emitted: labels(0, 10),
      retained: [],
      errored: [{ label: 'b0-4', reason: DOMAIN }],
    });
    expect(first.emittedEventIds).toHaveLength(9);
    expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toEqual({
      cursor: 1,
    });
    const second = await nextPoll(f);
    expect(second.emittedEventIds).toHaveLength(3);
  });

  it('records a failure errored when a later sibling of its suffix is not serializable, and still materializes that sibling', async () => {
    // A nested Date persists as an event but is outside the retry domain, so
    // the suffix starting at the fault cannot be retained as a whole.
    const f = fixture('poll', (cursor) =>
      cursor === 0
        ? observations(0, 10, {
            6: { at: new Date('2026-11-01T11:00:00.000Z') },
          })
        : observations(cursor, 3),
    );
    abortOn(f, 'b0-2');

    const first = await f.runtime.tick(f.monitorsDir, f.root);

    expectOutcomes(f, {
      emitted: labels(0, 10),
      retained: [],
      errored: [
        { label: 'b0-2', reason: /later observation in its ordered suffix/ },
      ],
    });
    expect(first.emittedEventIds).toHaveLength(9);
    expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toEqual({
      cursor: 1,
    });
    expect((await nextPoll(f)).emittedEventIds).toHaveLength(3);
  });
});

describe('rollup window flush on the not-due path', () => {
  /** Hold the first batch at 12:00 (window closed), then open the window at 12:01. */
  async function holdThenFlush(f: Fixture) {
    const held = await f.runtime.tick(f.monitorsDir, f.root);
    expect(held.emittedEventIds).toEqual([]);
    expect(
      f.reader.getMonitorState(MONITOR_ID, f.root).notifyState.pendingRollup
        ?.observations.length,
    ).toBeGreaterThan(0);
    clockTime = NOW.getTime() + 60_000;
    return f.runtime.tick(f.monitorsDir, f.root);
  }

  it('flushes a held window whose suffix exceeds capacity into events plus one errored row, clearing the hold', async () => {
    const f = fixture('rollup', (cursor) =>
      cursor === 0 ? observations(0, 600) : observations(cursor, 3),
    );
    abortOn(f, 'b0-299');

    const flushed = await holdThenFlush(f);

    expect(flushed.skippedMonitors.map(({ monitorId }) => monitorId)).toEqual([
      MONITOR_ID,
    ]);
    expectOutcomes(f, {
      emitted: labels(0, 600),
      retained: [],
      errored: [{ label: 'b0-299', reason: CAPACITY }],
    });
    expect(flushed.emittedEventIds).toHaveLength(599);
    expect(flushed.erroredObservations).toEqual([
      { monitorId: MONITOR_ID, message: expect.stringMatching(CAPACITY) },
    ]);
    expect(
      f.reader.getMonitorState(MONITOR_ID, f.root).notifyState.pendingRollup,
    ).toBeUndefined();
    const results = f.reader
      .listObservationHistory({ monitorId: MONITOR_ID, workspacePath: f.root })
      .map(({ result }) => result)
      .sort();
    expect(results).toEqual(['errored', 'suppressed', 'triggered']);

    // The next hour observes and holds a new batch; its window flushes it.
    clockTime = NOW.getTime() + 60 * 60_000;
    await f.runtime.tick(f.monitorsDir, f.root);
    clockTime = NOW.getTime() + 61 * 60_000;
    const next = await f.runtime.tick(f.monitorsDir, f.root);
    expect(next.emittedEventIds).toHaveLength(3);
  });

  it('retains a suffix that fits and clears the hold in the same commit', async () => {
    const f = fixture('rollup', () => observations(0, 10));
    abortOn(f, 'b0-4');

    const flushed = await holdThenFlush(f);

    expectOutcomes(f, {
      emitted: labels(0, 10),
      retained: labels(0, 10).slice(4),
      errored: [],
    });
    expect(flushed.emittedEventIds).toHaveLength(4);
    expect(
      f.reader.getMonitorState(MONITOR_ID, f.root).notifyState.pendingRollup,
    ).toBeUndefined();
  });

  it('keeps the whole window held and reports the failure when the flush transaction rolls back', async () => {
    const f = fixture('rollup', () => observations(0, 3));
    f.writer.client.exec(sql`
      CREATE TRIGGER rollback_flush BEFORE INSERT ON monitor_events
      WHEN NEW.summary = 'b0-1'
      BEGIN SELECT RAISE(ROLLBACK, 'whole flush rollback'); END;
    `);

    const failed = await holdThenFlush(f);

    expect(failed.emittedEventIds).toEqual([]);
    expect(failed.erroredObservations).toEqual([
      { monitorId: MONITOR_ID, message: 'whole flush rollback' },
    ]);
    expect(f.reader.listEvents({ monitorId: MONITOR_ID })).toEqual([]);
    expect(f.reader.listMaterializationRetries()).toEqual([]);
    expect(
      f.reader
        .getMonitorState(MONITOR_ID, f.root)
        .notifyState.pendingRollup?.observations.map(
          ({ observation }) => observation.summary,
        ),
    ).toEqual(labels(0, 3));
    expect(erroredRows(f)).toEqual(['whole flush rollback']);

    // Still inside the open window: the retained hold flushes completely.
    f.writer.client.exec('DROP TRIGGER rollback_flush');
    clockTime += 30_000;
    const retried = await f.runtime.tick(f.monitorsDir, f.root);
    expect(retried.emittedEventIds).toHaveLength(3);
    expect(
      f.reader.getMonitorState(MONITOR_ID, f.root).notifyState.pendingRollup,
    ).toBeUndefined();
  });
});

describe('watch batch admission when the outbox cannot take the suffix', () => {
  /** Never resolves until the watcher is stopped. */
  function idle(context: ObservationContext): Promise<void> {
    return new Promise((resolve) => {
      if (context.signal?.aborted) resolve();
      else
        context.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
    });
  }

  for (const [name, first, fault, reason] of [
    ['over capacity', observations(0, 600), 'b0-299', CAPACITY],
    [
      'with a BigInt payload',
      observations(0, 10, { 4: { n: 1n } }),
      undefined,
      DOMAIN,
    ],
  ] as const) {
    it(`admits the batch ${name}, advances the checkpoint and keeps pulling`, async () => {
      let pulledSecond = false;
      const f = fixture(
        'poll',
        () => [],
        async function* (_config, context) {
          yield { observations: first, nextState: 'w1' } as ObservationResult;
          pulledSecond = true;
          yield {
            observations: observations(1, 3),
            nextState: 'w2',
          } as ObservationResult;
          await idle(context);
        },
      );
      if (fault) abortOn(f, fault);
      const errors: Error[] = [];
      const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root, {
        onError: (_id, error) => errors.push(error),
      });
      try {
        await vi.waitFor(() =>
          expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toBe(
            'w2',
          ),
        );
        expect(pulledSecond).toBe(true);
        const erroredLabel = fault ?? 'b0-4';
        expectOutcomes(f, {
          emitted: [
            ...first.map(({ summary }) => String(summary)),
            ...labels(1, 3),
          ],
          retained: [],
          errored: [{ label: erroredLabel, reason }],
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toMatch(reason);
      } finally {
        await handle.stop();
      }
    });
  }
});
