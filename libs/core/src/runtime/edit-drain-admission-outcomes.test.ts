/**
 * How effective notify-policy edits and the notify admission gate interact
 * with span admission outcomes: dropped observations and retained retries.
 *
 * An edit drain is all-or-nothing: when a held envelope cannot materialize it
 * rolls back, keeps the hold and records no drop and no retry. Work blocked at
 * a closed gate has not been admitted, so it records neither until it is. A
 * drop is a history outcome, not held work: it never keeps the gate closed and
 * stays outstanding across an edit unless a drained event supersedes it. Every
 * case runs real ticks or a real watcher against file-backed SQLite, with
 * native `RAISE(ABORT)` triggers and real non-serializable payloads.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §2 (admission outcomes, drops)
 * @see ../../../../docs/specs/002-runtime-delivery.md §2.4 (watch batches at a closed gate)
 * @see ../../../../docs/specs/002-runtime-delivery.md §4.6 (effective notify-policy edits)
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
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import { MATERIALIZATION_RETRY_MAX_RECORDS } from './types.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const MONITOR_ID = 'edited';

/** Omitted notify at normal urgency emits immediately (002 §4.1). */
const IMMEDIATE = '';
/** Holds every observation for an hour, so a later edit has work to drain. */
const DEBOUNCE = 'notify:\n  strategy: debounce\n  settle-for: 1h\n';

/** Accepts `mode: ok`; rejects `mode: broken`. */
const STRICT_SCOPE = {
  type: 'object',
  properties: { mode: { enum: ['ok'] } },
};

const resources: { root: string; clients: BetterSQLiteClient[] }[] = [];

/** Native Date instances: retry envelopes reject subclassed timestamps. */
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

/** An observation of one object; a BigInt payload can neither persist nor be retained. */
function observation(
  title: string,
  objectKey: string,
  unretainable = false,
): Observation {
  return {
    title,
    summary: title,
    objectKey,
    snapshotText: `content-${title}`,
    ...(unretainable ? { payload: { n: 1n } } : {}),
  };
}

/**
 * One monitor whose poll returns `next` and advances its cursor, and whose
 * optional watcher yields whatever batches the test pushes. One lead session.
 */
function fixture(options: { watch?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-edit-drain-'));
  const owned = { root, clients: [] as BetterSQLiteClient[] };
  resources.push(owned);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(path.join(monitorsDir, MONITOR_ID), { recursive: true });
  const write = (policy: string, mode: 'ok' | 'broken' = 'ok') => {
    writeFileSync(
      path.join(monitorsDir, MONITOR_ID, 'MONITOR.md'),
      `---\nname: Edited\nwatch:\n  type: edit-source\n  interval: 1s\n  mode: ${mode}\nurgency: normal\nbaseline-strategy: incremental\n${policy}---\nInspect the changes.\n`,
    );
  };
  const control = { next: [] as Observation[], polls: 0 };
  const queue: ObservationResult[] = [];
  let wake: (() => void) | undefined;
  const pulled: ObservationResult[] = [];
  const source: ObservationSource = {
    name: 'edit-source',
    scopeSchema: STRICT_SCOPE,
    stateful: true,
    observe(_config, context) {
      control.polls += 1;
      const cursor =
        (context.previousState as { cursor?: number } | undefined)?.cursor ?? 0;
      return Promise.resolve({
        observations: control.next,
        nextState: { cursor: cursor + 1 },
      });
    },
    ...(options.watch
      ? {
          async *watch(_config, context) {
            for (;;) {
              while (queue.length === 0) {
                if (context.signal.aborted) return;
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  context.signal.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
                });
              }
              const batch = queue.shift();
              if (!batch) continue;
              pulled.push(batch);
              yield batch;
            }
          },
        }
      : {}),
  };
  const dbPath = path.join(root, 'runtime.db');
  const connect = () => {
    const db = createDb(dbPath);
    // Tests use the native client only to install faults and read committed rows.
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    owned.clients.push(client);
    return { db, client };
  };
  const writer = connect();
  const store = new RuntimeStore(writer.db);
  const registry = new SourceRegistry();
  registry.register(source);
  const runtime = new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
  runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'lead',
      workspacePath: root,
    }),
  );
  const observer = connect();
  const reader = new RuntimeStore(observer.db);
  return {
    root,
    monitorsDir,
    writer,
    reader,
    runtime,
    control,
    write,
    /** Hand the watcher one batch; it is pulled only when the consumer asks. */
    push(batch: ObservationResult) {
      queue.push(batch);
      wake?.();
    },
    queue,
    pulled,
    tick: () => runtime.tick(monitorsDir, root),
    /** Make the 1s source interval elapse, then tick. */
    async poll() {
      clockTime += 2_000;
      return runtime.tick(monitorsDir, root);
    },
    /** Fail every event insert for one summary, inside its own savepoint. */
    abortOn(summary: string) {
      writer.client.exec(
        `CREATE TRIGGER abort_${summary.replace(/\W/g, '_')} BEFORE INSERT ON monitor_events WHEN NEW.summary = '${summary}' BEGIN SELECT RAISE(ABORT, 'native fault on ${summary}'); END;`,
      );
    },
    clearFault(summary: string) {
      writer.client.exec(`DROP TRIGGER abort_${summary.replace(/\W/g, '_')}`);
    },
    /** Event summaries in materialization order (`listEvents` is newest first). */
    events: () =>
      reader
        .listEvents()
        .filter((event) => event.monitorId === MONITOR_ID)
        .map(({ summary }) => summary)
        .reverse(),
    drops: () =>
      reader
        .listObservationHistory({
          monitorId: MONITOR_ID,
          workspacePath: root,
          limit: 10_000,
        })
        .filter(
          ({ result, observationData }) =>
            result === 'errored' && observationData['notRetained'] === true,
        ),
    retries: () =>
      reader.listMaterializationRetries({
        monitorId: MONITOR_ID,
        workspacePath: root,
      }),
    loss: () => reader.outstandingUnretainedObservationLoss(MONITOR_ID, root),
    held: () =>
      (
        reader.getMonitorState(MONITOR_ID, root).notifyState.pendingDebounce
          ?.observations ?? []
      ).map(({ observation: held }) => held.summary),
    state: () => reader.getMonitorState(MONITOR_ID, root),
  };
}

describe('a notify-policy edit while a drop is outstanding', () => {
  it('keeps the drop across an edit with nothing to drain, and clears it only when a drained event supersedes its key', async () => {
    const f = fixture();
    f.write(IMMEDIATE);
    f.control.next = [
      observation('k-dropped', 'k', true),
      observation('other', 'o'),
    ];
    await f.tick();
    expect(f.events()).toEqual(['other']);
    expect(f.drops()).toHaveLength(1);
    expect(f.loss()).toMatchObject({ count: 1, objectKey: 'k' });
    const policyBefore = f.state().notifyState.policyKey;

    // The edit is reconciled before the source is due: nothing is held, so
    // it drains nothing, materializes nothing and records nothing for the drop.
    f.write(DEBOUNCE);
    const edited = await f.tick();
    expect(edited.erroredObservations).toEqual([]);
    expect(f.state().notifyState.policyKey).not.toBe(policyBefore);
    expect(f.events()).toEqual(['other']);
    expect(f.drops()).toHaveLength(1);
    expect(f.retries()).toEqual([]);
    expect(f.loss()).toMatchObject({ count: 1, objectKey: 'k' });

    // An observation of the same key admitted after the drop is held, not
    // materialized, so the drop is still outstanding.
    f.control.next = [observation('k-held', 'k')];
    await f.poll();
    expect(f.held()).toEqual(['k-held']);
    expect(f.loss()).toMatchObject({ count: 1, objectKey: 'k' });

    // Editing back drains the hold; its event supersedes the keyed drop (002 §2).
    f.control.next = [];
    f.write(IMMEDIATE);
    await f.tick();
    expect(f.held()).toEqual([]);
    expect(f.events()).toEqual(['other', 'k-held']);
    expect(f.loss()).toBeUndefined();
    expect(f.drops()).toHaveLength(1);
  });
});

describe('an edit drain whose held envelope cannot be retained', () => {
  it('waits behind a full outbox without draining or dropping, then rolls back a failing drain with no drop and no retry', async () => {
    const f = fixture();
    f.write(IMMEDIATE);
    // Fill this monitor's outbox exactly: the first observation fails and its
    // whole ordered suffix is retained.
    f.abortOn('r-0');
    f.control.next = Array.from(
      { length: MATERIALIZATION_RETRY_MAX_RECORDS },
      (_, index) => observation(`r-${String(index)}`, `r-${String(index)}`),
    );
    await f.tick();
    expect(f.retries()).toHaveLength(MATERIALIZATION_RETRY_MAX_RECORDS);
    expect(f.drops()).toEqual([]);

    // Retained work drains before an edit is reconciled or the source is
    // asked for more (002 §2.6). While its oldest retry keeps failing, the
    // edit waits: nothing drains, drops or is queued, and the source is idle.
    f.write(DEBOUNCE);
    const polls = f.control.polls;
    const before = f.state();
    f.control.next = [observation('held', 'h')];
    const waiting = await f.poll();
    expect(waiting.erroredObservations).toEqual([
      {
        monitorId: MONITOR_ID,
        message: expect.stringContaining('native fault on r-0'),
      },
    ]);
    expect(f.control.polls).toBe(polls);
    expect(f.state()).toEqual(before);
    expect(f.drops()).toEqual([]);
    expect(f.retries()).toHaveLength(MATERIALIZATION_RETRY_MAX_RECORDS);
    expect(f.loss()).toBeUndefined();

    // Once the retained work drains, in order, the edit is reconciled and the
    // newer observation is held under the edited policy.
    f.clearFault('r-0');
    clockTime += 10_000;
    await f.poll();
    expect(f.retries()).toEqual([]);
    expect(f.events()).toEqual(
      Array.from(
        { length: MATERIALIZATION_RETRY_MAX_RECORDS },
        (_, index) => `r-${String(index)}`,
      ),
    );
    expect(f.held()).toEqual(['held']);
    const held = f.state();

    // An edit drain is all-or-nothing (002 §4.6): its failure rolls back,
    // keeps the hold, and records no drop and no retry.
    f.abortOn('held');
    f.write(IMMEDIATE);
    const blockedPolls = f.control.polls;
    f.control.next = [observation('after', 'a')];
    const blocked = await f.poll();
    expect(blocked.erroredObservations).toEqual([
      {
        monitorId: MONITOR_ID,
        message: expect.stringContaining('Notify edit blocked'),
      },
    ]);
    expect(f.control.polls).toBe(blockedPolls);
    expect(f.drops()).toEqual([]);
    expect(f.retries()).toEqual([]);
    expect(f.loss()).toBeUndefined();
    expect(f.held()).toEqual(['held']);
    expect(f.state()).toEqual(held);
    expect(f.events()).not.toContain('held');

    f.clearFault('held');
    await f.poll();
    expect(f.held()).toEqual([]);
    expect(f.events().slice(-2)).toEqual(['held', 'after']);
    expect(f.drops()).toEqual([]);
    expect(f.retries()).toEqual([]);
  });
});

describe('a rejected scope with held work and an outstanding drop', () => {
  it('leaves the hold, the drop and the baseline untouched while rejected, then recovers both', async () => {
    const f = fixture();
    f.write(IMMEDIATE);
    f.control.next = [observation('k-dropped', 'k', true)];
    await f.tick();
    expect(f.loss()).toMatchObject({ count: 1, objectKey: 'k' });

    f.write(DEBOUNCE);
    f.control.next = [observation('k-held', 'k')];
    await f.poll();
    expect(f.held()).toEqual(['k-held']);
    const before = f.state();

    f.write(DEBOUNCE, 'broken');
    const polls = f.control.polls;
    f.control.next = [observation('k-unadmitted', 'k', true)];
    const rejected = await f.poll();
    expect(rejected.skippedMonitors).toEqual([
      {
        monitorId: MONITOR_ID,
        validationError: expect.stringContaining('mode'),
      },
    ]);
    expect(f.control.polls).toBe(polls);
    expect(f.state()).toEqual(before);
    expect(f.drops()).toHaveLength(1);
    expect(f.retries()).toEqual([]);
    expect(f.loss()).toMatchObject({ count: 1, objectKey: 'k' });
    const doctor = await f.runtime.doctorReport({
      monitorsDir: f.monitorsDir,
      workspacePath: f.root,
    });
    expect(doctor.monitors[0]).toMatchObject({
      id: MONITOR_ID,
      valid: false,
      unretainedObservationLoss: { count: 1, objectKey: 'k' },
    });

    // A valid edit drains the hold, which supersedes the drop; the corrected
    // scope then observes normally.
    f.write(IMMEDIATE);
    f.control.next = [observation('fresh', 'f')];
    await f.poll();
    expect(f.held()).toEqual([]);
    expect(f.events()).toEqual(['k-held', 'fresh']);
    expect(f.loss()).toBeUndefined();
    expect(f.drops()).toHaveLength(1);
  });

  it('keeps a watch batch waiting unadmitted, with no drop, until valid recovery admits it', async () => {
    const f = fixture({ watch: true });
    f.write(DEBOUNCE);
    const errors: string[] = [];
    const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root, {
      onError: (_id, error) => errors.push(error.message),
    });
    try {
      f.push({
        observations: [observation('held', 'h')],
        nextState: { cursor: 1 },
      });
      await vi.waitFor(() => expect(f.held()).toEqual(['held']));

      // One rejected definition both changes pacing and invalidates the scope:
      // the preflight runs first, so the held work closes the gate.
      f.write(IMMEDIATE, 'broken');
      const rejected = await f.tick();
      expect(rejected.skippedMonitors).toHaveLength(1);
      f.push({
        observations: [
          observation('dropped', 'd', true),
          observation('after', 'a'),
        ],
        nextState: { cursor: 2 },
      });
      f.push({ observations: [], nextState: { cursor: 3 } });
      await vi.waitFor(() => expect(f.pulled).toHaveLength(2));
      for (let n = 0; n < 64; n++) await Promise.resolve();
      // The waiting batch is parked at the closed gate, not admitted and not
      // failed: the watcher is alive (no error) and the source is not pulled again.
      const gate = f.runtime as unknown as {
        watchPolicyWaiters: Map<string, Set<() => void>>;
      };
      expect(errors).toEqual([]);
      expect(
        gate.watchPolicyWaiters.has(JSON.stringify([f.root, MONITOR_ID])),
      ).toBe(true);
      expect(f.pulled).toHaveLength(2);
      expect(f.queue).toHaveLength(1);
      expect(f.drops()).toEqual([]);
      expect(f.held()).toEqual(['held']);
      expect(f.state().sourceState).toEqual({ cursor: 1 });

      // Recovery drains the old hold first, then admits the waiting batch
      // under the edited pacing: its unretainable observation drops and its
      // materializable one follows the drained hold in event order.
      f.write(IMMEDIATE);
      await f.tick();
      await vi.waitFor(() =>
        expect(f.state().sourceState).toEqual({ cursor: 3 }),
      );
      expect(f.events()).toEqual(['held', 'after']);
      expect(f.drops()).toHaveLength(1);
      expect(f.loss()).toMatchObject({ count: 1, objectKey: 'd' });
      expect(f.retries()).toEqual([]);
      expect(errors.some((message) => /recorded errored/.test(message))).toBe(
        false,
      );
    } finally {
      await handle.stop();
    }
  });
});

describe('a refusal at hold acceptance is neither held work nor a drop', () => {
  it('leaves the admission gate open when a later definition is rejected, so the watcher keeps admitting (002 §2.0/§4.6/§4.7)', async () => {
    const f = fixture({ watch: true });
    f.write(DEBOUNCE);
    const errors: string[] = [];
    const handle = await f.runtime.watchMonitors(f.monitorsDir, f.root, {
      onError: (_id, error) => errors.push(error.message),
    });
    try {
      // The debounce hold refuses the only observation: nothing is held, the
      // baseline advances, and the refusal is not recorded as a drop.
      f.push({
        observations: [observation('refused', 'r', true)],
        nextState: { cursor: 1 },
      });
      await vi.waitFor(() =>
        expect(f.state().sourceState).toEqual({ cursor: 1 }),
      );
      expect(f.held()).toEqual([]);
      expect(errors).toEqual([
        expect.stringMatching(
          /^Observation "refused" was not held for debounce:/u,
        ),
      ]);
      expect(f.drops()).toEqual([]);
      expect(f.loss()).toBeUndefined();

      // A rejected definition closes the gate only for held work. The refusal
      // is not held work, so the running watcher keeps its startup config.
      f.write(IMMEDIATE, 'broken');
      const rejected = await f.tick();
      expect(rejected.skippedMonitors).toHaveLength(1);
      f.push({
        observations: [observation('after', 'a')],
        nextState: { cursor: 2 },
      });
      await vi.waitFor(() =>
        expect(f.state().sourceState).toEqual({ cursor: 2 }),
      );
      const gate = f.runtime as unknown as {
        watchPolicyWaiters: Map<string, Set<() => void>>;
      };
      expect(
        gate.watchPolicyWaiters.has(JSON.stringify([f.root, MONITOR_ID])),
      ).toBe(false);
      expect(f.held()).toEqual(['after']);
      expect(errors).toHaveLength(1);
      expect(f.drops()).toEqual([]);
      expect(f.retries()).toEqual([]);
    } finally {
      await handle.stop();
    }
  });
});
