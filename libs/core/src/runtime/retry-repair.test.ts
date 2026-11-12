/**
 * Operator repair of a terminal materialization retry (002 §2.7). A retry
 * that exhausts its automatic attempts pauses its monitor; re-arming it
 * returns it to automatic retry, and skipping it records its observation as
 * an outstanding loss (002 §2) and lets the monitor take newer input.
 *
 * Faults are real SQLite triggers on `monitor_events`, and terminal state is
 * reached through real ticks, so the drain, the repair and the loss records
 * are the production code paths over an on-disk database.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2, §2.7, §15 `materialization_retry_outbox`
 * @see ../../../../docs/specs/005-cli-reference.md `monitor retry`
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
import {
  MaterializationRetryNotFoundError,
  MaterializationRetryTransitionError,
  RuntimeStore,
} from './store.js';
import {
  MATERIALIZATION_RETRY_MAX_ATTEMPTS,
  MATERIALIZATION_RETRY_SKIP_REASON_MAX_LENGTH,
} from './types.js';

const md = String.raw;

const T0 = new Date('2026-08-13T18:00:00.100Z');

/** 005 `monitor retry skip`: the longest `--reason`, in trimmed characters. */
const SKIP_REASON_MAX = 200;

const tempRoots: string[] = [];
const clients: BetterSQLiteClient[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

/**
 * A stateful poll source: each call emits the span at its persisted cursor
 * and advances it, so a call skipped while the monitor is paused leaves its
 * span unconsumed. Each item is `summary` or `summary@objectKey`.
 */
function cursorSource(
  spans: string[][],
  calls: string[][],
  eventsNow: () => string[],
): ObservationSource {
  return {
    name: 'repair-source',
    scopeSchema: { type: 'object' },
    stateful: true,
    observe(_config, context: ObservationContext): Promise<ObservationResult> {
      calls.push(eventsNow());
      const cursor =
        (context.previousState as { cursor?: number } | undefined)?.cursor ?? 0;
      return Promise.resolve({
        observations: (spans[cursor] ?? []).map((item) => {
          const [summary = item, objectKey = summary] = item.split('@');
          return {
            title: summary,
            summary,
            objectKey,
            snapshotText: `${summary}-state`,
          };
        }),
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
  interval: 1s
urgency: normal
---
Handle it.
`,
    'utf8',
  );
}

/** One monitor `m` over a reopenable on-disk database. */
function setup(spans: string[][]) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-retry-repair-'));
  tempRoots.push(root);
  const monitorsDir = path.join(root, 'monitors');
  writeMonitor(monitorsDir, 'm', 'repair-source');
  const dbPath = path.join(root, 'runtime.db');
  const calls: string[][] = [];
  const open = () => {
    const db = createDb(dbPath);
    // The branded InboxDb hides the driver; tests inspect durable rows directly.
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    const registry = new SourceRegistry();
    registry.register(cursorSource(spans, calls, () => eventSummaries(client)));
    const runtime = new AgentMonitorRuntime(store, registry, [
      claudeCodeAdapter,
    ]);
    return { client, store, runtime };
  };
  return { root, monitorsDir, calls, open };
}

/** Event summaries in materialization order. */
function eventSummaries(client: BetterSQLiteClient): string[] {
  return client
    .prepare<[], { summary: string }>(
      'SELECT summary FROM monitor_events ORDER BY sequence',
    )
    .all()
    .map(({ summary }) => summary);
}

function retryCount(client: BetterSQLiteClient): number {
  return (
    client
      .prepare<
        [],
        { n: number }
      >('SELECT count(*) AS n FROM materialization_retry_outbox')
      .get()?.n ?? 0
  );
}

function failSummary(
  client: BetterSQLiteClient,
  summary: string,
  message = `${summary} write failed`,
): void {
  client.exec(`CREATE TRIGGER fail_${summary}
    BEFORE INSERT ON monitor_events WHEN NEW.summary = '${summary}' BEGIN
    SELECT RAISE(ABORT, '${message}'); END;`);
}

function repair(client: BetterSQLiteClient, summary: string): void {
  client.exec(`DROP TRIGGER fail_${summary}`);
}

type Clock = ReturnType<typeof stubClock>;
type Opened = ReturnType<ReturnType<typeof setup>['open']>;

/**
 * Admit the first span with `A` failing, then tick past every backoff step
 * until its retry is terminal. Returns the terminal retry's id.
 */
async function retainTerminal(
  f: ReturnType<typeof setup>,
  opened: Opened,
  clock: Clock,
  lastError?: string,
): Promise<string> {
  failSummary(opened.client, 'A', lastError);
  await opened.runtime.tick(f.monitorsDir, f.root);
  for (let tick = 0; tick < MATERIALIZATION_RETRY_MAX_ATTEMPTS; tick += 1) {
    clock.advance(600_000);
    await opened.runtime.tick(f.monitorsDir, f.root);
  }
  const [retry] = opened.store.listMaterializationRetries({ monitorId: 'm' });
  expect(retry?.status).toBe('terminal');
  return retry?.id ?? '';
}

describe('a terminal retry pauses its monitor until it is repaired', () => {
  let clock: Clock;
  beforeEach(() => {
    clock = stubClock(T0);
  });

  it('names both repairs in the tick report and in explain', async () => {
    const f = setup([['A'], ['B']]);
    const opened = f.open();
    const id = await retainTerminal(f, opened, clock);

    clock.advance(600_000);
    const tick = await opened.runtime.tick(f.monitorsDir, f.root);
    expect(tick.erroredObservations).toEqual([
      {
        monitorId: 'm',
        message: expect.stringContaining(
          `\`agentmonitors monitor retry rearm m ${id} --workspace ${f.root}\``,
        ),
      },
    ]);
    expect(tick.erroredObservations[0]?.message).toContain(
      `\`agentmonitors monitor retry skip m ${id} --workspace ${f.root}\``,
    );

    const explain = await opened.runtime.explainMonitor({
      monitorId: 'm',
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    const stage = explain.stages.find(({ id: s }) => s === 'materialization');
    expect(stage?.status).toBe('failure');
    expect(stage?.reason).toContain(
      `\`agentmonitors monitor retry rearm m ${id} --workspace ${f.root}\``,
    );
    expect(stage?.reason).toContain(
      `\`agentmonitors monitor retry skip m ${id} --workspace ${f.root}\``,
    );
  });
});

describe('re-arming a terminal retry', () => {
  let clock: Clock;
  beforeEach(() => {
    clock = stubClock(T0);
  });

  it('retries it, then takes later input in order', async () => {
    const f = setup([['A'], ['B']]);
    const opened = f.open();
    const id = await retainTerminal(f, opened, clock);
    repair(opened.client, 'A');

    const rearmed = opened.runtime.rearmMaterializationRetry({
      monitorId: 'm',
      retryId: id,
      workspacePath: f.root,
    });
    expect(rearmed).toEqual({
      outcome: 'rearmed',
      retry: {
        id,
        status: 'pending',
        attemptCount: 0,
        // 002 §15: re-arm schedules the initial delay again, rounded up.
        nextAttemptAt: expect.any(Date),
        lastError: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    });
    // The private envelope never leaves the runtime.
    expect(Object.keys(rearmed.retry)).not.toContain('envelope');

    clock.advance(2_000);
    const tick = await opened.runtime.tick(f.monitorsDir, f.root);
    expect(tick.erroredObservations).toEqual([]);
    expect(eventSummaries(opened.client)).toEqual(['A', 'B']);
    // The source was asked for B only once A was an event.
    expect(f.calls).toEqual([[], ['A']]);
    expect(retryCount(opened.client)).toBe(0);
  });

  it('keeps the monitor paused when the retried attempt fails again', async () => {
    const f = setup([['A'], ['B']]);
    const opened = f.open();
    const id = await retainTerminal(f, opened, clock);

    opened.runtime.rearmMaterializationRetry({
      monitorId: 'm',
      retryId: id,
      workspacePath: f.root,
    });
    clock.advance(2_000);
    const tick = await opened.runtime.tick(f.monitorsDir, f.root);

    expect(tick.erroredObservations).toEqual([
      { monitorId: 'm', message: expect.stringContaining('A write failed') },
    ]);
    const retry = opened.store.getMaterializationRetry(id);
    expect(retry).toMatchObject({ status: 'pending', attemptCount: 1 });
    expect(retry.lastError).toContain('A write failed');
    expect(eventSummaries(opened.client)).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  it('survives a restart between the re-arm and the retried attempt', async () => {
    const f = setup([['A'], ['B']]);
    const before = f.open();
    const id = await retainTerminal(f, before, clock);
    repair(before.client, 'A');
    before.runtime.rearmMaterializationRetry({
      monitorId: 'm',
      retryId: id,
      workspacePath: f.root,
    });
    before.client.close();

    const after = f.open();
    expect(after.store.getMaterializationRetry(id)).toMatchObject({
      status: 'pending',
      attemptCount: 0,
    });
    clock.advance(2_000);
    await after.runtime.tick(f.monitorsDir, f.root);
    expect(eventSummaries(after.client)).toEqual(['A', 'B']);
    expect(retryCount(after.client)).toBe(0);
  });
});

describe('skipping a terminal retry', () => {
  let clock: Clock;
  beforeEach(() => {
    clock = stubClock(T0);
  });

  it('records the observation as outstanding loss and resumes the monitor', async () => {
    const f = setup([['A'], ['B'], ['A2@A']]);
    const opened = f.open();
    const id = await retainTerminal(f, opened, clock);

    const skipped = opened.runtime.skipMaterializationRetry({
      monitorId: 'm',
      retryId: id,
      workspacePath: f.root,
      reason: 'upstream object deleted',
    });
    expect(skipped).toMatchObject({
      outcome: 'skipped',
      retry: { id, status: 'terminal' },
    });
    expect(retryCount(opened.client)).toBe(0);

    const expectedError = `A write failed Retry skipped after ${String(MATERIALIZATION_RETRY_MAX_ATTEMPTS)} failed attempts: upstream object deleted.`;
    const doctor = await opened.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.monitors[0]?.unretainedObservationLoss).toEqual({
      count: 1,
      recordedAt: expect.any(Date),
      error: expectedError,
      objectKey: 'A',
      title: 'A',
    });
    // 002 §2: the skip's row is a drop with its own marker and the removed
    // retry's id; it is neither an outbox drop nor a hold refusal, and the
    // retry outlived its span, so it has no span position.
    const [lossRow] = opened.store
      .listObservationHistory({ monitorId: 'm', workspacePath: f.root })
      .filter(({ result }) => result === 'errored');
    expect(lossRow?.observationData).toEqual({
      error: expectedError,
      skipped: true,
      retryId: id,
      objectKey: 'A',
      title: 'A',
    });
    const explain = await opened.runtime.explainMonitor({
      monitorId: 'm',
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(
      explain.stages.find(({ id: s }) => s === 'materialization'),
    ).toMatchObject({ status: 'failure' });

    // The monitor takes newer input on its next tick.
    clock.advance(600_000);
    const resumed = await opened.runtime.tick(f.monitorsDir, f.root);
    expect(resumed.erroredObservations).toEqual([]);
    expect(eventSummaries(opened.client)).toEqual(['B']);

    // An event for another object key does not supersede the loss.
    const stillLost = await opened.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(stillLost.monitors[0]?.unretainedObservationLoss?.error).toBe(
      expectedError,
    );

    // A later event for the skipped object key does.
    clock.advance(600_000);
    await opened.runtime.tick(f.monitorsDir, f.root);
    expect(eventSummaries(opened.client)).toEqual(['B', 'A2']);
    const superseded = await opened.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(superseded.monitors[0]?.unretainedObservationLoss).toBeUndefined();
  });

  it('refuses a reason longer than 200 characters and changes nothing', async () => {
    const f = setup([['A'], ['B']]);
    const opened = f.open();
    const id = await retainTerminal(f, opened, clock);
    const before = opened.store.getMaterializationRetry(id);

    // A 1,100-character reason used to crowd the last error out of the loss.
    for (const reason of ['r'.repeat(1_100), 'r'.repeat(SKIP_REASON_MAX + 1)]) {
      expect(() =>
        opened.runtime.skipMaterializationRetry({
          monitorId: 'm',
          retryId: id,
          workspacePath: f.root,
          reason,
        }),
      ).toThrow(
        new RangeError(
          `Skip reason is ${String(reason.length)} characters; at most 200 are allowed.`,
        ),
      );
    }
    expect(opened.store.getMaterializationRetry(id)).toEqual(before);
    const doctor = await opened.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.monitors[0]?.unretainedObservationLoss).toBeUndefined();
    expect(MATERIALIZATION_RETRY_SKIP_REASON_MAX_LENGTH).toBe(SKIP_REASON_MAX);
  });

  it('keeps the skip note and a full-length reason, shortening only a long last error', async () => {
    const f = setup([['A'], ['B']]);
    const opened = f.open();
    const lastError = 'E'.repeat(1_000);
    const id = await retainTerminal(f, opened, clock, lastError);
    expect(opened.store.getMaterializationRetry(id).lastError).toBe(lastError);

    // The bound counts trimmed characters, so surrounding space is free.
    const reason = 'r'.repeat(SKIP_REASON_MAX);
    opened.runtime.skipMaterializationRetry({
      monitorId: 'm',
      retryId: id,
      workspacePath: f.root,
      reason: `  ${reason}  `,
    });

    // 005 `monitor retry skip`: `<last error> Retry skipped after <n> failed
    // attempts: <reason>.`, within the 1,024-character diagnostic cap (002
    // `materialization_retry_outbox`); the last error gives way, ending in `…`.
    const note = ` Retry skipped after ${String(MATERIALIZATION_RETRY_MAX_ATTEMPTS)} failed attempts: ${reason}.`;
    const expectedError = `${'E'.repeat(1_024 - note.length - 1)}…${note}`;
    expect(expectedError).toHaveLength(1_024);
    const doctor = await opened.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.monitors[0]?.unretainedObservationLoss?.error).toBe(
      expectedError,
    );
  });

  it('lets younger retained work drain next, and lets it supersede the loss of its object key', async () => {
    // A fails, so A and its younger sibling A3 (same object) and C stay retained.
    const f = setup([['A', 'A3@A', 'C'], ['D']]);
    const opened = f.open();
    const id = await retainTerminal(f, opened, clock);
    expect(retryCount(opened.client)).toBe(3);

    opened.runtime.skipMaterializationRetry({
      monitorId: 'm',
      retryId: id,
      workspacePath: f.root,
    });
    clock.advance(600_000);
    await opened.runtime.tick(f.monitorsDir, f.root);

    // Retained work completes in admission order before D is observed.
    expect(eventSummaries(opened.client)).toEqual(['A3', 'C', 'D']);
    // A3 was admitted after A, so it carries newer state for the same key.
    const doctor = await opened.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.monitors[0]?.unretainedObservationLoss).toBeUndefined();
  });

  // A native fault on either write of the skip: the loss row, or the retry
  // row's removal. Whichever fails, the other must not commit without it.
  it.each([
    {
      write: 'the loss row',
      message: 'loss write failed',
      trigger: `CREATE TRIGGER fail_skip
        BEFORE INSERT ON observation_history
        WHEN NEW.unretained_event_watermark IS NOT NULL BEGIN
        SELECT RAISE(ABORT, 'loss write failed'); END;`,
    },
    {
      write: 'the retry removal',
      message: 'retry removal failed',
      trigger: `CREATE TRIGGER fail_skip
        BEFORE DELETE ON materialization_retry_outbox BEGIN
        SELECT RAISE(ABORT, 'retry removal failed'); END;`,
    },
  ])(
    'records the loss and removes the retry together, or neither, when $write fails',
    async ({ message, trigger }) => {
      const f = setup([['A'], ['B']]);
      const opened = f.open();
      const id = await retainTerminal(f, opened, clock);
      opened.client.exec(trigger);

      expect(() =>
        opened.runtime.skipMaterializationRetry({
          monitorId: 'm',
          retryId: id,
          workspacePath: f.root,
        }),
      ).toThrow(message);
      expect(opened.store.getMaterializationRetry(id).status).toBe('terminal');
      const doctor = await opened.runtime.doctorReport({
        monitorsDir: f.monitorsDir,
        workspacePath: f.root,
      });
      expect(doctor.monitors[0]?.unretainedObservationLoss).toBeUndefined();
      // The monitor stays paused behind the retry it could not skip.
      clock.advance(600_000);
      await opened.runtime.tick(f.monitorsDir, f.root);
      expect(eventSummaries(opened.client)).toEqual([]);
    },
  );

  it('keeps the loss and the resumed monitor across a restart', async () => {
    const f = setup([['A'], ['B']]);
    const before = f.open();
    const id = await retainTerminal(f, before, clock);
    before.runtime.skipMaterializationRetry({
      monitorId: 'm',
      retryId: id,
      workspacePath: f.root,
    });
    before.client.close();

    const after = f.open();
    const doctor = await after.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.monitors[0]?.unretainedObservationLoss).toMatchObject({
      count: 1,
      objectKey: 'A',
    });
    clock.advance(600_000);
    await after.runtime.tick(f.monitorsDir, f.root);
    expect(eventSummaries(after.client)).toEqual(['B']);
  });
});

describe('repairs refuse anything but a terminal retry of the named monitor', () => {
  let clock: Clock;
  beforeEach(() => {
    clock = stubClock(T0);
  });

  it('refuses a pending retry with a clear message and changes nothing', async () => {
    const f = setup([['A'], ['B']]);
    const opened = f.open();
    failSummary(opened.client, 'A');
    await opened.runtime.tick(f.monitorsDir, f.root);
    const [retry] = opened.store.listMaterializationRetries({ monitorId: 'm' });
    const input = {
      monitorId: 'm',
      retryId: retry?.id ?? '',
      workspacePath: f.root,
    };

    for (const repairRetry of [
      () => opened.runtime.rearmMaterializationRetry(input),
      () => opened.runtime.skipMaterializationRetry(input),
    ]) {
      expect(repairRetry).toThrow(MaterializationRetryTransitionError);
      expect(repairRetry).toThrow(
        /is pending, not terminal, so it cannot be (re-armed|skipped)\. It is still retried automatically \(0 of 5 attempts failed; next attempt at \d{4}-/,
      );
    }
    expect(opened.store.getMaterializationRetry(input.retryId)).toEqual(retry);
    const doctor = await opened.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.monitors[0]?.unretainedObservationLoss).toBeUndefined();
  });

  it('treats another monitor, another workspace or an unknown id as not found', async () => {
    const f = setup([['A'], ['B']]);
    const opened = f.open();
    const id = await retainTerminal(f, opened, clock);

    for (const input of [
      { monitorId: 'other', retryId: id, workspacePath: f.root },
      { monitorId: 'm', retryId: id, workspacePath: `${f.root}-elsewhere` },
      { monitorId: 'm', retryId: '01UNKNOWN', workspacePath: f.root },
    ]) {
      expect(() => opened.runtime.rearmMaterializationRetry(input)).toThrow(
        MaterializationRetryNotFoundError,
      );
      expect(() => opened.runtime.skipMaterializationRetry(input)).toThrow(
        MaterializationRetryNotFoundError,
      );
    }
    expect(opened.store.getMaterializationRetry(id).status).toBe('terminal');
  });
});

describe('a watcher paused on a terminal retry', () => {
  /**
   * Start a watcher whose first item `A` is retained, exhaust that retry and
   * wait until the watcher reports it terminal and pauses. Its periodic
   * recheck is a minute away, so anything sooner was a wake.
   */
  async function pausedWatcher(action?: 'skip' | 'rearm' | 'throw') {
    const root = mkdtempSync(path.join(tmpdir(), 'agentmon-retry-repair-'));
    tempRoots.push(root);
    const monitorsDir = path.join(root, 'monitors');
    writeMonitor(monitorsDir, 'w', 'repair-watch');
    const db = createDb(path.join(root, 'runtime.db'));
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    clients.push(client);
    const store = new RuntimeStore(db);
    const items = ['A', 'B'];
    const registry = new SourceRegistry();
    registry.register({
      name: 'repair-watch',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      // Resumes after its last checkpoint, like a real cursor-based watcher.
      async *watch(_config, context) {
        const after = (context.previousState as { after?: string } | undefined)
          ?.after;
        for (const summary of items.slice(
          after === undefined ? 0 : items.indexOf(after) + 1,
        )) {
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
        // A host may repair immediately when terminal work is reported.
        if (action && error.message.includes('stopped after')) {
          if (action === 'throw') throw new Error('host error handler failed');
          const retry = store.listMaterializationRetries({ monitorId: 'w' })[0];
          if (!retry) throw new Error('terminal retry missing');
          const input = {
            monitorId: 'w',
            retryId: retry.id,
            workspacePath: root,
          };
          if (action === 'skip') runtime.skipMaterializationRetry(input);
          else runtime.rearmMaterializationRetry(input);
        }
      },
    });
    try {
      // A is retained and the watcher waits out its first retry delay.
      let id = '';
      await vi.waitFor(
        () => {
          const [retry] = store.listMaterializationRetries({ monitorId: 'w' });
          expect(retry).toBeDefined();
          id = retry?.id ?? '';
        },
        { timeout: 5_000, interval: 10 },
      );
      // Exhaust it through the store's own lifecycle meanwhile; real backoff
      // would take minutes.
      for (
        let attempt = 0;
        attempt < MATERIALIZATION_RETRY_MAX_ATTEMPTS;
        attempt += 1
      ) {
        store.markMaterializationRetryFailed(id, 'A write failed');
      }
      repair(client, 'A');
      // The watcher finds the retry terminal, reports it once and pauses.
      await vi.waitFor(
        () => expect(errors.join('\n')).toContain('monitor retry rearm w'),
        { timeout: 5_000, interval: 20 },
      );
      if (!action) expect(eventSummaries(client)).toEqual([]);
      return { root, client, runtime, handle, id, errors };
    } catch (error) {
      await handle.stop();
      throw error;
    }
  }

  it('wakes when the retry is re-armed instead of waiting for its periodic recheck', async () => {
    const { root, client, runtime, handle, id } = await pausedWatcher();
    try {
      runtime.rearmMaterializationRetry({
        monitorId: 'w',
        retryId: id,
        workspacePath: root,
      });
      // Its periodic recheck is a minute away; the re-armed retry's first
      // delay is about a second, and B is pulled only after A.
      await vi.waitFor(
        () => expect(eventSummaries(client)).toEqual(['A', 'B']),
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await handle.stop();
    }
  }, 30_000);

  it('wakes when the retry is skipped instead of waiting for its periodic recheck', async () => {
    const { root, client, runtime, handle, id } = await pausedWatcher();
    try {
      runtime.skipMaterializationRetry({
        monitorId: 'w',
        retryId: id,
        workspacePath: root,
      });
      // Its periodic recheck is a minute away; with A given up and nothing
      // else retained, the woken watcher pulls B at once.
      await vi.waitFor(() => expect(eventSummaries(client)).toEqual(['B']), {
        timeout: 10_000,
        interval: 50,
      });
    } finally {
      await handle.stop();
    }
  }, 30_000);
  it.each(['skip', 'rearm'] as const)(
    'regression: synchronous onError %s cannot lose the repair wake',
    async (action) => {
      const { client, handle } = await pausedWatcher(action);
      try {
        // Allow only the re-arm's first backoff, far short of the terminal
        // minute. A lost wake leaves both actions with no events here.
        await vi.waitFor(
          () =>
            expect(eventSummaries(client)).toEqual(
              action === 'skip' ? ['B'] : ['A', 'B'],
            ),
          { timeout: 4_000, interval: 20 },
        );
        expect(retryCount(client)).toBe(0);
      } finally {
        await handle.stop();
      }
    },
  );

  it.each(['wake', 'stop', 'timeout', 'throw'] as const)(
    'releases the terminal wait timer on %s',
    async (exit) => {
      // Observe owned timers through the public watch lifecycle. Calling the
      // captured deadline lets timeout cleanup run without a minute-long sleep.
      const schedule = globalThis.setTimeout;
      let terminalTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: (() => void) | undefined;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (callback, ms, ...args) => {
          const timer = schedule(callback, ms, ...args);
          if (ms === 60_000) {
            terminalTimer = timer;
            deadline = () => callback(...args);
          }
          return timer;
        },
      );
      const clear = vi.spyOn(globalThis, 'clearTimeout');
      const { root, runtime, handle, id, errors } = await pausedWatcher(
        exit === 'throw' ? 'throw' : undefined,
      );
      try {
        const timer = terminalTimer;
        expect(timer).toBeDefined();
        if (exit === 'wake') {
          runtime.skipMaterializationRetry({
            monitorId: 'w',
            retryId: id,
            workspacePath: root,
          });
        } else if (exit === 'timeout') {
          deadline?.();
        } else if (exit === 'stop') {
          await handle.stop();
        } else {
          expect(errors).toContain('host error handler failed');
        }
        await vi.waitFor(() => expect(clear).toHaveBeenCalledWith(timer), {
          timeout: 1_000,
          interval: 10,
        });
      } finally {
        await handle.stop();
      }
    },
  );
});
