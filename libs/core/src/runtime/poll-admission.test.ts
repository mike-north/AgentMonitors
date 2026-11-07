/**
 * Poll admission is one durable finite span before optional interpretation.
 * Independent readers observe committed events or ordered retained obligations,
 * never a source/notify advance whose corresponding work has disappeared.
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type {
  InterpretAdapter,
  InterpretInput,
  InterpretResult,
} from '../adapter/interpret.js';
import { createDb } from '../inbox/db.js';
import type { ObservationSource } from '../observation/types.js';
import { SourceRegistry } from '../observation/registry.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import { registerRuntimeTransaction } from './runtime-transaction.js';

/** Fixed observation time makes source cadence and notify deadlines exact. */
const NOW = new Date('2026-11-01T12:00:00.000Z');
/** Every resource belongs to this suite and is closed before its directory is removed. */
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

/** Faults happen after a real write, proving rollback rather than an early no-op. */
class AdmissionFaultStore extends RuntimeStore {
  failSecond = false;
  failState = false;
  failOutbox = false;

  override saveSnapshot(
    input: Parameters<RuntimeStore['saveSnapshot']>[0],
  ): void {
    super.saveSnapshot(input);
    if (this.failSecond && input.content === '') {
      this.failSecond = false;
      throw new Error('second snapshot failed');
    }
  }

  override setMonitorState(
    ...args: Parameters<RuntimeStore['setMonitorState']>
  ): void {
    super.setMonitorState(...args);
    if (this.failState) {
      this.failState = false;
      throw new Error('source and notify write failed');
    }
  }

  override enqueueMaterializationRetries(
    ...args: Parameters<RuntimeStore['enqueueMaterializationRetries']>
  ) {
    const records = super.enqueueMaterializationRetries(...args);
    if (this.failOutbox) {
      this.failOutbox = false;
      throw new Error('suffix admission failed');
    }
    return records;
  }
}

/** A barrier holds only the first Interpret invocation; later calls are ordinary. */
function interpretBarrier() {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const calls: InterpretInput[] = [];
  const adapter: InterpretAdapter = {
    name: 'admission-barrier',
    async interpret(input): Promise<InterpretResult> {
      calls.push(input);
      if (calls.length === 1) {
        entered.resolve(undefined);
        await released.promise;
      }
      return { decision: 'deliver', digest: input.delta };
    },
  };
  return {
    adapter,
    calls,
    entered: entered.promise,
    release: () => released.resolve(undefined),
  };
}

/** The source emits a complete three-step transition once, then advances quiet checkpoints. */
function fixture(debounce: boolean | 'rollup' = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-poll-admission-'));
  const owned = { root, clients: [] as BetterSQLiteClient[] };
  resources.push(owned);
  const monitorsDir = path.join(root, 'monitors');
  mkdirSync(path.join(monitorsDir, 'span'), { recursive: true });
  writeFileSync(
    path.join(monitorsDir, 'span', 'MONITOR.md'),
    `---
name: Span
watch:
  type: admission-source
  interval: 1s
urgency: normal
payload:
  form: prose
baseline-strategy: incremental
${debounce === 'rollup' ? 'notify:\n  strategy: rollup\n  window: "1 * * * *"\n  timezone: UTC\n' : debounce ? 'notify:\n  strategy: debounce\n  settle-for: 1s\n' : ''}---
Inspect the changes.
`,
  );
  const sourceStates: unknown[] = [];
  const source: ObservationSource = {
    name: 'admission-source',
    scopeSchema: { type: 'object' },
    stateful: true,
    observe(_config, context) {
      sourceStates.push(context.previousState);
      const previous =
        typeof context.previousState === 'number' ? context.previousState : 0;
      return Promise.resolve({
        observations:
          previous === 0
            ? ['alpha', '', 'omega'].map((snapshotText, index) => ({
                title: `step-${String(index + 1)}`,
                summary: `step-${String(index + 1)}`,
                objectKey: 'shared-object',
                snapshotText,
              }))
            : [],
        nextState: previous + 1,
      });
    },
  };
  const dbPath = path.join(root, 'runtime.db');
  const connect = () => {
    const db = createDb(dbPath);
    // InboxDb intentionally hides its SQLite client; tests use it solely for
    // independent durable-row assertions and owned connection cleanup.
    const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
    owned.clients.push(client);
    return { db, client };
  };
  const writer = connect();
  const store = new AdmissionFaultStore(writer.db);
  const barrier = interpretBarrier();
  const makeRuntime = (target: RuntimeStore) => {
    const registry = new SourceRegistry();
    registry.register(source);
    // A source-type edit must not reinterpret the prior plugin's opaque state.
    registry.register({
      name: 'replacement-source',
      scopeSchema: { type: 'object' },
      observe: () => Promise.resolve({ observations: [] }),
    });
    return new AgentMonitorRuntime(
      target,
      registry,
      [claudeCodeAdapter],
      barrier.adapter,
    );
  };
  const runtime = makeRuntime(store);
  const sessions = ['lead-a', 'lead-b'].map((hostSessionId) =>
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId,
        workspacePath: root,
      }),
    ),
  );
  // Open before any admission. Never replace this reader to hide stale visibility.
  const observer = connect();
  const reader = new RuntimeStore(observer.db);
  return {
    root,
    monitorsDir,
    writer,
    source,
    connect,
    store,
    reader,
    observer,
    barrier,
    runtime,
    sessions,
    sourceStates,
    makeRuntime,
  };
}

/** Assert the entire projected prefix and snapshot chain, not just a total count. */
function expectPrefix(
  f: ReturnType<typeof fixture>,
  expected: string[],
  interpretation: 'deliver' | null = null,
) {
  const events = f.reader
    .listEvents({ monitorId: 'span', workspacePath: f.root })
    .sort((a, b) => a.id.localeCompare(b.id));
  expect(events.map(({ summary }) => summary)).toEqual(expected);
  for (const session of f.sessions) {
    expect(
      f.reader
        .listEvents({ sessionId: session.id })
        .map(({ id }) => id)
        .sort(),
    ).toEqual(events.map(({ id }) => id).sort());
    expect(
      f.reader.getSessionObjectCursor(
        session.id,
        'span',
        'shared-object',
        f.root,
      ),
    ).toMatchObject({
      sessionId: session.id,
      monitorId: 'span',
      objectKey: 'shared-object',
      workspacePath: f.root,
      baselineContent: 'alpha',
    });
  }
  expect(
    f.observer.client
      .prepare('SELECT content, event_id FROM monitor_snapshots ORDER BY id')
      .all(),
  ).toEqual(
    expected.map((_, index) => ({
      content: ['alpha', '', 'omega'][index],
      event_id: events[index]?.id,
    })),
  );
  expect(
    f.observer.client
      .prepare('SELECT interpret_decision FROM session_event_state')
      .all(),
  ).toEqual(
    Array.from({ length: expected.length * 2 }, () => ({
      interpret_decision: interpretation,
    })),
  );
  return events;
}

/** Await entry without masking a tick that completed or failed before reaching Interpret. */
async function atFirstInterpret(
  f: ReturnType<typeof fixture>,
  tick: ReturnType<AgentMonitorRuntime['tick']>,
) {
  await Promise.race([
    f.barrier.entered,
    tick.then((result) => {
      throw new Error(
        `Tick ended without entering Interpret: ${JSON.stringify(result)}`,
      );
    }),
  ]);
  expect(f.barrier.calls).toHaveLength(1);
}

describe('whole poll span before Interpret', () => {
  it('exposes every recipient and sequential snapshot before the first adapter resolves', async () => {
    const f = fixture();
    const tick = f.runtime.tick(f.monitorsDir, f.root);
    try {
      await atFirstInterpret(f, tick);
      const events = expectPrefix(f, ['step-1', 'step-2', 'step-3']);
      expect(events[1]?.diffText).toContain('- 1: alpha');
      expect(events[2]?.diffText).toContain('+ 1: omega');
      expect(events[2]?.diffText).not.toContain('alpha');
      expect(f.reader.latestSnapshot('span', 'shared-object', f.root)).toEqual({
        content: 'omega',
      });
      expect(f.reader.getMonitorState('span', f.root)).toEqual({
        sourceState: 1,
        notifyState: {},
        lastObservationAt: NOW,
      });
      expect(f.reader.listMaterializationRetries()).toEqual([]);
      f.barrier.release();
      expect((await tick).emittedEventIds).toEqual(events.map(({ id }) => id));
    } finally {
      f.barrier.release();
      await tick;
    }
  });

  it('exposes the committed prefix and ordered retained suffix before the first adapter resolves', async () => {
    const f = fixture();
    f.store.failSecond = true;
    const tick = f.runtime.tick(f.monitorsDir, f.root);
    try {
      await atFirstInterpret(f, tick);
      const events = expectPrefix(f, ['step-1']);
      const retries = f.reader.listMaterializationRetries();
      expect(
        retries.map(({ envelope }) => [
          envelope.observation.summary,
          envelope.observation.snapshotText,
        ]),
      ).toEqual([
        ['step-2', ''],
        ['step-3', 'omega'],
      ]);
      expect(retries.map(({ id }) => id)).toEqual(
        retries.map(({ id }) => id).sort(),
      );
      expect(
        retries.every(
          ({ status, attemptCount }) =>
            status === 'pending' && attemptCount === 0,
        ),
      ).toBe(true);
      expect(f.reader.getMonitorState('span', f.root)).toEqual({
        sourceState: 1,
        notifyState: {},
        lastObservationAt: NOW,
      });
      expect(f.reader.latestSnapshot('span', 'shared-object', f.root)).toEqual({
        content: 'alpha',
      });
      expect(
        f.reader
          .listObservationHistory({ monitorId: 'span' })
          .map(({ result, observationData }) => ({ result, observationData })),
      ).toEqual([
        {
          result: 'errored',
          observationData: { error: 'second snapshot failed' },
        },
        { result: 'triggered', observationData: { observed: 3, emitted: 1 } },
      ]);
      f.barrier.release();
      const result = await tick;
      expect(result.emittedEventIds).toEqual(events.map(({ id }) => id));
      expect(result.erroredObservations).toEqual([
        {
          monitorId: 'span',
          message:
            '2 observations were queued for materialization retry. First error: second snapshot failed',
        },
      ]);
    } finally {
      f.barrier.release();
      await tick;
    }
  });

  for (const fault of ['state', 'outbox'] as const) {
    it(`preserves source, held notify work and projection cache on ${fault} failure then replays on reopen`, async () => {
      const f = fixture(true);
      await f.runtime.tick(f.monitorsDir, f.root);
      const before = f.reader.getMonitorState('span', f.root);
      expect(before.sourceState).toBe(1);
      expect(before.notifyState.pendingDebounce?.observations).toHaveLength(3);
      const previousProjected = f.store.projectedSessionIdsForLastEvent();
      clockTime = NOW.getTime() + 2000;
      f.store.failState = fault === 'state';
      f.store.failSecond = fault === 'outbox';
      f.store.failOutbox = fault === 'outbox';
      const failed = await f.runtime.tick(f.monitorsDir, f.root);
      expect(failed.emittedEventIds).toEqual([]);
      expect(failed.erroredObservations).toHaveLength(1);
      expect(f.barrier.calls).toEqual([]);
      expect(f.reader.getMonitorState('span', f.root)).toEqual(before);
      expect(f.reader.listEvents()).toEqual([]);
      expect(f.reader.listMaterializationRetries()).toEqual([]);
      for (const table of [
        'session_event_state',
        'session_object_cursor',
        'monitor_snapshots',
      ]) {
        expect(
          f.observer.client.prepare(`SELECT * FROM ${table}`).all(),
        ).toEqual([]);
      }
      expect(f.store.projectedSessionIdsForLastEvent()).toEqual(
        previousProjected,
      );
      const reopened = new RuntimeStore(f.connect().db);
      const restarted = f.makeRuntime(reopened);
      const tick = restarted.tick(f.monitorsDir, f.root);
      try {
        await atFirstInterpret(f, tick);
        expectPrefix(f, ['step-1', 'step-2', 'step-3']);
        expect(f.reader.getMonitorState('span', f.root)).toEqual({
          sourceState: 2,
          notifyState: {},
          lastObservationAt: new Date(NOW.getTime() + 2000),
        });
        expect(f.sourceStates).toEqual([undefined, 1, 1]);
      } finally {
        f.barrier.release();
        await tick;
      }
    });
  }

  it('dispatches against notify state committed by another connection immediately before admission begins', async () => {
    const f = fixture(true);
    await f.runtime.tick(f.monitorsDir, f.root);
    const before = f.reader.getMonitorState('span', f.root);
    const first = before.notifyState.pendingDebounce?.observations[0];
    if (!first) throw new Error('Fixture requires a held observation');
    clockTime = NOW.getTime() + 2000;
    let interposed = false;
    // Test-only internal bridge intercepts the exact pre-BEGIN boundary. Both
    // writes use real independent SQLite connections; no store reads are mocked.
    registerRuntimeTransaction(
      f.store,
      (operation) => {
        if (!interposed) {
          interposed = true;
          f.reader.setMonitorState('span', f.root, {
            ...before,
            notifyState: {
              pendingDebounce: {
                dueAt: new Date(NOW.getTime() + 1000).toISOString(),
                observations: [
                  ...(before.notifyState.pendingDebounce?.observations ?? []),
                  {
                    ...first,
                    observation: {
                      title: 'concurrent',
                      summary: 'concurrent',
                      objectKey: 'other',
                      snapshotText: 'external',
                    },
                  },
                ],
              },
            },
          });
        }
        return f.writer.client.transaction(operation).immediate();
      },
      () => f.writer.client.inTransaction,
    );
    const tick = f.runtime.tick(f.monitorsDir, f.root);
    try {
      await atFirstInterpret(f, tick);
      expect(interposed).toBe(true);
      expect(
        f.reader
          .listEvents()
          .map(({ summary }) => summary)
          .sort(),
      ).toEqual(['concurrent', 'step-1', 'step-2', 'step-3']);
      expect(f.reader.getMonitorState('span', f.root).notifyState).toEqual({});
    } finally {
      f.barrier.release();
      await tick;
    }
  });

  it('rejects a poll derived from an older source baseline even when the source mutates its context', async () => {
    const f = fixture();
    f.store.setMonitorState('span', f.root, {
      sourceState: { cursor: 0 },
      notifyState: {},
    });
    f.source.observe = (_config, context) => {
      if (
        context.previousState &&
        typeof context.previousState === 'object' &&
        'cursor' in context.previousState
      )
        context.previousState.cursor = 1;
      f.reader.setMonitorState('span', f.root, {
        sourceState: { cursor: 1 },
        notifyState: { suppressedUntil: '2030-01-01T00:00:00.000Z' },
      });
      return Promise.resolve({ observations: [] });
    };
    const result = await f.runtime.tick(f.monitorsDir, f.root);
    expect(result.erroredObservations).toHaveLength(1);
    expect(result.erroredObservations[0]?.message).toContain(
      'source baseline changed',
    );
    expect(f.reader.getMonitorState('span', f.root)).toEqual({
      sourceState: { cursor: 1 },
      notifyState: { suppressedUntil: '2030-01-01T00:00:00.000Z' },
    });
    expect(f.reader.listEvents()).toEqual([]);
    expect(f.reader.listMaterializationRetries()).toEqual([]);
    expect(f.barrier.calls).toEqual([]);
  });

  it('restores the prior committed recipient cache rather than clearing it', async () => {
    const f = fixture();
    const previousWorkspace = path.join(f.root, 'other-workspace');
    const previousSession = f.runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'previous-lead',
        workspacePath: previousWorkspace,
      }),
    );
    const prior = f.store.insertEvent({
      workspacePath: previousWorkspace,
      monitorId: 'previous-monitor',
      sourceName: 'admission-source',
      urgency: 'normal',
      title: 'Previous committed event',
      body: '',
      summary: 'previous',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: null,
      baselineStrategy: 'incremental',
      queryScope: {},
      tags: [],
      createdAt: NOW,
    });
    expect(f.store.projectedSessionIdsForLastEvent()).toEqual([
      previousSession.id,
    ]);
    f.store.failState = true;
    const result = await f.runtime.tick(f.monitorsDir, f.root);
    expect(result.emittedEventIds).toEqual([]);
    expect(result.erroredObservations).toHaveLength(1);
    expect(f.store.projectedSessionIdsForLastEvent()).toEqual([
      previousSession.id,
    ]);
    expect(f.reader.listEvents().map(({ id }) => id)).toEqual([prior.id]);
    expect(f.barrier.calls).toEqual([]);
  });

  it('rolls back a held-only notify admission and its source checkpoint', async () => {
    const f = fixture(true);
    f.store.failState = true;
    const result = await f.runtime.tick(f.monitorsDir, f.root);
    expect(result.erroredObservations).toHaveLength(1);
    expect(f.reader.getMonitorState('span', f.root)).toEqual({
      notifyState: {},
    });
    expect(f.reader.listEvents()).toEqual([]);
    expect(f.reader.listMaterializationRetries()).toEqual([]);
    expect(f.barrier.calls).toEqual([]);
    const restarted = f.makeRuntime(new RuntimeStore(f.connect().db));
    await restarted.tick(f.monitorsDir, f.root);
    expect(f.sourceStates).toEqual([undefined, undefined]);
    expect(
      f.reader.getMonitorState('span', f.root).notifyState.pendingDebounce
        ?.observations,
    ).toHaveLength(3);
  });
});

/** Preserve owned raw SQLite/source bytes and public endpoints for fault diagnosis. */
function captureAdmissionEvidence(
  f: ReturnType<typeof fixture>,
  label: string,
): void {
  const destination = process.env['AM497_EVIDENCE_DIR'];
  if (!destination) return;
  const folder = path.join(destination, label);
  mkdirSync(folder, { recursive: true });
  const rows: Record<string, unknown> = {};
  for (const table of [
    'monitor_events',
    'monitor_snapshots',
    'session_event_state',
    'session_object_cursor',
    'materialization_retry_outbox',
    'monitor_state',
    'observation_history',
  ]) {
    rows[table] = f.observer.client
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all();
  }
  writeFileSync(
    path.join(folder, 'endpoints.json'),
    JSON.stringify(
      {
        state: f.reader.getMonitorState('span', f.root),
        events: f.reader.listEvents(),
        retries: f.reader.listMaterializationRetries(),
        history: f.reader.listObservationHistory({ monitorId: 'span' }),
        cache: f.store.projectedSessionIdsForLastEvent(),
        interpret: f.barrier.calls,
        sourceStates: f.sourceStates,
        rows,
        sessions: f.sessions.map(({ id }) => ({
          id,
          events: f.reader.listEvents({ sessionId: id }),
          cursor: f.reader.getSessionObjectCursor(
            id,
            'span',
            'shared-object',
            f.root,
          ),
        })),
        snapshot: f.reader.latestSnapshot('span', 'shared-object', f.root),
      },
      null,
      2,
    ),
  );
  // WAL is copied with the database so committed pages are retained even when
  // SQLite has not checkpointed them into its main file. Only owned files enter.
  for (const suffix of ['', '-wal', '-shm']) {
    const source = path.join(f.root, `runtime.db${suffix}`);
    if (existsSync(source))
      writeFileSync(
        path.join(folder, `runtime.db${suffix}`),
        readFileSync(source),
      );
  }
  writeFileSync(
    path.join(folder, 'MONITOR.md'),
    readFileSync(path.join(f.monitorsDir, 'span', 'MONITOR.md')),
  );
}

/**
 * Real SQLite rollback modes exercise the distinction in 002 §2: a local
 * materialization fault may retain a suffix, but an aborted owning transaction
 * must leave its entire source span replayable. No JavaScript fault substitutes
 * for SQLite ending the transaction.
 */
describe('SQLite admission fault boundaries', () => {
  for (const held of [false, true]) {
    it(`preserves the complete ${held ? 'held' : 'fresh'} span after transaction-wide ROLLBACK`, async () => {
      const f = fixture(held);
      f.barrier.release();
      if (held) {
        await f.runtime.tick(f.monitorsDir, f.root);
        clockTime = NOW.getTime() + 2000;
      }
      const before = f.reader.getMonitorState('span', f.root);
      captureAdmissionEvidence(f, `rollback-${held ? 'held' : 'fresh'}-before`);
      const cache = f.store.projectedSessionIdsForLastEvent();
      const historyIds = new Set(
        f.reader
          .listObservationHistory({ monitorId: 'span' })
          .map(({ id }) => id),
      );
      // The trigger refuses to inject its fault unless the earlier sibling is
      // already present inside this real owning transaction.
      f.writer.client.exec(`
        CREATE TRIGGER abort_admission BEFORE INSERT ON monitor_events
        WHEN NEW.summary = 'step-2'
        BEGIN
          SELECT CASE WHEN (SELECT count(*) FROM monitor_events WHERE summary = 'step-1') != 1
            THEN RAISE(ABORT, 'expected materialized prefix') END;
          SELECT RAISE(ROLLBACK, 'whole admission rollback');
        END;
      `);
      const failed = await f.runtime.tick(f.monitorsDir, f.root);
      captureAdmissionEvidence(f, `rollback-${held ? 'held' : 'fresh'}-failed`);
      expect.soft(failed.emittedEventIds).toEqual([]);
      expect.soft(failed.erroredObservations).toHaveLength(1);
      expect.soft(f.writer.client.inTransaction).toBe(false);
      expect.soft(f.barrier.calls).toEqual([]);
      expect.soft(f.reader.getMonitorState('span', f.root)).toEqual(before);
      expect.soft(f.reader.listEvents()).toEqual([]);
      expect.soft(f.reader.listMaterializationRetries()).toEqual([]);
      for (const table of [
        'monitor_events',
        'monitor_snapshots',
        'session_event_state',
        'session_object_cursor',
        'materialization_retry_outbox',
      ]) {
        expect
          .soft(f.observer.client.prepare(`SELECT * FROM ${table}`).all())
          .toEqual([]);
      }
      expect.soft(f.store.projectedSessionIdsForLastEvent()).toEqual(cache);
      const failureHistory = f.reader
        .listObservationHistory({ monitorId: 'span' })
        .filter(({ id }) => !historyIds.has(id));
      expect
        .soft(failureHistory.map(({ result }) => result))
        .toEqual(['errored']);
      expect
        .soft(failureHistory[0]?.observationData)
        .toEqual({ error: 'whole admission rollback' });
      for (const session of f.sessions) {
        expect.soft(f.reader.listEvents({ sessionId: session.id })).toEqual([]);
        expect
          .soft(
            f.reader.getSessionObjectCursor(
              session.id,
              'span',
              'shared-object',
              f.root,
            ),
          )
          .toBeNull();
        expect
          .soft(f.reader.latestSnapshot('span', 'shared-object', f.root))
          .toBeNull();
      }
      // Drop only the owned fault and close the original writer. A fresh store
      // and runtime must observe the old baseline and recover all three steps.
      f.writer.client.exec('DROP TRIGGER abort_admission');
      f.writer.client.close();
      // Make the reopened source due: a scheduling skip cannot prove replay.
      clockTime += 2000;
      const restarted = f.makeRuntime(new RuntimeStore(f.connect().db));
      const replay = await restarted.tick(f.monitorsDir, f.root);
      captureAdmissionEvidence(
        f,
        `rollback-${held ? 'held' : 'fresh'}-reopened`,
      );
      expect.soft(replay.emittedEventIds).toHaveLength(3);
      expectPrefix(f, ['step-1', 'step-2', 'step-3'], 'deliver');
      expect
        .soft(f.sourceStates)
        .toEqual(held ? [undefined, 1, 1] : [undefined, undefined]);
      expect
        .soft(f.reader.getMonitorState('span', f.root).sourceState)
        .toBe(held ? 2 : 1);
      expect.soft(f.reader.listMaterializationRetries()).toEqual([]);
      expect.soft(f.barrier.calls).toHaveLength(3);
    });
  }

  it('preserves a nonempty committed recipient cache and prior event across native ROLLBACK, then replays the complete held span', async () => {
    const f = fixture(true);
    f.barrier.release();
    await f.runtime.tick(f.monitorsDir, f.root);
    const previousWorkspace = path.join(f.root, 'previous-workspace');
    const previousSession = f.runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'previous-committed-lead',
        workspacePath: previousWorkspace,
      }),
    );
    const prior = f.store.insertEvent({
      workspacePath: previousWorkspace,
      monitorId: 'previous-monitor',
      sourceName: 'admission-source',
      urgency: 'normal',
      title: 'Previous committed event',
      body: 'Preserve this prior event.',
      // Deliberately shares the new prefix summary: the SQL trigger must check
      // the new span's monitor/workspace, never accept this seed as its prefix.
      summary: 'step-1',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: null,
      baselineStrategy: 'incremental',
      queryScope: {},
      tags: [],
      createdAt: NOW,
    });
    const before = f.reader.getMonitorState('span', f.root);
    expect(before.sourceState).toBe(1);
    expect(before.notifyState.pendingDebounce?.observations).toHaveLength(3);
    expect(f.store.projectedSessionIdsForLastEvent()).toEqual([
      previousSession.id,
    ]);
    expect(f.reader.listEvents({ sessionId: previousSession.id })).toEqual([
      { ...prior, deliveryState: 'unread' },
    ]);
    const tables = [
      'monitor_events',
      'monitor_snapshots',
      'session_event_state',
      'session_object_cursor',
      'materialization_retry_outbox',
      'monitor_state',
    ];
    const priorRows = tables.map((table) =>
      f.observer.client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    captureAdmissionEvidence(f, 'rollback-committed-cache-before');
    clockTime = NOW.getTime() + 2000;
    f.writer.client.exec(`
      CREATE TRIGGER abort_new_span BEFORE INSERT ON monitor_events
      WHEN NEW.monitor_id = 'span' AND NEW.summary = 'step-2'
      BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM monitor_events
          WHERE monitor_id = NEW.monitor_id AND workspace_path = NEW.workspace_path
          AND summary = 'step-1') != 1
          THEN RAISE(ABORT, 'expected new span prefix, not prior seed') END;
        SELECT RAISE(ROLLBACK, 'committed-cache admission rollback');
      END;
    `);
    const failed = await f.runtime.tick(f.monitorsDir, f.root);
    captureAdmissionEvidence(f, 'rollback-committed-cache-failed');
    expect.soft(failed.emittedEventIds).toEqual([]);
    expect.soft(failed.erroredObservations).toEqual([
      {
        monitorId: 'span',
        message: 'committed-cache admission rollback',
      },
    ]);
    expect.soft(f.writer.client.inTransaction).toBe(false);
    expect.soft(f.barrier.calls).toEqual([]);
    expect
      .soft(f.store.projectedSessionIdsForLastEvent())
      .toEqual([previousSession.id]);
    expect.soft(f.reader.listEvents()).toEqual([prior]);
    expect
      .soft(f.reader.listEvents({ sessionId: previousSession.id }))
      .toEqual([{ ...prior, deliveryState: 'unread' }]);
    expect.soft(f.reader.getMonitorState('span', f.root)).toEqual(before);
    expect.soft(f.reader.listMaterializationRetries()).toEqual([]);
    for (const [index, table] of tables.entries()) {
      expect
        .soft(
          f.observer.client
            .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
            .all(),
        )
        .toEqual(priorRows[index]);
    }
    for (const session of f.sessions) {
      expect.soft(f.reader.listEvents({ sessionId: session.id })).toEqual([]);
      expect
        .soft(
          f.reader.getSessionObjectCursor(
            session.id,
            'span',
            'shared-object',
            f.root,
          ),
        )
        .toBeNull();
    }
    f.writer.client.exec('DROP TRIGGER abort_new_span');
    f.writer.client.close();
    clockTime += 2000;
    const restarted = f.makeRuntime(new RuntimeStore(f.connect().db));
    const replay = await restarted.tick(f.monitorsDir, f.root);
    captureAdmissionEvidence(f, 'rollback-committed-cache-reopened');
    expect.soft(replay.emittedEventIds).toHaveLength(3);
    expect.soft(f.sourceStates).toEqual([undefined, 1, 1]);
    expect.soft(f.reader.getMonitorState('span', f.root)).toEqual({
      sourceState: 2,
      notifyState: {},
      lastObservationAt: new Date(clockTime),
    });
    expect
      .soft(f.reader.listEvents({ sessionId: previousSession.id }))
      .toEqual([{ ...prior, deliveryState: 'unread' }]);
    expect.soft(f.reader.listMaterializationRetries()).toEqual([]);
    expect.soft(f.barrier.calls).toHaveLength(3);
    const events = f.reader
      .listEvents({ monitorId: 'span', workspacePath: f.root })
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(events.map(({ summary }) => summary)).toEqual([
      'step-1',
      'step-2',
      'step-3',
    ]);
    for (const session of f.sessions) {
      expect(
        f.reader
          .listEvents({ sessionId: session.id })
          .map(({ id }) => id)
          .sort(),
      ).toEqual(events.map(({ id }) => id).sort());
    }
    expect(f.reader.latestSnapshot('span', 'shared-object', f.root)).toEqual({
      content: 'omega',
    });
  });

  it('retains an ordered suffix when SQLite ABORT leaves the owning transaction alive', async () => {
    const f = fixture();
    f.barrier.release();
    f.writer.client.exec(`
      CREATE TRIGGER abort_one_event BEFORE INSERT ON monitor_events
      WHEN NEW.summary = 'step-2'
      BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM monitor_events WHERE summary = 'step-1') != 1
          THEN RAISE(ABORT, 'expected materialized prefix') END;
        SELECT RAISE(ABORT, 'savepoint-local abort');
      END;
    `);
    const result = await f.runtime.tick(f.monitorsDir, f.root);
    captureAdmissionEvidence(f, 'abort-control');
    expect(result.emittedEventIds).toHaveLength(1);
    expect(result.erroredObservations).toHaveLength(1);
    expect(f.reader.listEvents().map(({ summary }) => summary)).toEqual([
      'step-1',
    ]);
    expect(
      f.reader
        .listMaterializationRetries()
        .map(({ envelope }) => envelope.observation.summary),
    ).toEqual(['step-2', 'step-3']);
    expect(f.reader.getMonitorState('span', f.root)).toEqual({
      sourceState: 1,
      notifyState: {},
      lastObservationAt: NOW,
    });
    expect(f.barrier.calls).toHaveLength(1);
  });
});

/** Captured source identity is part of a held envelope, per 002 §3 and §15. */
describe('held retry routing after source-type edits', () => {
  for (const strategy of ['debounce', 'rollup'] as const) {
    for (const fail of [false, true]) {
      it(`preserves captured ${strategy} envelopes after a source edit with ${fail ? 'failed' : 'successful'} materialization`, async () => {
        const f = fixture(strategy === 'rollup' ? 'rollup' : true);
        f.barrier.release();
        await f.runtime.tick(f.monitorsDir, f.root);
        const before = f.reader.getMonitorState('span', f.root);
        const envelopes =
          strategy === 'rollup'
            ? before.notifyState.pendingRollup?.observations
            : before.notifyState.pendingDebounce?.observations;
        expect(envelopes).toHaveLength(3);
        const monitorFile = path.join(f.monitorsDir, 'span', 'MONITOR.md');
        writeFileSync(
          monitorFile,
          readFileSync(monitorFile, 'utf8')
            .replace('type: admission-source', 'type: replacement-source')
            .replace('urgency: normal', 'urgency: low')
            .replace('Inspect the changes.', 'Replacement instructions.'),
        );
        clockTime = NOW.getTime() + (strategy === 'rollup' ? 60_000 : 2000);
        if (fail) {
          // A real savepoint-local SQLite fault allows ordinary suffix retention.
          f.writer.client.exec(`
            CREATE TRIGGER fail_old_envelope BEFORE INSERT ON monitor_events
            WHEN NEW.summary = 'step-2'
            BEGIN SELECT RAISE(ABORT, 'old envelope materialization failed'); END;
          `);
        }
        const result = await f.runtime.tick(f.monitorsDir, f.root);
        captureAdmissionEvidence(
          f,
          `route-${strategy}-${fail ? 'fault' : 'success'}`,
        );
        expect(result.emittedEventIds).toHaveLength(fail ? 1 : 3);
        expect(result.erroredObservations).toHaveLength(fail ? 1 : 0);
        const retries = f.reader.listMaterializationRetries();
        expect(retries.map(({ sourceName }) => sourceName)).toEqual(
          fail ? ['admission-source', 'admission-source'] : [],
        );
        // Held JSON stores timestamp strings; retry reads restore native Dates.
        // Compare their persisted representation to preserve every captured field.
        expect(JSON.stringify(retries.map(({ envelope }) => envelope))).toBe(
          JSON.stringify(fail ? envelopes?.slice(1) : []),
        );
        const events = f.reader
          .listEvents()
          .sort((a, b) => a.id.localeCompare(b.id));
        expect(events.map(({ summary }) => summary)).toEqual(
          fail ? ['step-1'] : ['step-1', 'step-2', 'step-3'],
        );
        for (const event of events) {
          expect(event).toMatchObject({
            sourceName: 'admission-source',
            body: 'Inspect the changes.',
            urgency: 'normal',
            createdAt: NOW,
          });
        }
        const state = f.reader.getMonitorState('span', f.root);
        expect(state.sourceState).toBe(1);
        expect(state.notifyState.pendingDebounce).toBeUndefined();
        expect(state.notifyState.pendingRollup).toBeUndefined();
        expect(state.lastObservationAt).toEqual(new Date(clockTime));
        const reopened = new RuntimeStore(f.connect().db);
        expect(reopened.listMaterializationRetries()).toEqual(retries);
        expect(reopened.getMonitorState('span', f.root)).toEqual(state);
      });
    }
  }
});
