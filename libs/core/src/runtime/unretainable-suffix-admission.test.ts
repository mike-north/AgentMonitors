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

/**
 * Index of the observation whose materialization is made to fail in the
 * over-capacity spans. Near the front, so the failed observation's ordered
 * suffix is almost the whole span.
 */
const FAULT_INDEX = 1;
/**
 * The smallest span whose failed suffix (the failed observation plus every
 * later one) is one record larger than the outbox, so it can never be retained
 * (002 materialization_retry_outbox). A case costs one event per observation,
 * so deriving the span from the capacity keeps cases as small as the limit
 * allows while tracking it.
 */
const OVER_CAPACITY_SPAN = FAULT_INDEX + MATERIALIZATION_RETRY_MAX_RECORDS + 1;
/** The over-capacity span's failed observation, by summary and object key. */
const FAULT_LABEL = label(0, FAULT_INDEX);
const FAULT_KEY = `object-${String(FAULT_INDEX)}`;

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
  scopeSchema: ObservationSource['scopeSchema'] = { type: 'object' },
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
    scopeSchema,
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

/** `observationData` of every unretained drop row, newest first. */
function dropRows(f: Fixture): Record<string, unknown>[] {
  return f.reader
    .listObservationHistory({
      monitorId: MONITOR_ID,
      workspacePath: f.root,
      limit: 10_000,
    })
    .filter(
      ({ result, observationData }) =>
        result === 'errored' && observationData['notRetained'] === true,
    )
    .map(({ observationData }) => observationData);
}

/** The newest history row's outcome. */
function latestRow(f: Fixture) {
  const [row] = f.reader.listObservationHistory({
    monitorId: MONITOR_ID,
    workspacePath: f.root,
    limit: 1,
  });
  return row && { result: row.result, observationData: row.observationData };
}

async function explain(f: Fixture) {
  return f.runtime.explainMonitor({
    monitorsDir: f.monitorsDir,
    monitorId: MONITOR_ID,
    workspacePath: f.root,
  });
}

function stage(
  report: Awaited<ReturnType<typeof explain>>,
  id: 'observation' | 'materialization',
) {
  return report.stages.find((candidate) => candidate.id === id);
}

async function doctorRollup(f: Fixture) {
  const report = await f.runtime.doctorReport({
    monitorsDir: f.monitorsDir,
    workspacePath: f.root,
  });
  const [rollup] = report.monitors;
  if (!rollup) throw new Error('doctor reported no monitor');
  return rollup;
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
    const spanSize = OVER_CAPACITY_SPAN;
    const f = fixture('poll', (cursor) =>
      cursor === 0
        ? observations(0, spanSize)
        : cursor === 1
          ? // Other object keys: they must not supersede the drop.
            observations(cursor, 4).filter((_, index) => index !== FAULT_INDEX)
          : observations(cursor, 2).slice(FAULT_INDEX),
    );
    const faulted = FAULT_LABEL;
    const faultedKey = FAULT_KEY;
    abortOn(f, faulted);

    const first = await f.runtime.tick(f.monitorsDir, f.root);

    expectOutcomes(f, {
      emitted: labels(0, spanSize),
      retained: [],
      errored: [{ label: faulted, reason: CAPACITY }],
    });
    expect(first.emittedEventIds).toHaveLength(spanSize - 1);
    expect(first.erroredObservations).toEqual([
      { monitorId: MONITOR_ID, message: expect.stringMatching(CAPACITY) },
    ]);
    expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toEqual({
      cursor: 1,
    });
    // The drop row names the lost observation (002 observation_history):
    // its 1-based position in the span, objectKey and title; never the payload.
    const [drop] = dropRows(f);
    expect(drop).toEqual({
      error: expect.stringMatching(
        new RegExp(
          `^native fault on ${faulted} Not retained for retry: the retry outbox capacity is exhausted`,
        ),
      ),
      notRetained: true,
      position: FAULT_INDEX + 1,
      spanSize,
      objectKey: faultedKey,
      title: faulted,
    });
    // The span's batch row is newer than the drop row and counts the drop.
    expect(latestRow(f)).toEqual({
      result: 'triggered',
      observationData: {
        observed: spanSize,
        emitted: spanSize - 1,
        notRetainedCount: 1,
      },
    });
    // Explain and doctor surface the drop even though the newest history row
    // is that span's `triggered` row (002 §10.7; 005 doctor rollup).
    const explained = await explain(f);
    expect(explained.verdict).toEqual({
      status: 'failure',
      stage: 'materialization',
      reason: `1 observation(s) were dropped because the retry outbox could not retain them; the newest, observation ${String(FAULT_INDEX + 1)} of ${String(spanSize)} (${faultedKey}, "${faulted}"), failed: ${String(drop?.['error'])}`,
    });
    expect((await doctorRollup(f)).unretainedObservationLoss).toEqual({
      count: 1,
      recordedAt: NOW,
      error: drop?.['error'],
      position: FAULT_INDEX + 1,
      spanSize,
      objectKey: faultedKey,
      title: faulted,
    });

    // The next tick makes progress from the advanced baseline.
    const second = await nextPoll(f);
    expect(second.emittedEventIds).toHaveLength(3);
    expect(second.erroredObservations).toEqual([]);
    expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toEqual({
      cursor: 2,
    });
    // Events for other object keys do not supersede the drop (002 §2).
    expect(stage(await explain(f), 'materialization')?.status).toBe('failure');
    expect((await doctorRollup(f)).unretainedObservationLoss).toMatchObject({
      count: 1,
      objectKey: faultedKey,
    });

    // A later event for the dropped object key clears it from both diagnostics.
    const third = await nextPoll(f);
    expect(third.emittedEventIds).toHaveLength(1);
    expect(stage(await explain(f), 'materialization')?.status).toBe('ok');
    expect((await doctorRollup(f)).unretainedObservationLoss).toBeUndefined();
  });

  // A monitor with retained work drains it before taking newer input
  // (002 §2.7), so a span is only ever admitted into an empty outbox and the
  // boundary is the whole outbox, decided within one span. A fault at index 4
  // of a 260-observation span leaves a 256-record suffix, which fits exactly;
  // a fault at index 3 leaves 257, one record over.
  for (const [faultIndex, fits] of [
    [4, true],
    [3, false],
  ] as const) {
    it(`retains a suffix that exactly fills the outbox and errors one record over (fault at index ${String(faultIndex)})`, async () => {
      const spanSize = MATERIALIZATION_RETRY_MAX_RECORDS + 4;
      const f = fixture('poll', (cursor) =>
        cursor === 0 ? observations(0, spanSize) : observations(cursor, 2),
      );
      const faulted = label(0, faultIndex);
      abortOn(f, faulted);

      const first = await f.runtime.tick(f.monitorsDir, f.root);
      const retained = fits ? labels(0, spanSize).slice(faultIndex) : [];
      expectOutcomes(f, {
        emitted: labels(0, spanSize),
        retained,
        errored: fits ? [] : [{ label: faulted, reason: CAPACITY }],
      });
      expect(retained).toHaveLength(
        fits ? MATERIALIZATION_RETRY_MAX_RECORDS : 0,
      );
      expect(first.emittedEventIds).toHaveLength(
        fits ? faultIndex : spanSize - 1,
      );
      expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toEqual({
        cursor: 1,
      });

      // Once the fault clears, a retained suffix completes in its original
      // order before the next span is observed; a drop leaves nothing to drain.
      f.writer.client.exec(`DROP TRIGGER fault_${faulted.replace('-', '_')}`);
      const second = await nextPoll(f);
      expect(second.erroredObservations).toEqual([]);
      expect(second.emittedEventIds).toHaveLength(retained.length + 2);
      expect(f.reader.listMaterializationRetries()).toEqual([]);
      expect(
        f.writer.client
          .prepare<[], { summary: string }>(
            'SELECT summary FROM monitor_events ORDER BY sequence',
          )
          .all()
          .map(({ summary }) => summary)
          .slice(-(retained.length + 2)),
      ).toEqual([...retained, ...labels(1, 2)]);
      expect(f.reader.getMonitorState(MONITOR_ID, f.root).sourceState).toEqual({
        cursor: 2,
      });
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
      cursor === 0
        ? observations(0, OVER_CAPACITY_SPAN)
        : observations(cursor, 3),
    );
    abortOn(f, FAULT_LABEL);

    const flushed = await holdThenFlush(f);

    expect(flushed.skippedMonitors.map(({ monitorId }) => monitorId)).toEqual([
      MONITOR_ID,
    ]);
    expectOutcomes(f, {
      emitted: labels(0, OVER_CAPACITY_SPAN),
      retained: [],
      errored: [{ label: FAULT_LABEL, reason: CAPACITY }],
    });
    expect(flushed.emittedEventIds).toHaveLength(OVER_CAPACITY_SPAN - 1);
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
    [
      'over capacity',
      observations(0, OVER_CAPACITY_SPAN),
      FAULT_LABEL,
      CAPACITY,
    ],
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

/** Records in the suffix of the retained case: far below capacity, so it fits. */
const RETAINED_SUFFIX = 10;

describe('a dropped observation stays visible in explain and doctor', () => {
  // A drop must never be less visible than a recoverable failure (002 §10.7,
  // 005 doctor rollup): both fail explain's verdict and doctor's monitor check.
  for (const [name, fault, dropped] of [
    [
      `retained (a ${String(RETAINED_SUFFIX)}-record suffix, which fits)`,
      label(0, OVER_CAPACITY_SPAN - RETAINED_SUFFIX),
      false,
    ],
    ['dropped (a suffix one over capacity)', FAULT_LABEL, true],
  ] as const) {
    it(`fails explain and doctor for a ${name} failure`, async () => {
      const f = fixture('poll', (cursor) =>
        cursor === 0
          ? observations(0, OVER_CAPACITY_SPAN)
          : observations(cursor, 3),
      );
      abortOn(f, fault);

      await f.runtime.tick(f.monitorsDir, f.root);

      const explained = await explain(f);
      expect(explained.verdict.status).toBe('failure');
      expect(explained.verdict.reason).toContain(`native fault on ${fault}`);
      const rollup = await doctorRollup(f);
      if (dropped) {
        expect(rollup.materializationRetries).toMatchObject({
          pending: 0,
          terminal: 0,
        });
        expect(rollup.unretainedObservationLoss?.error).toContain(
          `native fault on ${fault}`,
        );
      } else {
        expect(rollup.materializationRetries?.pending).toBe(RETAINED_SUFFIX);
        expect(rollup.unretainedObservationLoss).toBeUndefined();
      }
    });
  }

  it('keeps drops outstanding across a later failure and a later drop, and tells them apart', async () => {
    let call = 0;
    const f = fixture('poll', () => {
      const current = call++;
      if (current === 1) throw new Error('source unavailable');
      if (current === 0) return observations(0, 10, { 5: { n: 1n } });
      // A later span that drops `object-2` and stops before `object-5`.
      if (current === 2) return observations(2, 4, { 2: { n: 1n } });
      return [];
    });

    await f.runtime.tick(f.monitorsDir, f.root);
    expect((await doctorRollup(f)).unretainedObservationLoss).toMatchObject({
      count: 1,
      position: 6,
      spanSize: 10,
      objectKey: 'object-5',
      title: 'b0-5',
    });

    // An observe() failure does not supersede the drop.
    const failed = await nextPoll(f);
    expect(failed.erroredObservations).toEqual([
      { monitorId: MONITOR_ID, message: 'source unavailable' },
    ]);
    expect((await doctorRollup(f)).unretainedObservationLoss).toMatchObject({
      count: 1,
      objectKey: 'object-5',
    });
    expect((await explain(f)).verdict.status).toBe('failure');
    expect(stage(await explain(f), 'materialization')?.status).toBe('failure');

    // A second drop in a later span accumulates, and its row is distinct.
    await nextPoll(f);
    const rows = dropRows(f);
    expect(
      rows.map(({ position, objectKey, title }) => ({
        position,
        objectKey,
        title,
      })),
    ).toEqual([
      { position: 3, objectKey: 'object-2', title: 'b2-2' },
      { position: 6, objectKey: 'object-5', title: 'b0-5' },
    ]);
    expect((await doctorRollup(f)).unretainedObservationLoss).toMatchObject({
      count: 2,
      position: 3,
      spanSize: 4,
      objectKey: 'object-2',
      title: 'b2-2',
      error: expect.stringMatching(DOMAIN),
    });
  });

  it('keeps a span whose only observation was dropped outstanding through later quiet ticks', async () => {
    const f = fixture('poll', (cursor) =>
      cursor === 0 ? observations(0, 1, { 0: { n: 1n } }) : [],
    );

    await f.runtime.tick(f.monitorsDir, f.root);

    expect(latestRow(f)?.observationData).toMatchObject({
      notRetained: true,
      position: 1,
      spanSize: 1,
    });
    expect((await doctorRollup(f)).unretainedObservationLoss).toMatchObject({
      count: 1,
      position: 1,
      spanSize: 1,
    });
    expect((await explain(f)).verdict.status).toBe('failure');

    // Regression (#497): a later no-change outcome used to read as clean and
    // clear the drop one poll later, although the observation was never
    // delivered. A quiet tick supersedes nothing.
    await nextPoll(f);
    await nextPoll(f);
    expect(latestRow(f)?.result).toBe('no-change');
    expect((await doctorRollup(f)).unretainedObservationLoss).toMatchObject({
      count: 1,
      objectKey: 'object-0',
    });
    expect(stage(await explain(f), 'materialization')?.status).toBe('failure');
  });

  it('stores only safe, bounded identity text and never the payload', async () => {
    // Controls (C0, DEL, C1) and Unicode separators become spaces; every text
    // field is capped at 1,024 characters (002 materialization_retry_outbox
    // safe-text rule, applied to observation_history drop rows).
    const unsafe = 'a\u001b\r\n\t\u007f\u0085\u2028\u2029';
    const f = fixture('poll', (cursor) =>
      cursor === 0
        ? [
            ...observations(0, FAULT_INDEX),
            {
              title: unsafe + 't'.repeat(2_000),
              summary: FAULT_LABEL,
              objectKey: unsafe + 'k',
              snapshotText: `content-${FAULT_LABEL}`,
              payload: { secret: 'PRIVATE-PAYLOAD' },
            },
            ...observations(0, OVER_CAPACITY_SPAN).slice(FAULT_INDEX + 1),
          ]
        : [],
    );
    // A long materialization error with an embedded newline.
    f.writer.client.exec(sql`
      CREATE TRIGGER fault_long BEFORE INSERT ON monitor_events
      WHEN NEW.summary = '${FAULT_LABEL}'
      BEGIN SELECT RAISE(ABORT, 'long fault
${'y'.repeat(1_500)}'); END;
    `);

    await f.runtime.tick(f.monitorsDir, f.root);

    const [drop] = dropRows(f);
    expect(drop?.['title']).toBe('a' + ' '.repeat(8) + 't'.repeat(1_015));
    expect(drop?.['objectKey']).toBe('a' + ' '.repeat(8) + 'k');
    const error = String(drop?.['error']);
    expect(error).toHaveLength(1_024);
    expect(error.startsWith('long fault y')).toBe(true);
    // The reason survives the cap.
    expect(error).toMatch(
      / Not retained for retry: the retry outbox capacity is exhausted: [^]*\.$/,
    );
    // eslint-disable-next-line no-control-regex -- asserts the stored text has none
    expect(error).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    const history = JSON.stringify(
      f.reader.listObservationHistory({
        monitorId: MONITOR_ID,
        workspacePath: f.root,
        limit: 10_000,
      }),
    );
    expect(history).not.toContain('PRIVATE');
    expect(
      JSON.stringify((await doctorRollup(f)).unretainedObservationLoss),
    ).not.toContain('PRIVATE');
  });
});

/**
 * When an outstanding drop stops being reported (002 §2, "Admission outcomes
 * when the outbox cannot take a suffix"): a drop with an object key stays
 * outstanding until a later event materializes for that key, monitor and
 * workspace; a drop without one stays outstanding until a later span of that
 * monitor in that workspace materializes an event and drops nothing. Nothing
 * else supersedes a drop. Regression for #497, where any later non-`errored`
 * history row (a quiet poll, a rollup hold) cleared it.
 */
describe('an outstanding drop is cleared only by a superseding outcome', () => {
  /** The loss the store reports for the fixture's monitor and workspace. */
  function loss(f: Fixture) {
    return f.reader.outstandingUnretainedObservationLoss(MONITOR_ID, f.root);
  }

  /** One observation for an explicit object key. */
  function keyed(name: string, objectKey: string, payload?: unknown) {
    return {
      title: name,
      summary: name,
      objectKey,
      snapshotText: `content-${name}`,
      ...(payload === undefined ? {} : { payload }),
    };
  }

  /** One observation without an object key. */
  function unkeyed(name: string, payload?: unknown): Observation {
    return {
      title: name,
      summary: name,
      ...(payload === undefined ? {} : { payload }),
    };
  }

  /** An event of another monitor or workspace, inserted through the store. */
  function foreignEvent(
    f: Fixture,
    scope: { monitorId: string; workspacePath: string },
    objectKey: string,
  ) {
    new RuntimeStore(f.writer.db).insertEvent({
      ...scope,
      sourceName: 'suffix-source',
      urgency: 'normal',
      title: objectKey,
      body: '',
      summary: `foreign-${objectKey}`,
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey,
      baselineStrategy: 'incremental',
      queryScope: {},
      tags: [],
      createdAt: new Date(clockTime),
    });
  }

  it('keeps a keyed drop through quiet ticks, observe failures, retained-only spans and other keys, then clears on its key', async () => {
    let call = 0;
    const f = fixture('poll', () => {
      const current = call++;
      switch (current) {
        case 0:
          // `object-1` is dropped; `object-0` materializes BEFORE it in the
          // same span, which must not count as superseding it.
          return [
            keyed('k0-0', 'object-1'),
            keyed('k0-1', 'object-1', { n: 1n }),
            keyed('k0-2', 'object-2'),
          ];
        case 1:
          return [];
        case 2:
          throw new Error('source unavailable');
        case 3:
          // Its only failure is retained (fault on k3-1); k3-0 materializes.
          return [keyed('k3-0', 'object-7'), keyed('k3-1', 'object-8')];
        case 4:
          return [keyed('k4-0', 'object-0'), keyed('k4-1', 'object-2')];
        default:
          return [keyed(`k${String(current)}-0`, 'object-1')];
      }
    });
    abortOn(f, 'k3-1');

    await f.runtime.tick(f.monitorsDir, f.root);
    expect(loss(f)).toMatchObject({ count: 1, objectKey: 'object-1' });

    await nextPoll(f);
    expect(latestRow(f)?.result).toBe('no-change');
    expect(loss(f)).toMatchObject({ count: 1, objectKey: 'object-1' });

    const failed = await nextPoll(f);
    expect(failed.erroredObservations).toHaveLength(1);
    expect(loss(f)).toMatchObject({ count: 1, objectKey: 'object-1' });

    const retainedOnly = await nextPoll(f);
    expect(retainedOnly.emittedEventIds).toHaveLength(1);
    expect(
      f.reader.materializationRetrySummary(MONITOR_ID, f.root).pending,
    ).toBe(1);
    expect(loss(f)).toMatchObject({ count: 1, objectKey: 'object-1' });

    // The retained k3-1 (object-8) drains before the next span is observed
    // (002 §2.7); an event for another key does not supersede the drop.
    f.writer.client.exec('DROP TRIGGER fault_k3_1');
    const otherKeys = await nextPoll(f);
    expect(otherKeys.emittedEventIds).toHaveLength(3);
    expect(loss(f)).toMatchObject({ count: 1, objectKey: 'object-1' });
    expect((await doctorRollup(f)).unretainedObservationLoss).toMatchObject({
      count: 1,
      objectKey: 'object-1',
    });
    expect(stage(await explain(f), 'materialization')?.status).toBe('failure');

    const superseding = await nextPoll(f);
    expect(superseding.emittedEventIds).toHaveLength(1);
    expect(loss(f)).toBeUndefined();
    expect((await doctorRollup(f)).unretainedObservationLoss).toBeUndefined();
    // The retained failure from the earlier span has drained, so nothing is
    // left to report.
    expect(stage(await explain(f), 'materialization')?.status).toBe('ok');
  });

  it('clears a keyed drop when a later sibling in its own span materializes the same key', async () => {
    const f = fixture('poll', (cursor) =>
      cursor === 0
        ? [keyed('s0-0', 'object-1', { n: 1n }), keyed('s0-1', 'object-1')]
        : [],
    );

    await f.runtime.tick(f.monitorsDir, f.root);

    expect(dropRows(f)).toHaveLength(1);
    expect(loss(f)).toBeUndefined();
  });

  it('does not clear a keyed drop for an event of the same key from another monitor or another workspace', async () => {
    const f = fixture('poll', (cursor) =>
      cursor === 0 ? [keyed('x0-0', 'object-1', { n: 1n })] : [],
    );
    await f.runtime.tick(f.monitorsDir, f.root);
    expect(loss(f)).toMatchObject({ count: 1, objectKey: 'object-1' });

    clockTime += 1_000;
    foreignEvent(
      f,
      { monitorId: 'another-monitor', workspacePath: f.root },
      'object-1',
    );
    foreignEvent(
      f,
      { monitorId: MONITOR_ID, workspacePath: `${f.root}-elsewhere` },
      'object-1',
    );
    expect(loss(f)).toMatchObject({ count: 1, objectKey: 'object-1' });

    // Control: the same insert for this monitor and workspace supersedes it.
    foreignEvent(
      f,
      { monitorId: MONITOR_ID, workspacePath: f.root },
      'object-1',
    );
    expect(loss(f)).toBeUndefined();
  });

  it('keeps an unkeyed drop through quiet ticks and a later dropping span, then clears on a span that materializes and drops nothing', async () => {
    let call = 0;
    const f = fixture('poll', () => {
      const current = call++;
      switch (current) {
        case 0:
          return [unkeyed('u0-0'), unkeyed('u0-1', { n: 1n })];
        case 1:
        case 2:
          return [];
        case 3:
          return [unkeyed('u3-0'), unkeyed('u3-1', { n: 1n })];
        default:
          return [unkeyed(`u${String(current)}-0`)];
      }
    });

    await f.runtime.tick(f.monitorsDir, f.root);
    expect(loss(f)).toMatchObject({ count: 1, position: 2, spanSize: 2 });
    expect(loss(f)?.objectKey).toBeUndefined();

    await nextPoll(f);
    await nextPoll(f);
    expect(latestRow(f)?.result).toBe('no-change');
    expect(loss(f)).toMatchObject({ count: 1 });

    // Materializes an event but drops again: it supersedes neither drop.
    const droppedAgain = await nextPoll(f);
    expect(droppedAgain.emittedEventIds).toHaveLength(1);
    expect(loss(f)).toMatchObject({ count: 2, position: 2, spanSize: 2 });

    const clean = await nextPoll(f);
    expect(clean.emittedEventIds).toHaveLength(1);
    expect(loss(f)).toBeUndefined();
  });

  it('does not clear an unkeyed drop for a span of another workspace', async () => {
    let call = 0;
    const f = fixture('poll', () =>
      call++ === 0 ? [unkeyed('w0-0', { n: 1n })] : [unkeyed('w1-0')],
    );
    await f.runtime.tick(f.monitorsDir, f.root);
    expect(loss(f)).toMatchObject({ count: 1 });

    // The same monitor id observed for another workspace materializes a clean span.
    const elsewhere = `${f.root}-elsewhere`;
    clockTime += 2_000;
    const other = await f.runtime.tick(f.monitorsDir, elsewhere);
    expect(other.emittedEventIds).toHaveLength(1);
    expect(loss(f)).toMatchObject({ count: 1 });
  });

  it('keeps a rollup drop through the next hold and clears it at the flush that materializes its key', async () => {
    const f = fixture('rollup', (cursor) =>
      cursor === 0
        ? observations(0, OVER_CAPACITY_SPAN)
        : [keyed(`r${String(cursor)}-0`, FAULT_KEY)],
    );
    abortOn(f, FAULT_LABEL);

    // Hold at 12:00, flush at 12:01: the capacity fault drops the failed object key.
    await f.runtime.tick(f.monitorsDir, f.root);
    clockTime = NOW.getTime() + 60_000;
    await f.runtime.tick(f.monitorsDir, f.root);
    expect(loss(f)).toMatchObject({ count: 1, objectKey: FAULT_KEY });

    // 13:00 observes the failed object key again but only holds it.
    clockTime = NOW.getTime() + 60 * 60_000;
    const held = await f.runtime.tick(f.monitorsDir, f.root);
    expect(held.emittedEventIds).toEqual([]);
    expect(latestRow(f)?.result).toBe('suppressed');
    expect(loss(f)).toMatchObject({ count: 1, objectKey: FAULT_KEY });

    // 13:01 flushes it; the flushed event carries the observation's own key.
    clockTime = NOW.getTime() + 61 * 60_000;
    const flushed = await f.runtime.tick(f.monitorsDir, f.root);
    expect(flushed.emittedEventIds).toHaveLength(1);
    const [event] = f.reader.listEvents({
      monitorId: MONITOR_ID,
      workspacePath: f.root,
      limit: 1,
    });
    expect(event?.summary).toBe('r1-0');
    expect(event?.objectKey).toBe(FAULT_KEY);
    expect(loss(f)).toBeUndefined();
  });

  /**
   * Complete the fixture's only pending retry the way a drain would: the
   * deterministic event of its stored envelope, through the store's atomic
   * completion seam. The native fault that retained it is removed first.
   */
  function completeOnlyRetry(f: Fixture, faultedSummary: string) {
    f.writer.client.exec(
      `DROP TRIGGER fault_${faultedSummary.replace('-', '_')}`,
    );
    const store = new RuntimeStore(f.writer.db);
    const [retry] = store.listMaterializationRetries({
      monitorId: MONITOR_ID,
      workspacePath: f.root,
    });
    if (!retry) throw new Error('no retained retry to complete');
    const { observation, observedAt } = retry.envelope;
    clockTime += 2_000;
    return store.completeMaterializationRetry(retry.id, {
      monitorId: MONITOR_ID,
      workspacePath: f.root,
      sourceName: 'suffix-source',
      urgency: 'normal',
      title: observation.title,
      body: '',
      summary: observation.summary,
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
  }

  // Regression (#497): "later" is a later observation, not a later write. A
  // retry admitted before the drop carries older state for the key, so its
  // completion after the drop must not clear the drop, although its event
  // commits with a sequence above the drop's watermark.
  it('keeps a keyed drop when a retry admitted before it completes, and clears it on a newer observation of the key', async () => {
    let call = 0;
    const f = fixture('poll', () => {
      const current = call++;
      switch (current) {
        case 0:
          return [keyed('v1', 'object-1')];
        case 1:
          return [];
        default:
          return [keyed('v3', 'object-1')];
      }
    });
    abortOn(f, 'v1');

    await f.runtime.tick(f.monitorsDir, f.root);
    expect(
      f.reader.materializationRetrySummary(MONITOR_ID, f.root).pending,
    ).toBe(1);
    // A monitor with retained work no longer admits a span (002 §2.7), so a
    // drop recorded after a still-pending retry exists only in a database
    // written before that rule. Record the drop directly, as admission would.
    new RuntimeStore(f.writer.db).recordUnretainedObservation({
      monitorId: MONITOR_ID,
      workspacePath: f.root,
      sourceName: 'suffix-source',
      objectKey: 'object-1',
      observationData: {
        error:
          'insert failed Not retained for retry: the envelope is not serializable for the retry outbox.',
        notRetained: true,
        position: 1,
        spanSize: 1,
        objectKey: 'object-1',
        title: 'v2',
      },
    });
    expect(loss(f)).toMatchObject({
      count: 1,
      objectKey: 'object-1',
      title: 'v2',
    });

    const completed = completeOnlyRetry(f, 'v1');
    expect(completed.summary).toBe('v1');
    expect(
      f.reader.materializationRetrySummary(MONITOR_ID, f.root).pending,
    ).toBe(0);
    expect(loss(f)).toMatchObject({
      count: 1,
      objectKey: 'object-1',
      title: 'v2',
    });
    // A quiet tick after the completion changes nothing.
    await nextPoll(f);
    expect(loss(f)).toMatchObject({ count: 1, objectKey: 'object-1' });

    const newer = await nextPoll(f);
    expect(newer.emittedEventIds).toHaveLength(1);
    expect(loss(f)).toBeUndefined();
  });

  it('clears a keyed drop when a retry admitted after it completes, with no event between them', async () => {
    let call = 0;
    const f = fixture('poll', () =>
      call++ === 0
        ? [keyed('v1', 'object-1', { n: 1n })]
        : call === 2
          ? [keyed('v2', 'object-1')]
          : [],
    );
    abortOn(f, 'v2');

    await f.runtime.tick(f.monitorsDir, f.root);
    expect(loss(f)).toMatchObject({ count: 1, title: 'v1' });
    // v2 is retained, so nothing materializes between the drop and its admission.
    const retained = await nextPoll(f);
    expect(retained.emittedEventIds).toEqual([]);
    expect(
      f.reader.materializationRetrySummary(MONITOR_ID, f.root).pending,
    ).toBe(1);
    expect(loss(f)).toMatchObject({ count: 1, title: 'v1' });

    completeOnlyRetry(f, 'v2');
    expect(loss(f)).toBeUndefined();
  });

  it('clears a keyed drop when a later sibling of its own span is retained and completes', async () => {
    const f = fixture('poll', (cursor) =>
      cursor === 0
        ? [keyed('s1', 'object-1', { n: 1n }), keyed('s2', 'object-1')]
        : [],
    );
    abortOn(f, 's2');

    await f.runtime.tick(f.monitorsDir, f.root);
    expect(dropRows(f)).toHaveLength(1);
    expect(
      f.reader.materializationRetrySummary(MONITOR_ID, f.root).pending,
    ).toBe(1);
    expect(loss(f)).toMatchObject({ count: 1, title: 's1' });

    completeOnlyRetry(f, 's2');
    expect(loss(f)).toBeUndefined();
  });

  it('keeps an outstanding drop across reopening the store', async () => {
    const f = fixture('poll', (cursor) =>
      cursor === 0 ? [keyed('p0-0', 'object-1', { n: 1n })] : [],
    );
    await f.runtime.tick(f.monitorsDir, f.root);
    await nextPoll(f);
    for (const client of [f.writer.client, f.observer.client]) client.close();

    const db = createDb(path.join(f.root, 'runtime.db'));
    try {
      expect(
        new RuntimeStore(db).outstandingUnretainedObservationLoss(
          MONITOR_ID,
          f.root,
        ),
      ).toMatchObject({ count: 1, objectKey: 'object-1' });
    } finally {
      (db as unknown as { $client: BetterSQLiteClient }).$client.close();
    }
  });
});

/**
 * A drop must stay visible when its monitor no longer has one unambiguous
 * parsed definition, the way retained work does (002 §2; 005 doctor orphan
 * groups). Regression for #497: the loss was computed only for scanned
 * monitors, so removing or breaking the definition made it vanish.
 */
describe('a drop without one current definition is reported in the orphan groups', () => {
  async function dropped() {
    const f = fixture('poll', (cursor) =>
      cursor === 0 ? observations(0, 3, { 1: { n: 1n } }) : [],
    );
    await f.runtime.tick(f.monitorsDir, f.root);
    return f;
  }

  async function report(f: Fixture) {
    return f.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
  }

  const expectedLoss = {
    count: 1,
    position: 2,
    spanSize: 3,
    objectKey: 'object-1',
    title: 'b0-1',
  };

  it('reports the loss of a removed definition', async () => {
    const f = await dropped();
    rmSync(path.join(f.monitorsDir, MONITOR_ID), { recursive: true });

    const doctor = await report(f);

    expect(doctor.monitors).toEqual([]);
    // Only the loss: no retry summary is invented for an empty outbox.
    expect(doctor.orphanedMonitorWork).toEqual([
      {
        monitorId: MONITOR_ID,
        monitorKind: 'persistent',
        unretainedObservationLoss: expect.objectContaining(expectedLoss),
      },
    ]);
  });

  it('reports the loss of an unparseable definition', async () => {
    const f = await dropped();
    writeFileSync(
      path.join(f.monitorsDir, MONITOR_ID, 'MONITOR.md'),
      '---\nwatch: [unterminated\n---\n',
    );

    const doctor = await report(f);

    expect(doctor.parseErrors.map(({ id }) => id)).toEqual([MONITOR_ID]);
    expect(doctor.orphanedMonitorWork).toEqual([
      expect.objectContaining({
        monitorId: MONITOR_ID,
        unretainedObservationLoss: expect.objectContaining(expectedLoss),
      }),
    ]);
  });

  it('reports a duplicated id once in its orphan group, not on each definition', async () => {
    const f = await dropped();
    mkdirSync(path.join(f.monitorsDir, 'nested', MONITOR_ID), {
      recursive: true,
    });
    writeFileSync(
      path.join(f.monitorsDir, 'nested', MONITOR_ID, 'MONITOR.md'),
      '---\nwatch:\n  type: suffix-source\n  interval: 1s\nurgency: normal\n---\nDuplicate.\n',
    );

    const doctor = await report(f);

    expect(doctor.duplicateIds.map(({ id }) => id)).toEqual([MONITOR_ID]);
    for (const monitor of doctor.monitors) {
      expect(monitor.unretainedObservationLoss).toBeUndefined();
    }
    expect(doctor.orphanedMonitorWork).toEqual([
      expect.objectContaining({
        monitorId: MONITOR_ID,
        unretainedObservationLoss: expect.objectContaining(expectedLoss),
      }),
    ]);
  });

  // Regression (#497): doctor scanned only MONITOR.md definitions, so a live
  // ephemeral monitor's drop was reported as an orphaned "removed definition".
  it('attributes a live ephemeral monitor drop to it, and reports it as a retired ephemeral orphan once cancelled', async () => {
    const f = fixture('poll', (cursor) =>
      cursor === 0 ? observations(0, 3, { 1: { n: 1n } }) : [],
    );
    // Only the ephemeral monitor observes in this workspace.
    rmSync(path.join(f.monitorsDir, MONITOR_ID), { recursive: true });
    const [session] = f.reader.sessionsForWorkspace(f.root);
    if (!session) throw new Error('fixture opened no lead session');
    const watch = f.runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'suffix-source',
      scope: {},
      instruction: 'Watch the suffix.',
    });
    await f.runtime.tick(f.monitorsDir, f.root);
    expect(
      f.reader.outstandingUnretainedObservationLoss(watch.id, f.root),
    ).toMatchObject(expectedLoss);

    const live = await report(f);
    expect(live.orphanedMonitorWork).toEqual([]);
    expect(live.ephemeralMonitorWork).toEqual([
      {
        monitorId: watch.id,
        sessionId: session.id,
        unretainedObservationLoss: expect.objectContaining(expectedLoss),
      },
    ]);

    f.runtime.cancelEphemeralMonitor(session.id, watch.id);
    const retired = await report(f);
    expect(retired.ephemeralMonitorWork).toEqual([]);
    expect(retired.orphanedMonitorWork).toEqual([
      {
        monitorId: watch.id,
        monitorKind: 'ephemeral',
        unretainedObservationLoss: expect.objectContaining(expectedLoss),
      },
    ]);
  });

  it('attributes a live ephemeral monitor retained work to it, not to an orphan group', async () => {
    const f = fixture('poll', (cursor) =>
      cursor === 0 ? observations(0, 2) : [],
    );
    abortOn(f, 'b0-1');
    rmSync(path.join(f.monitorsDir, MONITOR_ID), { recursive: true });
    const [session] = f.reader.sessionsForWorkspace(f.root);
    if (!session) throw new Error('fixture opened no lead session');
    const watch = f.runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'suffix-source',
      scope: {},
      instruction: 'Watch the suffix.',
    });
    await f.runtime.tick(f.monitorsDir, f.root);

    const live = await report(f);
    expect(live.orphanedMonitorWork).toEqual([]);
    expect(live.ephemeralMonitorWork).toEqual([
      {
        monitorId: watch.id,
        sessionId: session.id,
        materializationRetries: expect.objectContaining({
          pending: 1,
          terminal: 0,
        }),
      },
    ]);

    f.runtime.cancelEphemeralMonitor(session.id, watch.id);
    expect((await report(f)).orphanedMonitorWork).toEqual([
      expect.objectContaining({
        monitorId: watch.id,
        monitorKind: 'ephemeral',
        materializationRetries: expect.objectContaining({ pending: 1 }),
      }),
    ]);
  });

  it('keeps the loss on the rollup of a parsed but invalid definition', async () => {
    const f = await dropped();
    writeFileSync(
      path.join(f.monitorsDir, MONITOR_ID, 'MONITOR.md'),
      '---\nwatch:\n  type: no-such-source\n  interval: 1s\nurgency: normal\n---\nInvalid.\n',
    );

    const doctor = await report(f);

    expect(doctor.monitors).toHaveLength(1);
    expect(doctor.monitors[0]?.valid).toBe(false);
    expect(doctor.monitors[0]?.unretainedObservationLoss).toMatchObject(
      expectedLoss,
    );
    expect(doctor.orphanedMonitorWork).toEqual([]);
  });
});

/**
 * A monitor whose source config is rejected by the execution preflight
 * (002 §2 step 5, #557) after admission dropped one of its observations. The
 * preflight runs before admission, so a rejected config adds no drop and no
 * retry; the drop it already has stays outstanding and visible, as for any
 * definition that fails validation, until a later observation supersedes it
 * once the config is corrected.
 */
describe('a drop on a monitor whose source config is now rejected', () => {
  /** Accepts the fixture's config; rejects `mode: broken`. */
  const STRICT_SCOPE = {
    type: 'object',
    properties: { mode: { enum: ['ok'] } },
  };

  function rewrite(
    f: Fixture,
    extraWatch: string,
    body = 'Inspect the changes.',
  ) {
    writeFileSync(
      path.join(f.monitorsDir, MONITOR_ID, 'MONITOR.md'),
      `---\nname: Suffix\nwatch:\n  type: suffix-source\n  interval: 1s\n${extraWatch}urgency: normal\nbaseline-strategy: incremental\n---\n${body}\n`,
    );
  }

  async function droppedThenRejected() {
    let observed = 0;
    const control = { poison: true };
    const f = fixture(
      'poll',
      (cursor) => {
        observed += 1;
        // While poisoned, every span drops `object-1`, so a span that ran
        // under the rejected config would add a drop.
        return observations(cursor, 3, control.poison ? { 1: { n: 1n } } : {});
      },
      undefined,
      STRICT_SCOPE,
    );
    await f.runtime.tick(f.monitorsDir, f.root);
    expect(dropRows(f)).toHaveLength(1);
    rewrite(f, '  mode: broken\n');
    return { f, observed: () => observed, control };
  }

  it('skips the rejected config without observing, dropping or retaining, and keeps the outstanding drop', async () => {
    const { f, observed } = await droppedThenRejected();
    const before = observed();

    const result = await nextPoll(f);

    expect(result.skippedMonitors).toEqual([
      {
        monitorId: MONITOR_ID,
        validationError: expect.stringContaining('mode'),
      },
    ]);
    expect(observed()).toBe(before);
    expect(dropRows(f)).toHaveLength(1);
    expect(
      f.reader.listMaterializationRetries({
        monitorId: MONITOR_ID,
        workspacePath: f.root,
      }),
    ).toEqual([]);
    expect(
      f.reader.outstandingUnretainedObservationLoss(MONITOR_ID, f.root),
    ).toMatchObject({ count: 1, objectKey: 'object-1' });
  });

  it('explains the validation failure as the verdict and still reports the outstanding drop', async () => {
    const { f } = await droppedThenRejected();
    await nextPoll(f);

    const report = await explain(f);

    expect(report.verdict).toMatchObject({
      status: 'failure',
      stage: 'definition',
    });
    expect(report.verdict.reason).toContain('mode');
    const materialization = stage(report, 'materialization');
    expect(materialization?.status).toBe('failure');
    expect(materialization?.reason).toContain(
      '1 observation(s) were dropped because the retry outbox could not retain them',
    );
    expect(materialization?.details).toMatchObject({
      unretainedObservationLoss: { count: 1, objectKey: 'object-1' },
    });
  });

  it('keeps the drop on the invalid rollup in doctor, not in an orphan or ephemeral group', async () => {
    const { f } = await droppedThenRejected();
    await nextPoll(f);

    const doctor = await f.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });

    expect(doctor.monitors).toHaveLength(1);
    expect(doctor.monitors[0]).toMatchObject({
      valid: false,
      validationError: expect.stringContaining('mode'),
      due: false,
      unretainedObservationLoss: { count: 1, objectKey: 'object-1' },
      materializationRetries: { pending: 0, terminal: 0 },
    });
    expect(doctor.monitors[0]?.nextDueAt).toBeUndefined();
    expect(doctor.orphanedMonitorWork).toEqual([]);
    expect(doctor.ephemeralMonitorWork).toEqual([]);
  });

  it('keeps a live ephemeral monitor drop attributed to it after its persisted scope is rejected', async () => {
    // A schema the test can tighten after the drop, as a source upgrade would.
    const mode = { enum: ['ok'] };
    const f = fixture(
      'poll',
      (cursor) => (cursor === 0 ? observations(0, 3, { 1: { n: 1n } }) : []),
      undefined,
      { type: 'object', properties: { mode } },
    );
    // Only the ephemeral monitor observes in this workspace.
    rmSync(path.join(f.monitorsDir, MONITOR_ID), { recursive: true });
    const [session] = f.reader.sessionsForWorkspace(f.root);
    if (!session) throw new Error('fixture opened no lead session');
    const watch = f.runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'suffix-source',
      scope: { mode: 'ok' },
      instruction: 'Watch the suffix.',
    });
    await f.runtime.tick(f.monitorsDir, f.root);
    const loss = { count: 1, objectKey: 'object-1' };
    expect(
      f.reader.outstandingUnretainedObservationLoss(watch.id, f.root),
    ).toMatchObject(loss);

    mode.enum = ['upgraded'];
    const result = await nextPoll(f);
    expect(result.skippedMonitors).toEqual([
      { monitorId: watch.id, validationError: expect.stringContaining('mode') },
    ]);

    const doctor = await f.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.orphanedMonitorWork).toEqual([]);
    expect(doctor.ephemeralMonitorWork).toEqual([
      {
        monitorId: watch.id,
        sessionId: session.id,
        unretainedObservationLoss: expect.objectContaining(loss),
        // #497 review: the group says why the watch is skipped, since an
        // ephemeral scope cannot be edited and no later event can clear it.
        validationError: expect.stringContaining('mode'),
      },
    ]);
  });

  it('leaves validationError absent on a live ephemeral group whose scope is still valid', async () => {
    const f = fixture(
      'poll',
      (cursor) => (cursor === 0 ? observations(0, 3, { 1: { n: 1n } }) : []),
      undefined,
      { type: 'object', properties: { mode: { enum: ['ok'] } } },
    );
    rmSync(path.join(f.monitorsDir, MONITOR_ID), { recursive: true });
    const [session] = f.reader.sessionsForWorkspace(f.root);
    if (!session) throw new Error('fixture opened no lead session');
    const watch = f.runtime.declareEphemeralMonitor({
      sessionId: session.id,
      source: 'suffix-source',
      scope: { mode: 'ok' },
      instruction: 'Watch the suffix.',
    });
    await f.runtime.tick(f.monitorsDir, f.root);

    const doctor = await f.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.ephemeralMonitorWork).toHaveLength(1);
    expect(doctor.ephemeralMonitorWork?.[0]).toMatchObject({
      monitorId: watch.id,
    });
    expect(doctor.ephemeralMonitorWork?.[0]).not.toHaveProperty(
      'validationError',
    );
  });

  it('clears the drop once the corrected config observes its key again', async () => {
    const { f, control } = await droppedThenRejected();
    await nextPoll(f);
    expect(
      f.reader.outstandingUnretainedObservationLoss(MONITOR_ID, f.root),
    ).toBeDefined();

    rewrite(f, '  mode: ok\n');
    control.poison = false;
    await nextPoll(f);

    expect(
      f.reader.outstandingUnretainedObservationLoss(MONITOR_ID, f.root),
    ).toBeUndefined();
    expect((await doctorRollup(f)).unretainedObservationLoss).toBeUndefined();
  });
});

/**
 * A drop beside #566's stale-definition note: the monitor's definition changed
 * after the dropping span materialized its siblings. Explain must report both
 * without contradiction: the drop fails materialization (the verdict), and the
 * delivery stage notes that the pending siblings predate the current
 * definition.
 */
describe('a drop beside pending events that predate the current definition', () => {
  it('explains the drop as the verdict and notes the stale pending events in delivery', async () => {
    const f = fixture('poll', (cursor) =>
      cursor === 0 ? observations(0, 3, { 1: { n: 1n } }) : [],
    );
    await f.runtime.tick(f.monitorsDir, f.root);
    // A valid edit to the body changes the definition fingerprint.
    const file = path.join(f.monitorsDir, MONITOR_ID, 'MONITOR.md');
    writeFileSync(
      file,
      `---\nname: Suffix\nwatch:\n  type: suffix-source\n  interval: 1s\nurgency: normal\nbaseline-strategy: incremental\n---\nA different body.\n`,
    );

    const report = await explain(f);

    expect(report.stages.find(({ id }) => id === 'definition')?.status).toBe(
      'ok',
    );
    expect(report.verdict).toMatchObject({
      status: 'failure',
      stage: 'materialization',
    });
    expect(report.verdict.reason).toContain('were dropped');
    const delivery = report.stages.find(({ id }) => id === 'delivery');
    expect(delivery?.status).toBe('ok');
    expect(delivery?.reason).toContain(
      "2 pending event(s) in total predate the monitor's current definition",
    );
    expect(delivery?.details?.['staleDefinitionEventIds']).toHaveLength(2);
  });
});
