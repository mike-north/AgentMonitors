/**
 * Operator repair of a terminal retry whose observation is a verify artifact
 * with cleanup authority in effect (002 §2.7, §2.8). Dropping such a row is the
 * cleanup its owner asked for, not lost work, and no later event can ever
 * supersede a loss for its scratch key (every one is dropped). So both
 * repairs remove it through the ownership discard, record no loss and no
 * `errored` row, never re-arm it, and let the monitor resume.
 *
 * Every case uses a real runtime over an on-disk SQLite database; write
 * failures are real SQLite triggers on `monitor_events`, and terminal state is
 * reached through real ticks. The repair runs before any tick after cleanup,
 * and the write fault is left in place, so only the repair can remove the row.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2, §2.7, §2.8
 * @see ../../../../docs/specs/005-cli-reference.md `monitor retry`
 * @see https://www.sqlite.org/lang_createtrigger.html#raise
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import {
  MATERIALIZATION_RETRY_DELAYS_MS,
  MATERIALIZATION_RETRY_MAX_ATTEMPTS,
} from './types.js';

const md = String.raw;

const T0 = new Date('2026-08-13T18:00:00.100Z');
const MONITOR_ID = 'm';
const RUN = 'abcdef012345';
const OTHER_RUN = '0123456789ab';

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

/** One observed item: `summary` names it in assertions, `objectKey` is its identity. */
interface Item {
  summary: string;
  objectKey: string;
}

function observation(item: Item) {
  return {
    title: item.summary,
    summary: item.summary,
    objectKey: item.objectKey,
    snapshotText: `${item.summary}-state`,
  };
}

function writeMonitor(monitorsDir: string, type: string): void {
  mkdirSync(path.join(monitorsDir, MONITOR_ID), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, MONITOR_ID, 'MONITOR.md'),
    md`---
name: ${MONITOR_ID}
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

function openDb(root: string) {
  const db = createDb(path.join(root, 'runtime.db'));
  // The branded InboxDb hides the driver; tests inspect durable rows directly.
  const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
  clients.push(client);
  return { client, store: new RuntimeStore(db) };
}

/**
 * A poll fixture: each call emits the span at the source's persisted cursor
 * and advances it, so a call that never happens is an unconsumed span.
 */
function pollSetup(spansFor: (root: string) => Item[][]) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-repair-artifact-'));
  tempRoots.push(root);
  const spans = spansFor(root);
  const monitorsDir = path.join(root, 'monitors');
  writeMonitor(monitorsDir, 'artifact-poll');
  const { client, store } = openDb(root);
  let observeCalls = 0;
  const registry = new SourceRegistry();
  registry.register({
    name: 'artifact-poll',
    scopeSchema: { type: 'object' },
    stateful: true,
    observe(_config, context: ObservationContext): Promise<ObservationResult> {
      observeCalls += 1;
      const cursor =
        (context.previousState as { cursor?: number } | undefined)?.cursor ?? 0;
      return Promise.resolve({
        observations: (spans[cursor] ?? []).map(observation),
        nextState: { cursor: cursor + 1 },
      });
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  return {
    root,
    monitorsDir,
    client,
    store,
    runtime,
    observeCalls: () => observeCalls,
  };
}

type PollFixture = ReturnType<typeof pollSetup>;

function scratchKey(root: string, run: string): string {
  return path.join(root, 'logs', `agentmonitors-verify-${run}.md`);
}

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

function erroredHistoryCount(client: BetterSQLiteClient): number {
  return (
    client
      .prepare<
        [],
        { n: number }
      >("SELECT count(*) AS n FROM observation_history WHERE result = 'errored'")
      .get()?.n ?? 0
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

/** Register a run's artifact with an active owner session in `workspacePath`. */
function registerArtifact(
  runtime: AgentMonitorRuntime,
  workspacePath: string,
  run: string,
  objectKey: string,
) {
  const owner = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: `owner-${run}`,
      workspacePath,
    }),
  );
  runtime.registerVerifyArtifact({
    runId: run,
    ownerSessionId: owner.id,
    workspacePath,
    monitorId: MONITOR_ID,
    objectKey,
  });
}

/**
 * Admit `S` (the first span) with its write failing, then fail every
 * automatic attempt until its retry is terminal. Each step waits out exactly
 * one backoff, so a registered owner is still inside its dormancy window and
 * no authority is derived from inactivity. Returns the terminal retry's id.
 */
async function retainTerminal(
  f: PollFixture,
  clock: ReturnType<typeof stubClock>,
): Promise<string> {
  failSummary(f.client, 'S');
  await f.runtime.tick(f.monitorsDir, f.root);
  for (const delay of MATERIALIZATION_RETRY_DELAYS_MS) {
    clock.advance(delay + 1_000);
    await f.runtime.tick(f.monitorsDir, f.root);
  }
  const [retry] = f.store.listMaterializationRetries({ monitorId: MONITOR_ID });
  expect(retry?.status).toBe('terminal');
  expect(f.observeCalls()).toBe(1);
  return retry?.id ?? '';
}

/** Run one operator repair on the retry, as `monitor retry rearm|skip` does. */
function runRepair(f: PollFixture, action: 'rearm' | 'skip', retryId: string) {
  const input = { monitorId: MONITOR_ID, retryId, workspacePath: f.root };
  return action === 'rearm'
    ? f.runtime.rearmMaterializationRetry(input)
    : f.runtime.skipMaterializationRetry({ ...input, reason: 'gave up' });
}

describe('repairing a terminal retry for a retired verify artifact', () => {
  let clock: ReturnType<typeof stubClock>;
  beforeEach(() => {
    clock = stubClock(T0);
  });

  it.each(['skip', 'rearm'] as const)(
    '%s removes it as cleanup: no loss, no errored row, and the monitor resumes',
    async (action) => {
      const f = pollSetup((root) => [
        [{ summary: 'S', objectKey: scratchKey(root, RUN) }],
        [{ summary: 'B', objectKey: 'B' }],
      ]);
      registerArtifact(f.runtime, f.root, RUN, scratchKey(f.root, RUN));
      const id = await retainTerminal(f, clock);

      // Cleanup takes effect after the row turned terminal. No tick runs
      // before the repair, so the drain filter never sees the row.
      f.runtime.requestVerifyArtifactCleanup({ runId: RUN });
      const erroredBefore = erroredHistoryCount(f.client);

      const result = runRepair(f, action, id);

      // 002 §2.8: the drop is the cleanup, so neither repair re-arms it nor
      // records a loss, and the row is gone.
      expect(result).toEqual({
        outcome: 'verify-artifact-cleanup',
        retry: expect.objectContaining({
          id,
          status: 'terminal',
          attemptCount: MATERIALIZATION_RETRY_MAX_ATTEMPTS,
        }),
      });
      expect(retryCount(f.client)).toBe(0);
      expect(erroredHistoryCount(f.client)).toBe(erroredBefore);
      const doctor = await f.runtime.doctorReport({
        monitorsDir: f.monitorsDir,
        workspacePath: f.root,
      });
      expect(doctor.monitors[0]?.unretainedObservationLoss).toBeUndefined();
      expect(doctor.monitors[0]?.materializationRetries).toMatchObject({
        pending: 0,
        terminal: 0,
      });

      // The write fault is still in place, and the monitor resumes: newer
      // legitimate work arrives, and the scratch observation never does.
      clock.advance(2_000);
      const resumed = await f.runtime.tick(f.monitorsDir, f.root);
      expect(resumed.erroredObservations).toEqual([]);
      expect(eventSummaries(f.client)).toEqual(['B']);
      expect(f.observeCalls()).toBe(2);
      expect(erroredHistoryCount(f.client)).toBe(erroredBefore);
    },
  );

  /**
   * Controls: the rule is exact. Each retry below has no cleanup authority of
   * its own, so a skip records the loss and a re-arm re-arms, as for any
   * retry, even while another artifact's authority is in effect.
   */
  const controls = [
    {
      name: 'an unregistered scratch-looking key',
      key: (root: string) => scratchKey(root, OTHER_RUN),
      arrange: (f: PollFixture) => {
        registerArtifact(f.runtime, f.root, RUN, scratchKey(f.root, RUN));
        f.runtime.requestVerifyArtifactCleanup({ runId: RUN });
      },
    },
    {
      name: 'the same key registered and retired in a foreign workspace',
      key: (root: string) => scratchKey(root, RUN),
      arrange: (f: PollFixture) => {
        const foreign = path.join(f.root, 'foreign');
        mkdirSync(foreign);
        registerArtifact(f.runtime, foreign, RUN, scratchKey(f.root, RUN));
        f.runtime.requestVerifyArtifactCleanup({ runId: RUN });
      },
    },
    {
      name: 'a registered artifact still in its proof phase',
      key: (root: string) => scratchKey(root, RUN),
      arrange: (f: PollFixture) => {
        registerArtifact(f.runtime, f.root, RUN, scratchKey(f.root, RUN));
      },
    },
  ];

  it.each(controls)(
    'skip still records the loss for $name',
    async ({ key, arrange }) => {
      const f = pollSetup((root) => [
        [{ summary: 'S', objectKey: key(root) }],
        [{ summary: 'B', objectKey: 'B' }],
      ]);
      arrange(f);
      const id = await retainTerminal(f, clock);

      const result = runRepair(f, 'skip', id);

      expect(result.outcome).toBe('skipped');
      expect(retryCount(f.client)).toBe(0);
      const doctor = await f.runtime.doctorReport({
        monitorsDir: f.monitorsDir,
        workspacePath: f.root,
      });
      expect(doctor.monitors[0]?.unretainedObservationLoss).toMatchObject({
        count: 1,
        objectKey: key(f.root),
        error: expect.stringContaining(
          `Retry skipped after ${String(MATERIALIZATION_RETRY_MAX_ATTEMPTS)} failed attempts: gave up.`,
        ),
      });
    },
  );

  it.each(controls)('rearm still re-arms $name', async ({ key, arrange }) => {
    const f = pollSetup((root) => [
      [{ summary: 'S', objectKey: key(root) }],
      [{ summary: 'B', objectKey: 'B' }],
    ]);
    arrange(f);
    const id = await retainTerminal(f, clock);

    const result = runRepair(f, 'rearm', id);

    expect(result).toMatchObject({
      outcome: 'rearmed',
      retry: { id, status: 'pending', attemptCount: 0 },
    });
    expect(f.store.getMaterializationRetry(id)).toMatchObject({
      status: 'pending',
      attemptCount: 0,
    });
    // Once its fault is fixed it materializes, then newer input follows.
    repair(f.client, 'S');
    clock.advance(2_000);
    await f.runtime.tick(f.monitorsDir, f.root);
    expect(eventSummaries(f.client)).toEqual(['S', 'B']);
  });
});

describe('a watcher paused on a terminal retry for a retired verify artifact', () => {
  it('wakes when the retry is removed as cleanup and pulls newer input', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentmon-repair-artifact-'));
    tempRoots.push(root);
    const monitorsDir = path.join(root, 'monitors');
    writeMonitor(monitorsDir, 'artifact-watch');
    const { client, store } = openDb(root);
    const key = scratchKey(root, RUN);
    const registry = new SourceRegistry();
    registry.register({
      name: 'artifact-watch',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      // Resumes after its last checkpoint, like a real cursor-based watcher.
      async *watch(_config, context) {
        const items = [
          { summary: 'S', objectKey: key },
          { summary: 'B', objectKey: 'B' },
        ];
        const after = (context.previousState as { after?: string } | undefined)
          ?.after;
        const start =
          after === undefined
            ? 0
            : items.findIndex(({ summary }) => summary === after) + 1;
        for (const item of items.slice(start)) {
          yield {
            observations: [observation(item)],
            nextState: { after: item.summary },
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
    registerArtifact(runtime, root, RUN, key);
    failSummary(client, 'S');
    const errors: string[] = [];
    const handle = await runtime.watchMonitors(monitorsDir, root, {
      onError: (_id, error) => errors.push(error.message),
    });
    try {
      let id = '';
      await vi.waitFor(
        () => {
          const [retry] = store.listMaterializationRetries({
            monitorId: MONITOR_ID,
          });
          expect(retry).toBeDefined();
          id = retry?.id ?? '';
        },
        { timeout: 5_000, interval: 10 },
      );
      // Exhaust it through the store's own lifecycle; real backoff would take
      // minutes. The watcher then reports it terminal once and pauses.
      for (
        let attempt = 0;
        attempt < MATERIALIZATION_RETRY_MAX_ATTEMPTS;
        attempt += 1
      ) {
        store.markMaterializationRetryFailed(id, 'S write failed');
      }
      await vi.waitFor(
        () =>
          expect(errors.join('\n')).toContain(
            `monitor retry rearm ${MONITOR_ID}`,
          ),
        { timeout: 5_000, interval: 20 },
      );

      // Cleanup takes effect while the watcher is paused; its periodic
      // recheck is a minute away, so only the repair's wake resumes it.
      runtime.requestVerifyArtifactCleanup({ runId: RUN });
      const result = runtime.skipMaterializationRetry({
        monitorId: MONITOR_ID,
        retryId: id,
        workspacePath: root,
      });
      expect(result.outcome).toBe('verify-artifact-cleanup');
      await vi.waitFor(() => expect(eventSummaries(client)).toEqual(['B']), {
        timeout: 10_000,
        interval: 50,
      });
      expect(retryCount(client)).toBe(0);
    } finally {
      await handle.stop();
    }
  }, 30_000);
});
