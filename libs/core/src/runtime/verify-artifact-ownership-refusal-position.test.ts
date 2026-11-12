/**
 * A hold refusal's place in its span (002 §2, §4.7) counts only the envelopes
 * that survive the verify-artifact ownership filter (002 §2.8; issue #562).
 *
 * Notify dispatch notes how many emitted envelopes precede each refusal, so
 * admission can record the refusal's loss between its older and newer
 * siblings. Admission then drops a held verify artifact whose cleanup
 * authority took effect while it waited. Counted against the unfiltered list,
 * the refusal would be recorded one place late for every dropped artifact
 * before it: after a newer event of its own key, which then no longer
 * supersedes it, so `doctor` and `explain` would report it as outstanding
 * loss when it is not.
 *
 * Every case uses a real runtime over an on-disk SQLite database and a real
 * debounce hold; the refused payload is one `JSON.stringify` rejects.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2, §2.8, §4.1, §4.7
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#exceptions
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
  Observation,
  ObservationContext,
  ObservationResult,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const md = String.raw;

const START = new Date('2026-08-13T18:00:00.000Z');
const MONITOR_ID = 'm';
const RUN = 'abcdef012345';

const tempRoots: string[] = [];
const clients: BetterSQLiteClient[] = [];

/**
 * Drive the runtime's clock without fake timers: stored envelopes require a
 * genuine Date instance, so only the zero-argument constructor and `now()`
 * are redirected.
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
  for (const client of clients.splice(0)) if (client.open) client.close();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The scratch file a verify run with token `run` creates in `root`. */
function scratchKey(root: string, run: string): string {
  return path.join(root, 'logs', `agentmonitors-verify-${run}.md`);
}

/**
 * A debounce monitor whose band lets source salience escalate an observation
 * (002 §4.1), over a cursor-driven source: each call reports the span at the
 * persisted cursor and advances it. `spansFor` receives the workspace root so
 * a span can name the run's scratch key.
 */
function setup(spansFor: (root: string) => Observation[][]) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-refusal-position-'));
  tempRoots.push(root);
  const spans = spansFor(root);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(path.join(monitorsDir, MONITOR_ID), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, MONITOR_ID, 'MONITOR.md'),
    md`---
name: ${MONITOR_ID}
watch:
  type: cursor-source
  interval: 1s
urgency: normal..high
baseline-strategy: incremental
notify:
  strategy: debounce
  settle-for: 10s
---
Handle it.
`,
    'utf8',
  );
  const db = createDb(path.join(root, 'runtime.db'));
  // The branded InboxDb hides the driver; tests read durable rows directly.
  const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
  clients.push(client);
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  registry.register({
    name: 'cursor-source',
    scopeSchema: { type: 'object' },
    stateful: true,
    observe(_config, context: ObservationContext): Promise<ObservationResult> {
      const cursor =
        (context.previousState as { cursor?: number } | undefined)?.cursor ?? 0;
      return Promise.resolve({
        observations: spans[cursor] ?? [],
        nextState: { cursor: cursor + 1 },
      });
    },
  });
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  const lead = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  // The run's artifact, registered with an active owner before it is observed.
  const owner = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: `owner-${RUN}`,
      workspacePath: root,
    }),
  );
  runtime.registerVerifyArtifact({
    runId: RUN,
    ownerSessionId: owner.id,
    workspacePath: root,
    monitorId: MONITOR_ID,
    objectKey: scratchKey(root, RUN),
  });
  return {
    /** Advance past the poll interval, inside the settle window, and tick. */
    tick() {
      clockTime += 2_000;
      return runtime.tick(monitorsDir, root);
    },
    requestCleanup() {
      runtime.requestVerifyArtifactCleanup({ runId: RUN });
    },
    heldTitles: () =>
      (
        store.getMonitorState(MONITOR_ID, root).notifyState.pendingDebounce
          ?.observations ?? []
      ).map((envelope) => envelope.observation.title),
    eventTitles: () =>
      store
        .listEvents({ sessionId: lead.id })
        .reverse()
        .map((event) => event.summary),
    async doctorLoss() {
      const report = await runtime.doctorReport({
        monitorsDir,
        workspacePath: root,
      });
      return report.monitors[0]?.unretainedObservationLoss;
    },
    async materializationStatus() {
      const report = await runtime.explainMonitor({
        monitorsDir,
        monitorId: MONITOR_ID,
        workspacePath: root,
      });
      return report.stages.find((stage) => stage.id === 'materialization')
        ?.status;
    },
  };
}

/** A plain observation of `key`, summarized by its title. */
const obs = (title: string, key: string): Observation => ({
  title,
  summary: title,
  objectKey: key,
  snapshotText: title,
});
/** An escalated observation: it flushes the held debounce batch (002 §4.1). */
const escalated = (title: string, key: string): Observation => ({
  ...obs(title, key),
  salience: 'high',
});
/** An observation no hold accepts, so it is refused (002 §4.7). */
const unserializable = (title: string, key: string): Observation => ({
  ...obs(title, key),
  payload: { count: 10n },
});

const refusal = (title: string) =>
  expect.stringMatching(
    new RegExp(`^Observation "${title}" was not held for debounce:`, 'u'),
  );

describe('a hold refusal behind a filtered verify artifact keeps its place (#562, #575)', () => {
  it('a newer sibling of its key, after a filtered artifact, supersedes the refusal', async () => {
    const f = setup((root) => [
      [obs('S', scratchKey(root, RUN))],
      // Bad is refused while S is held, then the escalated K2 flushes
      // [S, K2]. S is dropped, so K2 is the first kept envelope and the
      // refusal belongs before it.
      [unserializable('Bad', 'K'), escalated('K2', 'K')],
    ]);
    await f.tick();
    expect(f.heldTitles()).toEqual(['S']);

    f.requestCleanup();
    const span = await f.tick();

    expect(span.erroredObservations).toEqual([
      { monitorId: MONITOR_ID, message: refusal('Bad') },
    ]);
    expect(f.eventTitles()).toEqual(['K2']);
    expect(f.heldTitles()).toEqual([]);
    expect(await f.doctorLoss()).toBeUndefined();
    expect(await f.materializationStatus()).not.toBe('failure');
  });

  it('with an older kept sibling held beside the artifact, only the newer sibling supersedes it', async () => {
    const f = setup((root) => [
      [obs('H', 'K'), obs('S', scratchKey(root, RUN))],
      // Bad is refused behind [H, S]; K2 flushes [H, S, K2]. Of the two
      // envelopes before the refusal only H is kept, so it lands between H
      // and K2.
      [unserializable('Bad', 'K'), escalated('K2', 'K')],
    ]);
    await f.tick();
    expect(f.heldTitles()).toEqual(['H', 'S']);

    f.requestCleanup();
    await f.tick();

    expect(f.eventTitles()).toEqual(['H', 'K2']);
    expect(await f.doctorLoss()).toBeUndefined();
    expect(await f.materializationStatus()).not.toBe('failure');
  });

  it('an older kept sibling held beside the artifact still does not supersede it (control)', async () => {
    const f = setup((root) => [
      [obs('H', 'K'), obs('S', scratchKey(root, RUN))],
      // As above, but the escalation is another key: H is older than Bad,
      // so nothing newer of key K materialized and the loss stays.
      [unserializable('Bad', 'K'), escalated('E', 'E')],
    ]);
    await f.tick();
    f.requestCleanup();
    await f.tick();

    expect(f.eventTitles()).toEqual(['H', 'E']);
    expect(await f.doctorLoss()).toMatchObject({
      count: 1,
      objectKey: 'K',
      title: 'Bad',
      error: refusal('Bad'),
    });
    expect(await f.materializationStatus()).toBe('failure');
  });

  it('with nothing filtered, the refusal sits between the held artifact and the newer sibling (control)', async () => {
    const f = setup((root) => [
      [obs('S', scratchKey(root, RUN))],
      [unserializable('Bad', 'K'), escalated('K2', 'K')],
    ]);
    await f.tick();
    // No cleanup request: the artifact is in its proof phase and is kept.
    await f.tick();

    expect(f.eventTitles()).toEqual(['S', 'K2']);
    expect(await f.doctorLoss()).toBeUndefined();
    expect(await f.materializationStatus()).not.toBe('failure');
  });
});
