/**
 * `monitor explain` attributes each `observation_history` row to the stage
 * that owns it (002 §10.7, 005 §6 `monitor explain`). Rows that record lost
 * observations (002 §2) or retained-work drain outcomes (002 §2.7) are
 * `errored` like a source failure, but they belong to Materialization: the
 * Observation stage must not report them as a failed source call. A genuine
 * source failure still fails the Observation stage.
 *
 * Regression for #591: the Observation stage read the newest history row,
 * whatever it recorded, so a skipped retry, a span whose only observations a
 * hold refused, a failed retry attempt or a terminal pause each read as
 * `Source observation failed: …` until the monitor's next tick.
 *
 * Faults are real SQLite triggers on `monitor_events`, and every row is
 * written by real ticks and repairs over an on-disk database.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2, §2.7, §4.7, §10.7
 * @see ../../../../docs/specs/005-cli-reference.md `monitor explain`
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
import type { Observation, ObservationSource } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import {
  MATERIALIZATION_RETRY_MAX_ATTEMPTS,
  type MonitorExplainReport,
} from './types.js';

const md = String.raw;

const T0 = new Date('2026-08-13T18:00:00.100Z');
const MONITOR_ID = 'm';

/**
 * Observation-stage reasons, written from 005 §6 `monitor explain`
 * ("Which history rows each stage reads").
 */
const RETAINED_WORK_PAUSE =
  'The source is not called while retained materialization work remains (002 §2.7); the Materialization stage reports that work.';
const ADMISSION_LOSS =
  'The source’s latest call returned observations the runtime could not keep; the Materialization stage reports the loss.';
const SKIPPED_RETRY =
  'No source outcome has been recorded since a terminal retry was skipped; the Materialization stage reports the loss, and the source is called again on the monitor’s next due tick.';

const roots: string[] = [];
const clients: BetterSQLiteClient[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const client of clients.splice(0)) if (client.open) client.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Drive the runtime's clock without fake timers: retry envelopes require a
 * genuine Date instance, so only the zero-argument constructor and `now()`
 * are redirected.
 */
let clockTime = T0.getTime();
beforeEach(() => {
  clockTime = T0.getTime();
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

/** One source call: the observations it returns, or the error it throws. */
type Call = Observation[] | Error;

/**
 * One monitor `m` over an on-disk database and a stateful cursor source:
 * each call answers `calls[cursor]` and advances the cursor, so a call the
 * runtime skips while the monitor is paused leaves its entry unconsumed. A
 * thrown error leaves the cursor in place, as a failed call persists nothing.
 */
function fixture(calls: Call[], notify = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'explain-history-stages-'));
  roots.push(root);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(path.join(monitorsDir, MONITOR_ID), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, MONITOR_ID, 'MONITOR.md'),
    md`---
name: ${MONITOR_ID}
watch:
  type: stage-source
  interval: 1s
urgency: normal
${notify}---
Handle it.
`,
    'utf8',
  );
  const source: ObservationSource = {
    name: 'stage-source',
    scopeSchema: {
      type: 'object',
      properties: { interval: { type: 'string' } },
    },
    stateful: true,
    observe(_config, context) {
      const cursor =
        (context.previousState as { cursor?: number } | undefined)?.cursor ?? 0;
      const call = calls[cursor] ?? [];
      if (call instanceof Error) return Promise.reject(call);
      return Promise.resolve({
        observations: call,
        nextState: { cursor: cursor + 1 },
      });
    },
  };
  const db = createDb(path.join(root, 'runtime.db'));
  // The branded InboxDb hides the driver; tests install faults with native SQL.
  const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
  clients.push(client);
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  registry.register(source);
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  return {
    root,
    store,
    runtime,
    /** Advance past every backoff step and the poll interval, then tick. */
    async tick(ms = 600_000) {
      clockTime += ms;
      return runtime.tick(monitorsDir, root);
    },
    explain(): Promise<MonitorExplainReport> {
      return runtime.explainMonitor({
        monitorsDir,
        monitorId: MONITOR_ID,
        workspacePath: root,
      });
    },
    /** Make every `monitor_events` insert of `summary` abort. */
    failSummary(summary: string, message = `${summary} write failed`) {
      client.exec(`CREATE TRIGGER fail_${summary}
        BEFORE INSERT ON monitor_events WHEN NEW.summary = '${summary}' BEGIN
        SELECT RAISE(ABORT, '${message}'); END;`);
    },
    /**
     * Record a history row whose `result` this version does not know, newer
     * than every other row, as a newer writer could leave behind.
     */
    recordUnknownOutcome() {
      client
        .prepare(
          `INSERT INTO observation_history
             (id, monitor_id, workspace_path, source_name, observation_data, result, created_at)
           VALUES ('ZZZZZZZZZZZZZZZZZZZZZZZZZZ', ?, ?, 'stage-source', '{}', 'deferred', ?)`,
        )
        .run(MONITOR_ID, root, Math.ceil(clockTime / 1_000) + 1);
    },
    /** Remove the fault {@link failSummary} installed for `summary`. */
    repairSummary(summary: string) {
      client.exec(`DROP TRIGGER fail_${summary}`);
    },
    oldestRetry() {
      return store.listMaterializationRetries({
        monitorId: MONITOR_ID,
        workspacePath: root,
      })[0];
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

const obs = (
  title: string,
  payload?: Record<string, unknown>,
): Observation => ({
  title,
  summary: title,
  objectKey: title,
  snapshotText: `${title}-state`,
  ...(payload ? { payload } : {}),
});

function stage(report: MonitorExplainReport, id: string) {
  const found = report.stages.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`explain reported no ${id} stage`);
  return found;
}

/** Admit `A` while its event write fails, so its retry is retained (002 §2). */
async function retainA(f: Fixture) {
  f.failSummary('A');
  await f.tick();
  expect(f.oldestRetry()?.status).toBe('pending');
}

/** Tick until `A`'s retry has used every automatic attempt (002 §2.7). */
async function exhaustA(f: Fixture) {
  for (let tick = 0; tick < MATERIALIZATION_RETRY_MAX_ATTEMPTS; tick += 1) {
    await f.tick();
  }
  expect(f.oldestRetry()?.status).toBe('terminal');
}

describe('explain attributes history rows to the stage that owns them (#591)', () => {
  it('a genuine source failure fails the Observation stage', async () => {
    const f = fixture([new Error('upstream is down')]);
    await f.tick();

    const report = await f.explain();
    // 005 §6: an errored observation's reason is `Source observation failed: <error>`.
    expect(stage(report, 'observation')).toMatchObject({
      status: 'failure',
      reason: 'Source observation failed: upstream is down',
    });
    expect(report.verdict).toMatchObject({
      stage: 'observation',
      status: 'failure',
    });
  });

  it('a skipped terminal retry, explained right after the skip, is a Materialization loss', async () => {
    const f = fixture([[obs('A')], [obs('B')]]);
    await retainA(f);
    await exhaustA(f);
    const retryId = f.oldestRetry()?.id ?? '';
    f.runtime.skipMaterializationRetry({
      monitorId: MONITOR_ID,
      workspacePath: f.root,
      retryId,
    });

    const report = await f.explain();
    // 002 §10.7: no source failed. The source has not been called since the
    // retry was retained, and the skip's row is a drop (002 §2).
    expect(stage(report, 'observation')).toMatchObject({
      status: 'ok',
      reason: SKIPPED_RETRY,
    });
    const materialization = stage(report, 'materialization');
    expect(materialization.status).toBe('failure');
    // 002 §2: a skipped retry's loss error ends in `Retry skipped after <n> failed attempts.`
    expect(materialization.reason).toContain(
      `Retry skipped after ${String(MATERIALIZATION_RETRY_MAX_ATTEMPTS)} failed attempts.`,
    );
    expect(report.verdict).toMatchObject({
      stage: 'materialization',
      status: 'failure',
    });
  });

  it('a span whose only observations a hold refused is a Materialization loss', async () => {
    const f = fixture(
      [[obs('Bad', { count: 10n })]],
      'notify:\n  strategy: debounce\n  settle-for: 10s\n',
    );
    const tick = await f.tick();
    expect(tick.erroredObservations).toHaveLength(1);

    const report = await f.explain();
    // The source call succeeded; its only observation was refused (002 §4.7).
    expect(stage(report, 'observation')).toMatchObject({
      status: 'ok',
      reason: ADMISSION_LOSS,
    });
    const materialization = stage(report, 'materialization');
    expect(materialization.status).toBe('failure');
    // 002 §4.7: the refusal's outcome names the observation and the hold.
    expect(materialization.reason).toContain(
      'Observation "Bad" was not held for debounce',
    );
    expect(report.verdict).toMatchObject({
      stage: 'materialization',
      status: 'failure',
    });
  });

  it('a failed retry attempt is reported by Materialization with its error', async () => {
    const f = fixture([[obs('A')], [obs('B')]]);
    await retainA(f);
    // One drain attempt, which fails the same way and records its `errored` row.
    await f.tick();
    expect(f.oldestRetry()?.attemptCount).toBe(1);

    const report = await f.explain();
    expect(stage(report, 'observation')).toMatchObject({
      status: 'ok',
      reason: RETAINED_WORK_PAUSE,
    });
    // 005 §6: retained work is pending, with the oldest retry's last error.
    expect(stage(report, 'materialization')).toMatchObject({
      status: 'pending',
      reason:
        '1 observation(s) are durably queued for materialization retry. Last error: A write failed',
    });
    expect(report.verdict).toMatchObject({
      stage: 'materialization',
      status: 'pending',
    });
  });

  it('a monitor paused behind a terminal retry is reported by Materialization', async () => {
    const f = fixture([[obs('A')], [obs('B')]]);
    await retainA(f);
    await exhaustA(f);
    // A paused tick writes the terminal report's `errored` row (002 §2.7).
    await f.tick();
    const retryId = f.oldestRetry()?.id ?? '';

    const report = await f.explain();
    expect(stage(report, 'observation')).toMatchObject({
      status: 'ok',
      reason: RETAINED_WORK_PAUSE,
    });
    const materialization = stage(report, 'materialization');
    expect(materialization.status).toBe('failure');
    expect(materialization.reason).toContain(
      `\`agentmonitors monitor retry skip --workspace ${f.root} -- ${MONITOR_ID} ${retryId}\``,
    );
    expect(materialization.reason).toContain('Last error: A write failed');
    expect(report.verdict).toMatchObject({
      stage: 'materialization',
      status: 'failure',
    });
  });

  it('a newest triggered row with observed 0 reads as released work, not as a missing observation', async () => {
    const f = fixture([[obs('A')]]);
    await f.tick();
    // The row a drained retry or a held flush records (002 §2.6, §2.7): work
    // materialized without new source input.
    f.store.recordObservationHistory({
      monitorId: MONITOR_ID,
      workspacePath: f.root,
      sourceName: 'stage-source',
      result: 'triggered',
      observationData: { observed: 0, emitted: 1 },
    });

    const report = await f.explain();
    expect(stage(report, 'observation')).toMatchObject({
      status: 'ok',
      reason:
        'Held or retained work was materialized without new source input (observed 0).',
    });
    expect(stage(report, 'materialization').status).toBe('ok');
  });

  it('a source failure after retained work drained still fails the Observation stage', async () => {
    const f = fixture([[obs('A')], new Error('upstream is down')]);
    await retainA(f);
    // Repair the fault: the next tick drains the retry, then calls the source.
    f.repairSummary('A');
    await f.tick();
    expect(f.oldestRetry()).toBeUndefined();

    const report = await f.explain();
    expect(stage(report, 'observation')).toMatchObject({
      status: 'failure',
      reason: 'Source observation failed: upstream is down',
    });
  });

  it('a source failure in the tick whose held flush retained work still fails the Observation stage (002 §2.6)', async () => {
    const f = fixture(
      [[obs('A')], new Error('upstream is down')],
      'notify:\n  strategy: debounce\n  settle-for: 10s\n',
    );
    // `A` waits in the debounce batch.
    await f.tick(2_000);
    // The next due tick's source call fails, so the held batch flushes
    // (002 §2.6); the flush's write fails and retains `A`. The source's
    // `errored` row is written after the flush.
    f.failSummary('A');
    const failed = await f.tick(30_000);
    expect(failed.erroredObservations.map(({ message }) => message)).toEqual(
      expect.arrayContaining(['upstream is down', 'A write failed']),
    );
    expect(f.oldestRetry()?.status).toBe('pending');

    const report = await f.explain();
    // 002 §2.6: "the newest history row, and monitor explain's observation
    // stage (§10.7), still report the failing source".
    expect(stage(report, 'observation')).toMatchObject({
      status: 'failure',
      reason: 'Source observation failed: upstream is down',
    });
    expect(report.verdict).toMatchObject({
      stage: 'observation',
      status: 'failure',
    });
    expect(stage(report, 'materialization')).toMatchObject({
      status: 'pending',
      reason:
        '1 observation(s) are durably queued for materialization retry. Last error: A write failed',
    });
  });

  it('that source failure still fails the Observation stage after a later retry attempt fails', async () => {
    const f = fixture(
      [[obs('A')], new Error('upstream is down')],
      'notify:\n  strategy: debounce\n  settle-for: 10s\n',
    );
    await f.tick(2_000);
    f.failSummary('A', 'A write failed again');
    await f.tick(30_000);
    // The next tick only drains (002 §2.7): its attempt fails the same way and
    // records a drain report; the source is not called.
    await f.tick();
    expect(f.oldestRetry()?.attemptCount).toBe(1);

    const report = await f.explain();
    expect(stage(report, 'observation')).toMatchObject({
      status: 'failure',
      reason: 'Source observation failed: upstream is down',
    });
  });

  it('the span that retained work is not read as a source failure before any retry attempt', async () => {
    const f = fixture([[obs('A')], [obs('B')]]);
    await retainA(f);
    expect(f.oldestRetry()?.attemptCount).toBe(0);

    const report = await f.explain();
    // The newest row is the span's own materialization failure (002 §2), not
    // a source call: the source returned `A`.
    expect(stage(report, 'observation')).toMatchObject({
      status: 'ok',
      reason: RETAINED_WORK_PAUSE,
    });
    expect(report.verdict).toMatchObject({
      stage: 'materialization',
      status: 'pending',
    });
  });

  it('Observation skips a newer row with an outcome this version does not know', async () => {
    const f = fixture([[]]);
    await f.tick();
    f.recordUnknownOutcome();

    const report = await f.explain();
    // 005 §6: Observation reads the newest row that is not unrecognized; here
    // the quiet tick's `no-change` row.
    expect(stage(report, 'observation')).toMatchObject({
      status: 'healthy',
      reason:
        'Source ran, observed 0 changes — your watched target genuinely hasn’t changed (not a bug).',
    });
  });

  it('Observation is pending when every row has an outcome this version does not know', async () => {
    const f = fixture([]);
    f.recordUnknownOutcome();

    const report = await f.explain();
    expect(stage(report, 'observation')).toMatchObject({
      status: 'pending',
      reason:
        'No recent observation history row records an outcome this version recognizes.',
    });
  });
});
