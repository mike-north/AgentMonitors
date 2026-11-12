/**
 * Retained materialization work for a verify artifact is dropped, not
 * drained, once the artifact's cleanup authority is in effect (002 §2.7,
 * §2.8; issue #562). A retry row is held emission that was admitted before
 * authority took effect: retraction removes only events, so without this
 * boundary the retained scratch observation would materialize after cleanup
 * and reach a later lead session. The drop runs before the drain's terminal
 * and backoff checks, so a dropped row never holds back newer legitimate work.
 *
 * Every case uses a real runtime over an on-disk SQLite database. Write
 * failures are real SQLite triggers on `monitor_events`, which leave the
 * observation in the retry outbox exactly as a production failure does.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2.7, §2.8, §15 `materialization_retry_outbox`
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
import { MATERIALIZATION_RETRY_DELAYS_MS } from './types.js';

const md = String.raw;

/** Admission time of the first span; retry backoff is measured from here. */
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
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-artifact-retry-'));
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

/** Summaries of the events projected into one session. */
function projectedSummaries(
  client: BetterSQLiteClient,
  sessionId: string,
): string[] {
  return client
    .prepare<[string], { summary: string }>(
      `SELECT e.summary AS summary FROM session_event_state s
       JOIN monitor_events e ON e.id = s.event_id
       WHERE s.session_id = ? ORDER BY e.sequence`,
    )
    .all(sessionId)
    .map(({ summary }) => summary);
}

function failSummary(client: BetterSQLiteClient, summary: string): void {
  client.exec(`CREATE TRIGGER fail_${summary}
    BEFORE INSERT ON monitor_events WHEN NEW.summary = '${summary}' BEGIN
    SELECT RAISE(ABORT, '${summary} write failed'); END;`);
}

function repair(client: BetterSQLiteClient, summary: string): void {
  client.exec(`DROP TRIGGER fail_${summary}`);
}

function openSession(
  runtime: AgentMonitorRuntime,
  workspacePath: string,
  hostSessionId: string,
) {
  return runtime.openSession(
    claudeCodeAdapter.createSessionInput({ hostSessionId, workspacePath }),
  );
}

/** Register a run's artifact with an active owner session in `workspacePath`. */
function registerArtifact(
  runtime: AgentMonitorRuntime,
  workspacePath: string,
  run: string,
  objectKey: string,
) {
  const owner = openSession(runtime, workspacePath, `owner-${run}`);
  runtime.registerVerifyArtifact({
    runId: run,
    ownerSessionId: owner.id,
    workspacePath,
    monitorId: MONITOR_ID,
    objectKey,
  });
  return owner;
}

describe('the tick drain drops retained work for a retired verify artifact', () => {
  let clock: ReturnType<typeof stubClock>;
  beforeEach(() => {
    clock = stubClock(T0);
  });

  it('drops a retained retry whose cleanup took effect after it was queued; later input proceeds', async () => {
    const f = pollSetup((root) => [
      [{ summary: 'S', objectKey: scratchKey(root, RUN) }],
      [{ summary: 'B', objectKey: 'B' }],
    ]);
    registerArtifact(f.runtime, f.root, RUN, scratchKey(f.root, RUN));
    failSummary(f.client, 'S');

    // The scratch observation is admitted while the owner is in its proof
    // phase, and its write fails: it is retained in the outbox.
    await f.runtime.tick(f.monitorsDir, f.root);
    expect(retryCount(f.client)).toBe(1);
    expect(eventSummaries(f.client)).toEqual([]);

    // Cleanup authority takes effect after the row was queued. The write
    // fault is repaired, so only the drain filter keeps it from materializing.
    f.runtime.requestVerifyArtifactCleanup({ runId: RUN });
    repair(f.client, 'S');
    const later = openSession(f.runtime, f.root, 'later');
    const erroredBefore = erroredHistoryCount(f.client);

    clock.advance(2_000);
    const result = await f.runtime.tick(f.monitorsDir, f.root);

    expect(eventSummaries(f.client)).toEqual(['B']);
    expect(projectedSummaries(f.client, later.id)).toEqual(['B']);
    expect(retryCount(f.client)).toBe(0);
    // The drop is the requested cleanup: nothing is reported or recorded.
    expect(result.erroredObservations).toEqual([]);
    expect(result.skippedMonitors).toEqual([]);
    expect(erroredHistoryCount(f.client)).toBe(erroredBefore);
    expect(f.observeCalls()).toBe(2);
  });

  it('a terminal retry for a retired artifact no longer pauses its monitor', async () => {
    const f = pollSetup((root) => [
      [{ summary: 'S', objectKey: scratchKey(root, RUN) }],
      [{ summary: 'B', objectKey: 'B' }],
    ]);
    registerArtifact(f.runtime, f.root, RUN, scratchKey(f.root, RUN));
    failSummary(f.client, 'S');

    // Fail every automatic attempt until the retry is terminal; the monitor
    // stays paused behind it and its source is asked only once. Each step
    // waits out exactly one backoff, so the owner (about 8 minutes in) is
    // still well inside its dormancy window and authority is not yet derived.
    await f.runtime.tick(f.monitorsDir, f.root);
    for (const delay of MATERIALIZATION_RETRY_DELAYS_MS) {
      clock.advance(delay + 1_000);
      await f.runtime.tick(f.monitorsDir, f.root);
    }
    const [retry] = f.store.listMaterializationRetries({
      monitorId: MONITOR_ID,
    });
    expect(retry?.status).toBe('terminal');
    expect(f.observeCalls()).toBe(1);

    // The fault is left in place: only the drop can unblock the monitor.
    f.runtime.requestVerifyArtifactCleanup({ runId: RUN });
    const erroredBefore = erroredHistoryCount(f.client);
    const result = await f.runtime.tick(f.monitorsDir, f.root);

    expect(retryCount(f.client)).toBe(0);
    expect(eventSummaries(f.client)).toEqual(['B']);
    expect(result.erroredObservations).toEqual([]);
    expect(erroredHistoryCount(f.client)).toBe(erroredBefore);
    expect(f.observeCalls()).toBe(2);
  });

  /**
   * Controls: the drop is exact. Each retained retry below has no cleanup
   * authority of its own, so it drains and materializes normally, even when
   * another artifact's authority is in effect.
   */
  it.each([
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
      name: 'a real path beside a retired artifact',
      key: (root: string) => path.join(root, 'notes.md'),
      arrange: (f: PollFixture) => {
        registerArtifact(f.runtime, f.root, RUN, scratchKey(f.root, RUN));
        f.runtime.requestVerifyArtifactCleanup({ runId: RUN });
      },
    },
    {
      name: 'a registered artifact whose authority is not yet in effect',
      key: (root: string) => scratchKey(root, RUN),
      arrange: (f: PollFixture) => {
        // The owner is active and has not requested cleanup: proof phase.
        registerArtifact(f.runtime, f.root, RUN, scratchKey(f.root, RUN));
      },
    },
  ])(
    'still materializes a retained retry for $name',
    async ({ key, arrange }) => {
      const f = pollSetup((root) => [
        [{ summary: 'S', objectKey: key(root) }],
        [{ summary: 'B', objectKey: 'B' }],
      ]);
      failSummary(f.client, 'S');
      await f.runtime.tick(f.monitorsDir, f.root);
      expect(retryCount(f.client)).toBe(1);

      arrange(f);
      repair(f.client, 'S');
      clock.advance(2_000);
      await f.runtime.tick(f.monitorsDir, f.root);

      expect(eventSummaries(f.client)).toEqual(['S', 'B']);
      expect(retryCount(f.client)).toBe(0);
    },
  );
});

describe('the watcher drain drops retained work for a retired verify artifact', () => {
  it('drops the retired retry before its next pull, then pulls newer input', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentmon-artifact-retry-'));
    tempRoots.push(root);
    const monitorsDir = path.join(root, 'monitors');
    writeMonitor(monitorsDir, 'artifact-watch');
    const { client, store } = openDb(root);
    const key = scratchKey(root, RUN);
    const pulls: string[][] = [];
    const registry = new SourceRegistry();
    registry.register({
      name: 'artifact-watch',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
      async *watch(_config, context) {
        for (const item of [
          { summary: 'S', objectKey: key },
          { summary: 'B', objectKey: 'B' },
        ]) {
          pulls.push(eventSummaries(client));
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
    let cleanedUp = false;
    const handle = await runtime.watchMonitors(monitorsDir, root, {
      onError: () => {
        // Once S is durably retained, cleanup takes effect and the write
        // fault is repaired, before the watcher's next drain attempt.
        if (!cleanedUp && retryCount(client) === 1) {
          cleanedUp = true;
          runtime.requestVerifyArtifactCleanup({ runId: RUN });
          repair(client, 'S');
        }
      },
    });
    try {
      await vi.waitFor(() => expect(eventSummaries(client)).toEqual(['B']), {
        timeout: 10_000,
        interval: 50,
      });
      expect(cleanedUp).toBe(true);
      expect(retryCount(client)).toBe(0);
      // B was pulled only after the outbox emptied, and S never materialized.
      expect(pulls).toEqual([[], []]);
    } finally {
      await handle.stop();
    }
    expect(eventSummaries(client)).toEqual(['B']);
  }, 20_000);
});

describe('the outbox discard re-checks authority itself', () => {
  it('leaves a retry untouched when its artifact has no cleanup authority', async () => {
    stubClock(T0);
    const f = pollSetup((root) => [
      [{ summary: 'S', objectKey: scratchKey(root, RUN) }],
    ]);
    registerArtifact(f.runtime, f.root, RUN, scratchKey(f.root, RUN));
    failSummary(f.client, 'S');
    await f.runtime.tick(f.monitorsDir, f.root);
    const [retry] = f.store.listMaterializationRetries({
      monitorId: MONITOR_ID,
    });
    expect(retry).toBeDefined();

    // Proof phase: authority is not in effect, so the store refuses.
    expect(f.store.discardRetiredVerifyArtifactRetry(retry?.id ?? '')).toBe(
      false,
    );
    expect(retryCount(f.client)).toBe(1);

    f.runtime.requestVerifyArtifactCleanup({ runId: RUN });
    expect(f.store.discardRetiredVerifyArtifactRetry(retry?.id ?? '')).toBe(
      true,
    );
    expect(retryCount(f.client)).toBe(0);
    // A second discard finds nothing to remove.
    expect(f.store.discardRetiredVerifyArtifactRetry(retry?.id ?? '')).toBe(
      false,
    );
  });
});
