import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type { InterpretAdapter } from '../adapter/interpret.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationSource } from '../observation/types.js';
import { AgentMonitorRuntime } from '../runtime/service.js';
import { RuntimeStore } from '../runtime/store.js';
import {
  EXTERNAL_INGRESS_PENDING_MAX_BYTES,
  EXTERNAL_INGRESS_PENDING_MAX_RECORDS,
} from '../runtime/types.js';
import type { ExternalEventIngestInput } from './contract.js';
import {
  EXTERNAL_EVENT_SCHEMA,
  ExternalEventIngestError,
} from './contract.js';
import { externalEventObjectKey } from './identity.js';

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
  snapshotFailures = 0;

  override saveSnapshot(
    input: Parameters<RuntimeStore['saveSnapshot']>[0],
  ): void {
    super.saveSnapshot(input);
    if (this.snapshotFailures-- > 0) {
      throw new Error('injected snapshot failure with PRIVATE-STATE');
    }
  }
}

const reconcileSource: ObservationSource = {
  name: 'reconcile-source',
  scopeSchema: { type: 'object', additionalProperties: true },
  stateful: true,
  observe() {
    return Promise.resolve({ observations: [], nextState: { cursor: 8 } });
  },
};

function eventInput(
  workspaceIdentity: string,
  overrides: Partial<ExternalEventIngestInput['envelope']> = {},
): ExternalEventIngestInput {
  return {
    workspaceIdentity,
    envelope: {
      schema: EXTERNAL_EVENT_SCHEMA,
      monitorId: 'build-health',
      source: 'example-build-system',
      upstreamEventId: 'delivery-1',
      objectId: 'build-group-1',
      objectSequence: 1,
      eventKind: 'build.updated',
      changeKind: 'modified',
      occurredAt: '2026-08-13T17:59:59.000Z',
      resumeToken: 'private-relay-cursor',
      scope: { project: 'example/widgets' },
      state: { z: 2, a: 1 },
      ...overrides,
    },
  };
}

function writeMonitor(
  rootDir: string,
  policy = '',
  instructions = 'Handle the original instructions.',
): string {
  const monitorsDir = path.join(rootDir, '.claude', 'monitors');
  const monitorDir = path.join(monitorsDir, 'build-health');
  const urgency = /^urgency:/m.test(policy) ? '' : 'urgency: normal\n';
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(
    path.join(monitorDir, 'MONITOR.md'),
    `---
name: Build health
watch:
  type: reconcile-source
  interval: 1s
${urgency}baseline-strategy: incremental
${policy}---
${instructions}
`,
    'utf8',
  );
  return monitorsDir;
}

function fixture(
  policy = '',
  options: { faultStore?: boolean; interpretAdapter?: InterpretAdapter } = {},
) {
  const rootDir = mkdtempSync(
    path.join(tmpdir(), 'agentmon-external-runtime-'),
  );
  tempDirs.push(rootDir);
  const monitorsDir = writeMonitor(rootDir, policy);
  const db = createDb(path.join(rootDir, 'agentmon.db'));
  const store = options.faultStore ? new FaultStore(db) : new RuntimeStore(db);
  const registry = new SourceRegistry();
  registry.register(reconcileSource);
  const runtime = new AgentMonitorRuntime(
    store,
    registry,
    [claudeCodeAdapter],
    options.interpretAdapter,
  );
  return { rootDir, monitorsDir, store, runtime };
}

async function ingestError(
  promise: Promise<unknown>,
): Promise<ExternalEventIngestError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalEventIngestError);
    return error as ExternalEventIngestError;
  }
  throw new Error('Expected external ingestion to fail.');
}

describe('AgentMonitorRuntime.ingestExternalEvent', () => {
  it('atomically materializes and correlates an immediate event without changing reconciliation state', async () => {
    const f = fixture();
    const previousObservation = new Date('2026-08-13T17:00:00.000Z');
    f.store.setMonitorState('build-health', f.rootDir, {
      sourceState: { cursor: 7 },
      notifyState: {},
      lastObservationAt: previousObservation,
    });

    const result = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir),
      f.monitorsDir,
      NOW,
    );

    expect(result).toMatchObject({
      disposition: 'accepted',
      outcome: 'materialized',
      monitorId: 'build-health',
      upstreamEventId: 'delivery-1',
      acceptedAt: NOW.toISOString(),
      materializedAt: NOW.toISOString(),
    });
    expect(result.eventIds).toHaveLength(1);
    const event = f.runtime.listEvents({ workspacePath: f.rootDir })[0];
    expect(event).toMatchObject({
      id: result.eventIds[0],
      monitorId: 'build-health',
      sourceName: 'example-build-system',
      title: 'Build health',
      summary: 'build.updated: build-group-1',
      snapshotText: '{"a":1,"z":2}',
      objectKey: externalEventObjectKey(
        'example-build-system',
        'build-group-1',
      ),
      queryScope: {
        project: 'example/widgets',
        ingressSource: 'example-build-system',
        eventKind: 'build.updated',
        upstreamEventId: 'delivery-1',
        objectSequence: '1',
      },
    });
    expect(
      f.store.externalEventReceiptStatus(f.rootDir, result.receiptId),
    ).toMatchObject({ outcome: 'materialized', eventIds: result.eventIds });
    expect(f.store.getMonitorState('build-health', f.rootDir)).toEqual({
      sourceState: { cursor: 7 },
      notifyState: {},
      lastObservationAt: previousObservation,
    });
  });

  it('returns duplicate, conflict, and stale decisions without extra materialization', async () => {
    const f = fixture();
    const input = eventInput(f.rootDir, { objectSequence: 2 });
    const accepted = await f.runtime.ingestExternalEvent(
      input,
      f.monitorsDir,
      NOW,
    );
    const duplicate = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir, {
        objectSequence: 2,
        resumeToken: 'replayed-cursor',
      }),
      f.monitorsDir,
      new Date(NOW.getTime() + 1_000),
    );
    const conflict = await ingestError(
      f.runtime.ingestExternalEvent(
        eventInput(f.rootDir, {
          objectSequence: 2,
          state: { status: 'failed', secret: 'PRIVATE-STATE' },
        }),
        f.monitorsDir,
        new Date(NOW.getTime() + 2_000),
      ),
    );
    const stale = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir, {
        upstreamEventId: 'delivery-stale',
        objectSequence: 1,
      }),
      f.monitorsDir,
      new Date(NOW.getTime() + 3_000),
    );

    expect(duplicate).toMatchObject({
      disposition: 'duplicate',
      receiptId: accepted.receiptId,
      eventIds: accepted.eventIds,
    });
    expect(conflict.toExternalEventError()).toEqual({
      code: 'idempotency_conflict',
      message: 'External event idempotency key conflicts with prior input.',
      retryable: false,
    });
    expect(JSON.stringify(conflict.toExternalEventError())).not.toContain(
      'PRIVATE-STATE',
    );
    expect(stale).toMatchObject({
      disposition: 'accepted',
      outcome: 'stale',
      eventIds: [],
    });
    expect(f.runtime.listEvents({ workspacePath: f.rootDir })).toHaveLength(1);
  });

  it('records shape suppression without advancing notify or creating an event', async () => {
    const f = fixture(`payload:
  form: structured
  transform:
    language: cel
    expression: "status == 'failed'"
`);
    const result = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir, { state: { status: 'passed' } }),
      f.monitorsDir,
      NOW,
    );

    expect(result).toMatchObject({ outcome: 'suppressed', eventIds: [] });
    expect(f.runtime.listEvents({ workspacePath: f.rootDir })).toEqual([]);
    expect(
      f.store.getMonitorState('build-health', f.rootDir).notifyState,
    ).toEqual({});
  });

  it.each([
    ['high-urgency default', 'urgency: high\n', 15_000],
    [
      'explicit debounce',
      'notify:\n  strategy: debounce\n  settle-for: 1m\n',
      60_000,
    ],
  ])('durably holds the %s notify policy', async (_name, policy, settleMs) => {
    const f = fixture(policy);
    const result = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir),
      f.monitorsDir,
      NOW,
    );
    const pending = f.store.getMonitorState('build-health', f.rootDir)
      .notifyState.pendingDebounce;

    expect(result).toMatchObject({ outcome: 'held', eventIds: [] });
    expect(pending?.dueAt).toBe(
      new Date(NOW.getTime() + settleMs).toISOString(),
    );
    expect(pending?.observations).toMatchObject([
      {
        ingressReceiptId: result.receiptId,
        sourceName: 'example-build-system',
        ingressStoredBytes: expect.any(Number),
      },
    ]);
    const captured = pending?.observations[0];
    expect(captured?.ingressStoredBytes).toBe(
      Buffer.byteLength(JSON.stringify(captured), 'utf8'),
    );
  });

  it('extends a burst only for new input and flushes its captured monitor on a normal tick', async () => {
    const policy = 'notify:\n  strategy: debounce\n  settle-for: 1m\n';
    const f = fixture(policy);
    const first = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir),
      f.monitorsDir,
      NOW,
    );
    const firstDue = f.store.getMonitorState('build-health', f.rootDir)
      .notifyState.pendingDebounce?.dueAt;
    const duplicate = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir, { resumeToken: 'replay' }),
      f.monitorsDir,
      new Date(NOW.getTime() + 30_000),
    );
    expect(duplicate.disposition).toBe('duplicate');
    expect(
      f.store.getMonitorState('build-health', f.rootDir).notifyState
        .pendingDebounce?.dueAt,
    ).toBe(firstDue);

    const second = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir, {
        upstreamEventId: 'delivery-2',
        objectSequence: 2,
      }),
      f.monitorsDir,
      new Date(NOW.getTime() + 30_000),
    );
    const third = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir, {
        upstreamEventId: 'delivery-3',
        objectId: 'build-group-2',
        objectSequence: 1,
      }),
      f.monitorsDir,
      new Date(NOW.getTime() + 60_000),
    );
    const pending = f.store.getMonitorState('build-health', f.rootDir)
      .notifyState.pendingDebounce;
    expect(pending?.observations).toHaveLength(3);
    expect(pending?.dueAt).toBe(
      new Date(NOW.getTime() + 120_000).toISOString(),
    );

    writeMonitor(f.rootDir, policy, 'Edited instructions for future input.');
    vi.setSystemTime(NOW.getTime() + 121_000);
    expect(
      (await f.runtime.tick(f.monitorsDir, f.rootDir)).emittedEventIds,
    ).toHaveLength(3);
    expect(
      f.runtime
        .listEvents({ workspacePath: f.rootDir })
        .map(({ body }) => body),
    ).toEqual(Array(3).fill('Handle the original instructions.'));
    for (const receipt of [first, second, third]) {
      expect(
        f.store.externalEventReceiptStatus(f.rootDir, receipt.receiptId),
      ).toMatchObject({
        outcome: 'materialized',
        eventIds: [expect.any(String)],
        materializedAt: new Date(NOW.getTime() + 121_000),
      });
    }
    expect(
      f.store.getMonitorState('build-health', f.rootDir).notifyState
        .pendingDebounce,
    ).toBeUndefined();
  });

  it.each([
    ['throttle', 'notify:\n  strategy: throttle\n  suppress-for: 1m\n'],
    ['rollup', 'notify:\n  strategy: rollup\n  window: "0 9 * * *"\n'],
    ['overlong debounce', 'notify:\n  strategy: debounce\n  settle-for: 6m\n'],
  ])(
    'rejects unsupported %s before receipt creation',
    async (_name, policy) => {
      const f = fixture(policy);
      const input = eventInput(f.rootDir);
      const error = await ingestError(
        f.runtime.ingestExternalEvent(input, f.monitorsDir, NOW),
      );
      expect(error.toExternalEventError()).toMatchObject({
        code: 'unsupported_notify_strategy',
        retryable: false,
      });
      expect(
        f.store.externalObjectSequence(
          f.rootDir,
          'build-health',
          'example-build-system',
          'build-group-1',
        ),
      ).toBeNull();

      writeMonitor(
        f.rootDir,
        'notify:\n  strategy: debounce\n  settle-for: 1m\n',
      );
      await expect(
        f.runtime.ingestExternalEvent(input, f.monitorsDir, NOW),
      ).resolves.toMatchObject({ disposition: 'accepted', outcome: 'held' });
    },
  );

  it.each([
    ['record count', EXTERNAL_INGRESS_PENDING_MAX_RECORDS, 1],
    ['stored bytes', 8, EXTERNAL_INGRESS_PENDING_MAX_BYTES / 8],
  ])(
    'rejects %s overflow without retaining a receipt',
    async (_name, count, bytes) => {
      const f = fixture('notify:\n  strategy: debounce\n  settle-for: 1m\n');
      await f.runtime.ingestExternalEvent(
        eventInput(f.rootDir),
        f.monitorsDir,
        NOW,
      );
      const held = f.store.getMonitorState('build-health', f.rootDir)
        .notifyState.pendingDebounce?.observations[0];
      if (!held) throw new Error('expected held envelope');
      f.store.setMonitorState('build-health', f.rootDir, {
        notifyState: {
          pendingDebounce: {
            observations: Array.from({ length: count }, () => ({
              ...held,
              ingressStoredBytes: bytes,
            })),
            dueAt: new Date(NOW.getTime() + 60_000).toISOString(),
          },
        },
      });
      const overflow = eventInput(f.rootDir, {
        upstreamEventId: 'delivery-overflow',
        objectSequence: 2,
      });
      const error = await ingestError(
        f.runtime.ingestExternalEvent(
          overflow,
          f.monitorsDir,
          new Date(NOW.getTime() + 1_000),
        ),
      );
      expect(error.toExternalEventError()).toMatchObject({
        code: 'capacity_exceeded',
        retryable: true,
      });

      f.store.setMonitorState('build-health', f.rootDir, { notifyState: {} });
      await expect(
        f.runtime.ingestExternalEvent(
          overflow,
          f.monitorsDir,
          new Date(NOW.getTime() + 2_000),
        ),
      ).resolves.toMatchObject({ disposition: 'accepted' });
    },
  );

  it('rolls back the receipt, sequence, event, and monitor state when materialization fails', async () => {
    const f = fixture('', { faultStore: true });
    const store = f.store as FaultStore;
    store.setMonitorState('build-health', f.rootDir, {
      sourceState: { cursor: 7 },
      notifyState: {},
      lastObservationAt: new Date(NOW.getTime() - 60_000),
    });
    const before = store.getMonitorState('build-health', f.rootDir);
    store.snapshotFailures = 1;
    const input = eventInput(f.rootDir, {
      state: { status: 'passed', secret: 'PRIVATE-STATE' },
    });
    const error = await ingestError(
      f.runtime.ingestExternalEvent(input, f.monitorsDir, NOW),
    );

    expect(error.toExternalEventError()).toEqual({
      code: 'storage_failure',
      message: 'External event could not be committed durably.',
      retryable: true,
    });
    expect(JSON.stringify(error.toExternalEventError())).not.toContain(
      'PRIVATE-STATE',
    );
    expect(f.runtime.listEvents({ workspacePath: f.rootDir })).toEqual([]);
    expect(store.getMonitorState('build-health', f.rootDir)).toEqual(before);
    expect(
      store.externalObjectSequence(
        f.rootDir,
        'build-health',
        'example-build-system',
        'build-group-1',
      ),
    ).toBeNull();
    await expect(
      f.runtime.ingestExternalEvent(input, f.monitorsDir, NOW),
    ).resolves.toMatchObject({ disposition: 'accepted' });
  });

  it('correlates a failed ordinary flush through the retry outbox', async () => {
    const f = fixture('notify:\n  strategy: debounce\n  settle-for: 1s\n', {
      faultStore: true,
    });
    const store = f.store as FaultStore;
    const held = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir),
      f.monitorsDir,
      NOW,
    );
    store.snapshotFailures = 1;
    vi.setSystemTime(NOW.getTime() + 1_000);
    await f.runtime.tick(f.monitorsDir, f.rootDir);
    expect(
      store.externalEventReceiptStatus(f.rootDir, held.receiptId),
    ).toMatchObject({ outcome: 'held', eventIds: [] });
    expect(store.listMaterializationRetries()).toMatchObject([
      {
        sourceName: 'example-build-system',
        envelope: { ingressReceiptId: held.receiptId },
      },
    ]);

    vi.setSystemTime(NOW.getTime() + 2_000);
    await f.runtime.tick(f.monitorsDir, f.rootDir);
    expect(store.listMaterializationRetries()).toEqual([]);
    expect(
      store.externalEventReceiptStatus(f.rootDir, held.receiptId),
    ).toMatchObject({
      outcome: 'materialized',
      eventIds: [expect.any(String)],
      materializedAt: new Date(NOW.getTime() + 2_000),
    });
  });

  it('classifies invalid routing without exposing envelope state', async () => {
    const f = fixture();
    const error = await ingestError(
      f.runtime.ingestExternalEvent(
        eventInput(f.rootDir, {
          monitorId: 'missing-monitor',
          state: { secret: 'PRIVATE-STATE' },
        }),
        f.monitorsDir,
        NOW,
      ),
    );
    expect(error.toExternalEventError()).toMatchObject({
      code: 'invalid_monitor',
      retryable: false,
    });
    expect(JSON.stringify(error.toExternalEventError())).not.toContain(
      'PRIVATE-STATE',
    );
  });

  it('commits before starting best-effort Interpret work', async () => {
    let interpretCalls = 0;
    const interpretAdapter: InterpretAdapter = {
      name: 'never-finishes',
      interpret() {
        interpretCalls += 1;
        return new Promise(() => undefined);
      },
    };
    const f = fixture('payload:\n  form: prose\n', { interpretAdapter });
    f.runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'external-interpret-session',
        workspacePath: f.rootDir,
      }),
    );
    await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir, { state: { version: 1 } }),
      f.monitorsDir,
      NOW,
    );
    const second = await f.runtime.ingestExternalEvent(
      eventInput(f.rootDir, {
        upstreamEventId: 'delivery-2',
        objectSequence: 2,
        state: { version: 2 },
      }),
      f.monitorsDir,
      new Date(NOW.getTime() + 1_000),
    );

    expect(second.outcome).toBe('materialized');
    expect(interpretCalls).toBeGreaterThan(0);
  });
});
