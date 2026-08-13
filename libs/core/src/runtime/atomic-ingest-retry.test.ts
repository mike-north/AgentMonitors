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
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationContext,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import type {
  EnqueueMaterializationRetryInput,
  MaterializationRetryRecord,
  RuntimeTickResult,
} from './types.js';

const NOW = new Date('2026-08-13T18:00:00.000Z');
const tempDirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FaultStore extends RuntimeStore {
  failedSummary: string | undefined;
  eventFailures = 0;
  stateFailures = 0;
  outboxFailures = 0;
  cursorFailures = 0;
  snapshotFailures = 0;

  override insertEvent(...args: Parameters<RuntimeStore['insertEvent']>) {
    const [input] = args;
    if (input.summary === this.failedSummary && this.eventFailures > 0) {
      this.eventFailures -= 1;
      throw new Error(`insert failure for ${input.summary}`);
    }
    return super.insertEvent(...args);
  }

  override seedSessionObjectCursor(
    input: Parameters<RuntimeStore['seedSessionObjectCursor']>[0],
  ): void {
    super.seedSessionObjectCursor(input);
    if (this.cursorFailures-- > 0) throw new Error('cursor write failed');
  }

  override saveSnapshot(
    input: Parameters<RuntimeStore['saveSnapshot']>[0],
  ): void {
    super.saveSnapshot(input);
    if (this.snapshotFailures-- > 0) throw new Error('snapshot write failed');
  }

  override setMonitorState(
    ...args: Parameters<RuntimeStore['setMonitorState']>
  ): void {
    const shouldFail = this.stateFailures-- > 0;
    super.setMonitorState(...args);
    if (shouldFail) throw new Error('monitor state write failed');
  }

  override enqueueMaterializationRetries(
    inputs: EnqueueMaterializationRetryInput[],
    now?: Date,
  ): MaterializationRetryRecord[] {
    const shouldFail = this.outboxFailures-- > 0;
    const records = super.enqueueMaterializationRetries(inputs, now);
    if (shouldFail) throw new Error('retry outbox write failed');
    return records;
  }
}

interface RecordingInterpretAdapter extends InterpretAdapter {
  calls: InterpretInput[];
}

function recordingInterpretAdapter(): RecordingInterpretAdapter {
  const calls: InterpretInput[] = [];
  return {
    name: 'recording-interpret',
    calls,
    interpret(input: InterpretInput): Promise<InterpretResult> {
      calls.push(input);
      return Promise.resolve({ decision: 'deliver', digest: input.delta });
    },
  };
}

function createFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-atomic-ingest-'));
  tempDirs.push(rootDir);
  const monitorDir = path.join(rootDir, '.claude/monitors/test-monitor');
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(
    path.join(monitorDir, 'MONITOR.md'),
    `---
name: Test monitor
watch:
  type: retry-source
  interval: 1s
urgency: normal
payload:
  form: prose
baseline-strategy: incremental
---
Handle it.
`,
    'utf8',
  );
  return {
    rootDir,
    dbPath: path.join(rootDir, 'agentmon.db'),
    monitorsDir: path.join(rootDir, '.claude/monitors'),
  };
}

function createSource(observedStates: unknown[]): ObservationSource {
  return {
    name: 'retry-source',
    scopeSchema: { type: 'object' },
    stateful: true,
    observe(_config, context: ObservationContext) {
      observedStates.push(context.previousState);
      const cursor = (context.previousState as { cursor?: number } | undefined)
        ?.cursor;
      return Promise.resolve(
        cursor === 1
          ? { observations: [], nextState: { cursor: 1 } }
          : {
              observations: ['first', 'second'].map((summary) => ({
                title: summary,
                summary,
                objectKey: summary,
                snapshotText: `${summary}-state`,
              })),
              nextState: { cursor: 1 },
            },
      );
    },
  };
}

function createRuntime(
  store: RuntimeStore,
  source: ObservationSource,
  interpret: InterpretAdapter,
) {
  const registry = new SourceRegistry();
  registry.register(source);
  return new AgentMonitorRuntime(
    store,
    registry,
    [claudeCodeAdapter],
    interpret,
  );
}

function setup() {
  const fixture = createFixture();
  const observedStates: unknown[] = [];
  const source = createSource(observedStates);
  const db = createDb(fixture.dbPath);
  const store = new FaultStore(db);
  const interpret = recordingInterpretAdapter();
  const runtime = createRuntime(store, source, interpret);
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'atomic-ingest-session',
      workspacePath: fixture.rootDir,
    }),
  );
  return {
    ...fixture,
    client: (db as unknown as { $client: BetterSQLiteClient }).$client,
    observedStates,
    source,
    store,
    runtime,
    interpret,
    session,
  };
}

function summaries(store: RuntimeStore, ids: string[]): string[] {
  return ids.map((id) => store.getEventById(id).summary);
}

function expectTick(
  result: RuntimeTickResult,
  store: RuntimeStore,
  expected: { emitted?: string[]; errors?: string[] },
) {
  expect({
    ...result,
    emittedEventIds: summaries(store, result.emittedEventIds),
  }).toEqual({
    evaluatedMonitors: ['test-monitor'],
    emittedEventIds: expected.emitted ?? [],
    erroredObservations: (expected.errors ?? []).map((message) => ({
      monitorId: 'test-monitor',
      message,
    })),
    skippedMonitors: [],
  });
}

function history(runtime: AgentMonitorRuntime) {
  return runtime
    .listObservationHistory({ monitorId: 'test-monitor' })
    .map(({ result, observationData }) => ({ result, observationData }));
}

function interpretDeltas(adapter: RecordingInterpretAdapter): string[] {
  return adapter.calls.map(({ delta }) => delta);
}

describe('atomic poll ingest', () => {
  type Fixture = ReturnType<typeof setup>;
  const faults: {
    name: string;
    message: string;
    emitted: string[];
    queued: string[];
    configure(fixture: Fixture): void;
    cleanup?(fixture: Fixture): void;
  }[] = [
    {
      name: 'first event',
      message: 'insert failure for first',
      emitted: [],
      queued: ['first', 'second'],
      configure: (f) => {
        f.store.failedSummary = 'first';
        f.store.eventFailures = 1;
      },
    },
    {
      name: 'later event',
      message: 'insert failure for second',
      emitted: ['first'],
      queued: ['second'],
      configure: (f) => {
        f.store.failedSummary = 'second';
        f.store.eventFailures = 1;
      },
    },
    {
      name: 'cursor',
      message: 'cursor write failed',
      emitted: [],
      queued: ['first', 'second'],
      configure: (f) => {
        f.store.cursorFailures = 1;
      },
    },
    {
      name: 'projection',
      message: 'projection write failed',
      emitted: [],
      queued: ['first', 'second'],
      configure: (f) => {
        f.client.exec(`CREATE TRIGGER fail_runtime_projection
          BEFORE INSERT ON session_event_state BEGIN
          SELECT RAISE(ABORT, 'projection write failed'); END;`);
      },
      cleanup: (f) => f.client.exec('DROP TRIGGER fail_runtime_projection'),
    },
    {
      name: 'snapshot',
      message: 'snapshot write failed',
      emitted: [],
      queued: ['first', 'second'],
      configure: (f) => {
        f.store.snapshotFailures = 1;
      },
    },
  ];

  for (const fault of faults) {
    it(`commits only truthful results for a failed ${fault.name} write`, async () => {
      const f = setup();
      fault.configure(f);

      const result = await f.runtime.tick(f.monitorsDir, f.rootDir);
      const reported =
        fault.queued.length === 1
          ? fault.message
          : `${String(fault.queued.length)} observations were queued for materialization retry. First error: ${fault.message}`;
      expectTick(result, f.store, {
        emitted: fault.emitted,
        errors: [reported],
      });
      expect(
        f.store.getMonitorState('test-monitor', f.rootDir).sourceState,
      ).toEqual({ cursor: 1 });
      expect(
        f.store
          .listMaterializationRetries()
          .map(({ envelope }) => envelope.observation.summary),
      ).toEqual(fault.queued);
      expect(
        f.runtime
          .listEvents({ monitorId: 'test-monitor' })
          .map(({ summary }) => summary),
      ).toEqual([...fault.emitted].reverse());
      expect(interpretDeltas(f.interpret)).toEqual(
        fault.emitted.map((summary) => `${summary}-state`),
      );
      expect(history(f.runtime)).toEqual([
        { result: 'errored', observationData: { error: fault.message } },
        ...(fault.emitted.length === 1
          ? [
              {
                result: 'triggered' as const,
                observationData: { observed: 2, emitted: 1 },
              },
            ]
          : []),
      ]);
      if (fault.emitted.length === 0) {
        expect(f.runtime.listEvents({ sessionId: f.session.id })).toEqual([]);
        expect(
          f.store.getSessionObjectCursor(
            f.session.id,
            'test-monitor',
            'first',
            f.rootDir,
          ),
        ).toBeNull();
        expect(
          f.store.latestSnapshot('test-monitor', 'first', f.rootDir),
        ).toBeNull();
      }
      fault.cleanup?.(f);
    });
  }

  for (const [fault, message] of [
    ['state', 'monitor state write failed'],
    ['outbox', 'retry outbox write failed'],
  ] as const) {
    it(`rolls back the batch and Interpret on ${fault} failure, then replays after restart`, async () => {
      const f = setup();
      if (fault === 'state') {
        f.store.stateFailures = 1;
      } else {
        f.store.failedSummary = 'second';
        f.store.eventFailures = 1;
        f.store.outboxFailures = 1;
      }

      const failed = await f.runtime.tick(f.monitorsDir, f.rootDir);
      expectTick(failed, f.store, { errors: [message] });
      expect(f.runtime.listEvents({ monitorId: 'test-monitor' })).toEqual([]);
      expect(f.store.listMaterializationRetries()).toEqual([]);
      expect(
        f.store.getMonitorState('test-monitor', f.rootDir).sourceState,
      ).toBeUndefined();
      expect(interpretDeltas(f.interpret)).toEqual([]);
      expect(history(f.runtime)).toEqual([
        { result: 'errored', observationData: { error: message } },
      ]);

      vi.setSystemTime(NOW.getTime() + 1_000);
      const reopenedStore = new RuntimeStore(createDb(f.dbPath));
      const restarted = createRuntime(reopenedStore, f.source, f.interpret);
      const replayed = await restarted.tick(f.monitorsDir, f.rootDir);
      expectTick(replayed, reopenedStore, { emitted: ['first', 'second'] });
      expect(f.observedStates).toEqual([undefined, undefined]);
      expect(interpretDeltas(f.interpret)).toEqual([
        'first-state',
        'second-state',
      ]);
      expect(history(restarted)).toEqual([
        {
          result: 'triggered',
          observationData: { observed: 2, emitted: 2 },
        },
        { result: 'errored', observationData: { error: message } },
      ]);
    });
  }
});
