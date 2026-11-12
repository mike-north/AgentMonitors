/**
 * Retained materialization work is drained before newer source input
 * (002 §2.6). For one monitor, every retry in the outbox completes, in the
 * order it was admitted, before that monitor's source is asked for anything
 * newer; a retry that keeps failing pauses only its own monitor and is
 * reported every tick it recurs; and a delayed retry never reaches a session
 * that registered after the observation was admitted, even within the same
 * second.
 *
 * Faults are real SQLite triggers on `monitor_events`, so they behave the same
 * on the admitting connection and after the store is reopened.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2.6, §15 `materialization_retry_outbox`
 * @see https://www.sqlite.org/lang_createtrigger.html#raise
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
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const md = String.raw;

/** Admission time of the first span; retry backoff is measured from here. */
const T0 = new Date('2026-08-13T18:00:00.100Z');

const tempRoots: string[] = [];
const clients: BetterSQLiteClient[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const client of clients.splice(0)) if (client.open) client.close();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Drive the runtime's clock without fake timers: retry envelopes require a
 * genuine Date instance, so only the zero-argument constructor and `now()`
 * are redirected.
 */
function stubClock(start: Date) {
  let time = start.getTime();
  vi.stubGlobal(
    'Date',
    new Proxy(Date, {
      construct(target, args) {
        return Reflect.construct(target, args.length === 0 ? [time] : args);
      },
      get(target, key, receiver) {
        return key === 'now' ? () => time : Reflect.get(target, key, receiver);
      },
    }),
  );
  return {
    advance(ms: number) {
      time += ms;
    },
  };
}

interface MonitorSpec {
  id: string;
  /** Items the source emits, one span per entry, advanced by its cursor. */
  spans: string[][];
}

/**
 * A stateful poll source: each call emits the span at its persisted cursor
 * and advances the cursor, so a skipped call is visible as an unconsumed span.
 */
function cursorSource(
  specs: MonitorSpec[],
  calls: { monitor: string; eventsBefore: string[] }[],
  eventsNow: () => string[],
): ObservationSource {
  return {
    name: 'drain-source',
    scopeSchema: { type: 'object' },
    stateful: true,
    observe(config, context: ObservationContext): Promise<ObservationResult> {
      const label = String(config['label']);
      calls.push({ monitor: label, eventsBefore: eventsNow() });
      const spans = specs.find(({ id }) => id === label)?.spans ?? [];
      const cursor =
        (context.previousState as { cursor?: number } | undefined)?.cursor ?? 0;
      const span = spans[cursor] ?? [];
      return Promise.resolve({
        observations: span.map((summary) => ({
          title: summary,
          summary,
          objectKey: summary,
          snapshotText: `${summary}-state`,
        })),
        nextState: { cursor: cursor + 1 },
      });
    },
  };
}

function writeMonitor(monitorsDir: string, id: string, type: string): void {
  mkdirSync(path.join(monitorsDir, id), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, id, 'MONITOR.md'),
    md`---
name: ${id}
watch:
  type: ${type}
  label: ${id}
  interval: 1s
urgency: normal
---
Handle it.
`,
    'utf8',
  );
}

/** Real runtime and store over one on-disk database, reopenable for restart. */
function setup(specs: MonitorSpec[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-retry-drain-'));
  tempRoots.push(root);
  const monitorsDir = path.join(root, 'monitors');
  for (const { id } of specs) writeMonitor(monitorsDir, id, 'drain-source');
  const dbPath = path.join(root, 'runtime.db');
  const calls: { monitor: string; eventsBefore: string[] }[] = [];

  const open = () => {
    const db = createDb(dbPath);
    // The branded InboxDb hides the driver; tests inspect durable rows directly.
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    const registry = new SourceRegistry();
    registry.register(cursorSource(specs, calls, () => eventSummaries(client)));
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    return { client, store, runtime };
  };
  return { root, monitorsDir, calls, open };
}

/** Event summaries in materialization order (the private AUTOINCREMENT key). */
function eventSummaries(client: BetterSQLiteClient, monitorId?: string) {
  return client
    .prepare<[], { summary: string }>(
      `SELECT summary FROM monitor_events
       ${monitorId === undefined ? '' : `WHERE monitor_id = '${monitorId}'`}
       ORDER BY sequence`,
    )
    .all()
    .map(({ summary }) => summary);
}

function retrySummaries(client: BetterSQLiteClient): string[] {
  return client
    .prepare<[], { envelope: string }>(
      `SELECT envelope FROM materialization_retry_outbox
       ORDER BY admission_sequence`,
    )
    .all()
    .map(
      ({ envelope }) =>
        (JSON.parse(envelope) as { observation: { summary: string } })
          .observation.summary,
    );
}

function failSummary(client: BetterSQLiteClient, summary: string): void {
  client.exec(`CREATE TRIGGER fail_${summary}
    BEFORE INSERT ON monitor_events WHEN NEW.summary = '${summary}' BEGIN
    SELECT RAISE(ABORT, '${summary} write failed'); END;`);
}

function repair(client: BetterSQLiteClient, summary: string): void {
  client.exec(`DROP TRIGGER fail_${summary}`);
}

function erroredHistory(runtime: AgentMonitorRuntime, monitorId: string) {
  return runtime
    .listObservationHistory({ monitorId })
    .filter(({ result }) => result === 'errored');
}

function openSession(runtime: AgentMonitorRuntime, root: string, id: string) {
  return runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: id,
      workspacePath: root,
    }),
  );
}

describe('poll intake waits for retained work', () => {
  beforeEach(() => {
    clock = stubClock(T0);
  });
  let clock: ReturnType<typeof stubClock>;

  it('drains a due retry before observing newer input', async () => {
    const f = setup([{ id: 'm', spans: [['A'], ['B']] }]);
    const { client, runtime } = f.open();
    failSummary(client, 'A');

    const first = await runtime.tick(f.monitorsDir, f.root);
    expect(first.emittedEventIds).toEqual([]);
    expect(retrySummaries(client)).toEqual(['A']);

    repair(client, 'A');
    clock.advance(2_000);
    const second = await runtime.tick(f.monitorsDir, f.root);

    // A, retained first, materializes before B; the source is asked for B
    // only once A is an event.
    expect(eventSummaries(client)).toEqual(['A', 'B']);
    expect(second.emittedEventIds).toHaveLength(2);
    expect(second.erroredObservations).toEqual([]);
    expect(second.evaluatedMonitors).toEqual(['m']);
    expect(f.calls.map(({ eventsBefore }) => eventsBefore)).toEqual([
      [],
      ['A'],
    ]);
    expect(retrySummaries(client)).toEqual([]);
  });

  it('does not observe while a retry is pending, failing or backing off', async () => {
    const f = setup([{ id: 'm', spans: [['A'], ['B']] }]);
    const { client, store, runtime } = f.open();
    failSummary(client, 'A');
    await runtime.tick(f.monitorsDir, f.root);

    // Due and still failing: the attempt is reported; the source is not called.
    clock.advance(2_000);
    const failed = await runtime.tick(f.monitorsDir, f.root);
    expect(failed.erroredObservations).toEqual([
      { monitorId: 'm', message: expect.stringContaining('A write failed') },
    ]);
    expect(failed.evaluatedMonitors).toEqual(['m']);
    expect(f.calls).toHaveLength(1);

    // The monitor's own interval has elapsed but the retry is backing off.
    repair(client, 'A');
    clock.advance(1_500);
    const waiting = await runtime.tick(f.monitorsDir, f.root);
    const [retry] = store.listMaterializationRetries({
      monitorId: 'm',
    });
    expect(waiting.erroredObservations).toEqual([]);
    expect(waiting.emittedEventIds).toEqual([]);
    expect(waiting.skippedMonitors).toEqual([
      { monitorId: 'm', nextDueAt: retry?.nextAttemptAt },
    ]);
    expect(f.calls).toHaveLength(1);

    clock.advance(10_000);
    await runtime.tick(f.monitorsDir, f.root);
    expect(eventSummaries(client)).toEqual(['A', 'B']);
    expect(f.calls).toHaveLength(2);
  });

  it('isolates a retry that keeps failing and reports it every tick it recurs', async () => {
    const f = setup([
      { id: 'broken', spans: [['X'], ['Y'], ['Z']] },
      {
        id: 'healthy',
        spans: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'].map((s) => [s]),
      },
    ]);
    const { client, store, runtime } = f.open();
    failSummary(client, 'X');

    const ticks = 8;
    for (let tick = 1; tick <= ticks; tick += 1) {
      const result = await runtime.tick(f.monitorsDir, f.root);
      // The healthy sibling keeps ticking and emitting.
      expect(eventSummaries(client, 'healthy')).toHaveLength(tick);
      const brokenErrors = result.erroredObservations.filter(
        ({ monitorId }) => monitorId === 'broken',
      );
      expect(brokenErrors).toHaveLength(1);
      expect(brokenErrors[0]?.message).toContain('X write failed');
      // One durable `errored` row for every tick the failure recurs.
      expect(erroredHistory(runtime, 'broken')).toHaveLength(tick);
      // Past every backoff step, so each tick is a due attempt or a terminal block.
      clock.advance(600_000);
    }

    const [retry] = store.listMaterializationRetries({
      monitorId: 'broken',
    });
    expect(retry?.status).toBe('terminal');
    // Its source was asked once; Y and Z were never accepted behind X.
    expect(f.calls.filter(({ monitor }) => monitor === 'broken')).toHaveLength(
      1,
    );
    expect(eventSummaries(client, 'broken')).toEqual([]);
  });

  it('drains retries recorded before a restart first, in order, exactly once', async () => {
    const f = setup([{ id: 'm', spans: [['A', 'B', 'C'], ['D']] }]);
    const before = f.open();
    failSummary(before.client, 'A');
    await before.runtime.tick(f.monitorsDir, f.root);
    expect(retrySummaries(before.client)).toEqual(['A', 'B', 'C']);
    repair(before.client, 'A');
    before.client.close();

    clock.advance(2_000);
    const after = f.open();
    const drained = await after.runtime.tick(f.monitorsDir, f.root);
    expect(eventSummaries(after.client)).toEqual(['A', 'B', 'C', 'D']);
    expect(drained.emittedEventIds).toHaveLength(4);
    expect(retrySummaries(after.client)).toEqual([]);
    // The restarted source is asked for D only after the retained span drained.
    expect(f.calls.at(-1)?.eventsBefore).toEqual(['A', 'B', 'C']);

    clock.advance(2_000);
    await after.runtime.tick(f.monitorsDir, f.root);
    expect(eventSummaries(after.client)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('never projects a retry into a session registered after admission in the same second', async () => {
    const f = setup([{ id: 'm', spans: [['A'], ['B']] }]);
    const { client, runtime } = f.open();
    const early = openSession(runtime, f.root, 'early');
    failSummary(client, 'A');
    await runtime.tick(f.monitorsDir, f.root);

    // Same wall-clock second as A's admission (18:00:00.100).
    clock.advance(500);
    const late = openSession(runtime, f.root, 'late');
    expect(Math.floor(late.baselineAt.getTime() / 1_000)).toBe(
      Math.floor(T0.getTime() / 1_000),
    );

    repair(client, 'A');
    clock.advance(1_500);
    await runtime.tick(f.monitorsDir, f.root);

    const projections = client
      .prepare<[], { session: string; summary: string }>(
        `SELECT s.session_id AS session, e.summary AS summary
         FROM session_event_state s JOIN monitor_events e ON e.id = s.event_id
         ORDER BY e.sequence, s.session_id`,
      )
      .all();
    // Ordered by event, then by session id (ULIDs: early sorts before late).
    expect(projections).toEqual([
      { session: early.id, summary: 'A' },
      { session: early.id, summary: 'B' },
      { session: late.id, summary: 'B' },
    ]);
    // No cursor was seeded for the late session from the pre-registration change.
    expect(
      client
        .prepare(
          `SELECT count(*) AS n FROM session_object_cursor
           WHERE session_id = ? AND object_key = 'A'`,
        )
        .get(late.id),
    ).toEqual({ n: 0 });
  });
});

describe('watch intake waits for retained work', () => {
  it('drains a retained batch before pulling the next batch', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentmon-retry-drain-'));
    tempRoots.push(root);
    const monitorsDir = path.join(root, 'monitors');
    writeMonitor(monitorsDir, 'w', 'drain-watch');
    const db = createDb(path.join(root, 'runtime.db'));
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    const pulls: string[][] = [];
    const registry = new SourceRegistry();
    registry.register({
      name: 'drain-watch',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      async *watch(_config, context) {
        for (const summary of ['A', 'B']) {
          pulls.push(eventSummaries(client));
          yield {
            observations: [
              { title: summary, summary, objectKey: summary, snapshotText: '' },
            ],
            nextState: { after: summary },
          };
        }
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) resolve();
          context.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    failSummary(client, 'A');
    const errors: string[] = [];
    const handle = await runtime.watchMonitors(monitorsDir, root, {
      onError: (_id, error) => {
        errors.push(error.message);
        // Repair once A is durably retained, so its retry can succeed.
        if (retrySummaries(client).includes('A')) {
          try {
            repair(client, 'A');
          } catch {
            // Already repaired by an earlier report.
          }
        }
      },
    });
    try {
      await vi.waitFor(
        () => expect(eventSummaries(client)).toEqual(['A', 'B']),
        { timeout: 10_000, interval: 50 },
      );
      // B was requested only after A materialized from the outbox.
      expect(pulls).toEqual([[], ['A']]);
      expect(retrySummaries(client)).toEqual([]);
      expect(errors[0]).toContain('A write failed');
    } finally {
      await handle.stop();
    }
    // The retry backoff runs on real time: at least one second, rounded up.
  }, 20_000);
});

describe('watch intake after a restart', () => {
  let clock: ReturnType<typeof stubClock>;
  beforeEach(() => {
    clock = stubClock(T0);
  });

  it('keeps a restarted watcher closed until its retained batch drains, then pulls', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentmon-retry-drain-'));
    tempRoots.push(root);
    const monitorsDir = path.join(root, 'monitors');
    writeMonitor(monitorsDir, 'w', 'drain-watch');
    const dbPath = path.join(root, 'runtime.db');
    const pulls: string[][] = [];
    let generation = 0;

    const open = () => {
      const db = createDb(dbPath);
      const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
      clients.push(client);
      const registry = new SourceRegistry();
      registry.register({
        name: 'drain-watch',
        scopeSchema: { type: 'object' },
        observe: () => Promise.resolve({ observations: [] }),
        async *watch(_config, context) {
          // Before the restart the producer yields A and B; after it, C.
          const batch = generation++ === 0 ? ['A', 'B'] : ['C'];
          pulls.push(eventSummaries(client));
          yield {
            observations: batch.map((summary) => ({
              title: summary,
              summary,
              objectKey: summary,
              snapshotText: '',
            })),
            nextState: { after: batch.at(-1) },
          };
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) resolve();
            context.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        },
      });
      const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
        claudeCodeAdapter,
      ]);
      return { client, runtime };
    };

    const before = open();
    failSummary(before.client, 'A');
    const first = await before.runtime.watchMonitors(monitorsDir, root);
    await vi.waitFor(() =>
      expect(retrySummaries(before.client)).toEqual(['A', 'B']),
    );
    await first.stop();
    repair(before.client, 'A');
    before.client.close();

    // Restarted before the retry is due: startup cannot drain it, so the
    // watcher's gate stays closed and its source is not asked for anything.
    const after = open();
    const errors: string[] = [];
    const second = await after.runtime.watchMonitors(monitorsDir, root, {
      onError: (_id, error) => errors.push(error.message),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(pulls).toHaveLength(1);
      expect(eventSummaries(after.client)).toEqual([]);
      expect(errors).toEqual([]);

      // A later tick drains the retained batch in order, then opens the gate.
      clock.advance(2_000);
      const tick = await after.runtime.tick(monitorsDir, root);
      expect(tick.emittedEventIds).toHaveLength(2);
      await vi.waitFor(() =>
        expect(eventSummaries(after.client)).toEqual(['A', 'B', 'C']),
      );
      expect(pulls).toEqual([[], ['A', 'B']]);
      expect(retrySummaries(after.client)).toEqual([]);
    } finally {
      await second.stop();
    }
  });
});

describe('retry recipients for rows written before positions were reserved', () => {
  beforeEach(() => {
    stubClock(T0);
  });

  /** Retain A, then open sessions around its admission and complete it. */
  async function retainA() {
    const f = setup([{ id: 'm', spans: [['A']] }]);
    const { client, store, runtime } = f.open();
    const before = openSession(runtime, f.root, 'before');
    failSummary(client, 'A');
    await runtime.tick(f.monitorsDir, f.root);
    const after = openSession(runtime, f.root, 'after');
    repair(client, 'A');
    return { f, client, store, runtime, before, after };
  }

  function recipientsOfA(client: BetterSQLiteClient): string[] {
    return client
      .prepare<[], { session: string }>(
        `SELECT s.session_id AS session FROM session_event_state s
         JOIN monitor_events e ON e.id = s.event_id
         WHERE e.summary = 'A' ORDER BY s.session_id`,
      )
      .all()
      .map(({ session }) => session);
  }

  it('excludes every positioned session from a retry queued before positions existed', async () => {
    const { f, client, runtime } = await retainA();
    client.exec(
      'UPDATE materialization_retry_outbox SET admission_sequence = NULL',
    );
    // Even a session registered before the retry has a position, so it is
    // newer than any retry without one.
    stubClock(new Date(T0.getTime() + 2_000));
    await runtime.tick(f.monitorsDir, f.root);
    expect(eventSummaries(client)).toEqual(['A']);
    expect(recipientsOfA(client)).toEqual([]);
  });

  it('compares a session without a position by its registration time', async () => {
    const { f, client, runtime, before, after } = await retainA();
    client.exec('UPDATE agent_sessions SET registration_sequence = NULL');
    // Whole-second registration time against the observation time: a session
    // from the same second counts as registered before (the legacy order).
    stubClock(new Date(T0.getTime() + 2_000));
    const late = openSession(runtime, f.root, 'late');
    await runtime.tick(f.monitorsDir, f.root);
    expect(recipientsOfA(client)).toEqual([before.id, after.id].sort());
    expect(recipientsOfA(client)).not.toContain(late.id);
  });

  it('keeps a resumed session at its original position', async () => {
    const { f, client, runtime, before } = await retainA();
    const position = () =>
      client
        .prepare<
          [string],
          { position: number | null }
        >('SELECT registration_sequence AS position FROM agent_sessions WHERE id = ?')
        .get(before.id)?.position;
    const original = position();
    expect(original).toEqual(expect.any(Number));
    // Resuming the same host session after the retry was admitted does not
    // move it after that admission.
    expect(openSession(runtime, f.root, 'before').id).toBe(before.id);
    expect(position()).toBe(original);
    stubClock(new Date(T0.getTime() + 2_000));
    await runtime.tick(f.monitorsDir, f.root);
    expect(recipientsOfA(client)).toEqual([before.id]);
  });
});
