/**
 * Poll admission is one durable finite span before optional interpretation.
 * Independent readers observe committed events or ordered retained obligations,
 * never a source/notify advance whose corresponding work has disappeared.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
function fixture(debounce = false) {
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
${debounce ? 'notify:\n  strategy: debounce\n  settle-for: 1s\n' : ''}---
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
function expectPrefix(f: ReturnType<typeof fixture>, expected: string[]) {
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
      interpret_decision: null,
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
