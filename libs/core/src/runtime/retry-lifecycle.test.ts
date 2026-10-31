/**
 * Outcome tests for the retry lifecycle: retained work survives every failed
 * transition, and only an atomic event commit may consume a pending record.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database as BetterSQLiteClient } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';
import type {
  EnqueueMaterializationRetryInput,
  MonitorEventRecord,
} from './types.js';

/** Deterministic times keep persisted second-resolution backoff assertions exact. */
const NOW = new Date('2026-10-31T12:00:00Z');
const clients: BetterSQLiteClient[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    if (client.open) client.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Each fixture owns its connections so reopen checks never reuse process-local state. */
function open(databasePath = ':memory:') {
  const db = createDb(databasePath);
  const client = (db as unknown as { $client: BetterSQLiteClient }).$client;
  clients.push(client);
  return { store: new RuntimeStore(db), client };
}

/** The stored observation and resulting event share one explicit route and object identity. */
function retryInput(): EnqueueMaterializationRetryInput {
  return {
    workspacePath: '/workspace',
    monitorId: 'retry-monitor',
    sourceName: 'test-source',
    error: 'first failure',
    envelope: {
      monitor: {
        id: 'retry-monitor',
        displayName: 'Retry monitor',
        filePath: '/workspace/MONITOR.md',
        instructions: 'Inspect changes.',
        frontmatter: {
          watch: { type: 'test-source' },
          urgency: 'normal',
          urgencyMax: 'normal',
          baselineStrategy: 'incremental',
        },
      },
      observation: {
        objectKey: 'object',
        title: 'Changed',
        snapshotText: 'after',
      },
      observedAt: NOW,
      effectiveUrgency: 'normal',
    },
  };
}

function eventInput(): Omit<MonitorEventRecord, 'id'> {
  return {
    workspacePath: '/workspace',
    monitorId: 'retry-monitor',
    sourceName: 'test-source',
    urgency: 'normal',
    title: 'Changed',
    body: 'Inspect changes.',
    summary: 'Object changed',
    payload: {},
    snapshotMetadata: {},
    snapshotText: 'after',
    diffText: null,
    objectKey: 'object',
    baselineStrategy: 'incremental',
    queryScope: {},
    tags: [],
    createdAt: NOW,
  };
}

function enqueue(store: RuntimeStore): string {
  const row = store.enqueueMaterializationRetries([retryInput()], NOW)[0];
  if (!row) throw new Error('Expected durable retry');
  return row.id;
}

/** Reach the terminal state through public failed-attempt transitions. */
function terminalize(store: RuntimeStore, id: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    store.markMaterializationRetryFailed(id, `failure ${String(attempt)}`, NOW);
  }
}

function openLead(store: RuntimeStore): string {
  return store.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'retry-lead',
      workspacePath: '/workspace',
    }),
  ).id;
}

describe('retry lifecycle safety', () => {
  it('keeps terminal work unchanged until explicitly rearmed before completion', () => {
    const { store } = open();
    const id = enqueue(store);
    terminalize(store, id);
    const terminal = store.getMaterializationRetry(id);
    expect(() =>
      Reflect.apply(store.completeMaterializationRetry, store, [
        id,
        () => store.insertEvent(eventInput()),
      ]),
    ).toThrow('terminal');
    expect(() => store.completeMaterializationRetry(id, eventInput())).toThrow(
      'terminal',
    );
    expect(store.getMaterializationRetry(id)).toEqual(terminal);
    expect(store.listEvents()).toEqual([]);
    store.rearmMaterializationRetry(id, NOW);
    const event = store.completeMaterializationRetry(id, eventInput());
    expect(store.getEventById(event.id)).toEqual(event);
    expect(store.listMaterializationRetries()).toEqual([]);
  });

  it('never invokes an async completion callback, even after its continuation could run', async () => {
    const { store } = open();
    const id = enqueue(store);
    let started = false;
    const escapedOperation = async () => {
      started = true;
      await Promise.resolve();
      return store.insertEvent(eventInput());
    };
    let thrown: unknown;
    try {
      // Runtime callers may bypass TypeScript; function input must fail before invocation.
      Reflect.apply(store.completeMaterializationRetry, store, [
        id,
        escapedOperation,
      ]);
    } catch (error) {
      thrown = error;
    }
    await Promise.resolve();
    expect(started).toBe(false);
    expect(thrown).toMatchObject({
      code: 'materialization_retry_invalid_transition',
    });
    expect(store.listEvents()).toEqual([]);
    expect(store.getMaterializationRetry(id).status).toBe('pending');
  });

  it('rejects synchronous callbacks without executing them', () => {
    const { store } = open();
    const id = enqueue(store);
    let invoked = false;
    expect(() =>
      Reflect.apply(store.completeMaterializationRetry, store, [
        id,
        () => {
          invoked = true;
          return 'fake success';
        },
      ]),
    ).toThrow();
    expect(invoked).toBe(false);
    expect(store.getMaterializationRetry(id).status).toBe('pending');
  });

  it.each(['workspacePath', 'monitorId', 'sourceName', 'objectKey'] as const)(
    'cannot consume a retry by materializing a different %s',
    (field) => {
      const { store } = open();
      const id = enqueue(store);
      expect(() =>
        store.completeMaterializationRetry(id, {
          ...eventInput(),
          [field]: 'another-route',
        }),
      ).toThrow();
      expect(store.getMaterializationRetry(id).status).toBe('pending');
      expect(store.listEvents()).toEqual([]);
    },
  );

  it.each([undefined, '', 'explicit-key'])(
    'accepts the real runtime materialization for observation object key %s',
    async (objectKey) => {
      const monitorsDir = mkdtempSync(
        path.join(tmpdir(), 'retry-object-identity-'),
      );
      directories.push(monitorsDir);
      const monitorDir = path.join(monitorsDir, 'retry-monitor');
      mkdirSync(monitorDir);
      writeFileSync(
        path.join(monitorDir, 'MONITOR.md'),
        `---
name: Retry monitor
watch:
  type: test-source
urgency: normal
---
Inspect changes.
`,
      );
      const observation = {
        title: 'Changed',
        snapshotText: 'after',
        ...(objectKey === undefined ? {} : { objectKey }),
      };
      const registry = new SourceRegistry();
      registry.register({
        name: 'test-source',
        scopeSchema: { type: 'object' },
        async observe() {
          return { observations: [observation] };
        },
      });
      const runtimeStore = open().store;
      const runtime = new AgentMonitorRuntime(runtimeStore, registry, [
        claudeCodeAdapter,
      ]);
      const tick = await runtime.tick(monitorsDir, '/workspace');
      expect(tick.emittedEventIds).toHaveLength(1);
      const rendered = runtimeStore.listEvents()[0];
      if (!rendered) throw new Error('Expected a real runtime event');
      expect(rendered.objectKey).toBe(objectKey ?? rendered.monitorId);

      // A separate database receives the already rendered event so the test
      // cannot invent a key convention independently of runtime materialization.
      const completionStore = open().store;
      const retained = retryInput();
      retained.envelope.observation = observation;
      const retry = completionStore.enqueueMaterializationRetries(
        [retained],
        NOW,
      )[0];
      if (!retry) throw new Error('Expected retained observation');
      const completed = completionStore.completeMaterializationRetry(
        retry.id,
        rendered,
      );
      expect(completed.objectKey).toBe(rendered.objectKey);
      expect(
        completionStore.latestSnapshot(
          'retry-monitor',
          rendered.objectKey ?? '',
          '/workspace',
        ),
      ).toEqual({ content: 'after' });
      expect(completionStore.listMaterializationRetries()).toEqual([]);
    },
  );

  it('rolls back event, projection, cursor, snapshot and retry deletion together', () => {
    const { store, client } = open();
    const sessionId = openLead(store);
    const id = enqueue(store);
    const before = store.getMaterializationRetry(id);
    // Fail after insertEvent has actually written every materialization table.
    client.exec(
      "CREATE TRIGGER fail_retry_delete BEFORE DELETE ON materialization_retry_outbox BEGIN SELECT RAISE(ABORT, 'retry deletion failed'); END",
    );
    expect(() =>
      store.completeMaterializationRetry(id, eventInput(), {
        previousContent: 'before',
      }),
    ).toThrow('retry deletion failed');
    expect(store.getMaterializationRetry(id)).toEqual(before);
    expect(store.listEvents()).toEqual([]);
    expect(store.listEvents({ sessionId })).toEqual([]);
    expect(
      store.getSessionObjectCursor(
        sessionId,
        'retry-monitor',
        'object',
        '/workspace',
      ),
    ).toBeNull();
    expect(
      store.latestSnapshot('retry-monitor', 'object', '/workspace'),
    ).toBeNull();
    expect(store.projectedSessionIdsForLastEvent()).toEqual([]);
    client.exec('DROP TRIGGER fail_retry_delete');
    const event = store.completeMaterializationRetry(id, eventInput(), {
      previousContent: 'before',
    });
    expect(store.listEvents({ sessionId }).map((record) => record.id)).toEqual([
      event.id,
    ]);
    expect(
      store.latestSnapshot('retry-monitor', 'object', '/workspace'),
    ).toEqual({ content: 'after' });
    expect(
      store.getSessionObjectCursor(
        sessionId,
        'retry-monitor',
        'object',
        '/workspace',
      )?.baselineContent,
    ).toBe('before');
    expect(store.projectedSessionIdsForLastEvent()).toEqual([sessionId]);
    expect(store.listMaterializationRetries()).toEqual([]);
  });

  it('retains the exact retry when materialization itself fails', () => {
    const { store, client } = open();
    const sessionId = openLead(store);
    const id = enqueue(store);
    const before = store.getMaterializationRetry(id);
    client.exec(
      "CREATE TRIGGER fail_retry_snapshot BEFORE INSERT ON monitor_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot write failed'); END",
    );
    expect(() => store.completeMaterializationRetry(id, eventInput())).toThrow(
      'snapshot write failed',
    );
    expect(store.getMaterializationRetry(id)).toEqual(before);
    expect(store.listEvents()).toEqual([]);
    expect(store.listEvents({ sessionId })).toEqual([]);
    expect(
      store.getSessionObjectCursor(
        sessionId,
        'retry-monitor',
        'object',
        '/workspace',
      ),
    ).toBeNull();
    expect(
      store.latestSnapshot('retry-monitor', 'object', '/workspace'),
    ).toBeNull();
  });

  it('preserves failed, terminal, rearmed and completed states across real database reopen', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'retry-lifecycle-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'state.db');
    let current = open(databasePath);
    const sessionId = openLead(current.store);
    const id = enqueue(current.store);
    const failed = current.store.markMaterializationRetryFailed(
      id,
      'failed once',
      NOW,
    );
    current.client.close();
    current = open(databasePath);
    expect(current.store.getMaterializationRetry(id)).toEqual(failed);
    expect(
      current.store.listMaterializationRetries({
        dueAt: new Date(NOW.getTime() + 4999),
      }),
    ).toEqual([]);
    expect(
      current.store
        .listMaterializationRetries({ dueAt: new Date(NOW.getTime() + 5000) })
        .map((row) => row.id),
    ).toEqual([id]);
    for (let attempt = 1; attempt < 5; attempt += 1)
      current.store.markMaterializationRetryFailed(id, 'still failed', NOW);
    const terminal = current.store.getMaterializationRetry(id);
    current.client.close();
    current = open(databasePath);
    expect(current.store.getMaterializationRetry(id)).toEqual(terminal);
    expect(
      current.store.listMaterializationRetries({
        dueAt: new Date('2100-01-01'),
      }),
    ).toEqual([]);
    const rearmed = current.store.rearmMaterializationRetry(
      id,
      new Date(NOW.getTime() + 60000),
    );
    current.client.close();
    current = open(databasePath);
    expect(current.store.getMaterializationRetry(id)).toEqual(rearmed);
    expect(rearmed).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: new Date(NOW.getTime() + 61000),
    });
    const event = current.store.completeMaterializationRetry(id, eventInput());
    current.client.close();
    current = open(databasePath);
    expect(current.store.listMaterializationRetries()).toEqual([]);
    expect(current.store.getEventById(event.id)).toEqual(event);
    expect(
      current.store.listEvents({ sessionId }).map((record) => record.id),
    ).toEqual([event.id]);
    expect(
      current.store.latestSnapshot('retry-monitor', 'object', '/workspace'),
    ).toEqual({ content: 'after' });
    expect(
      current.store.getSessionObjectCursor(
        sessionId,
        'retry-monitor',
        'object',
        '/workspace',
      )?.baselineContent,
    ).toBe('after');
  });

  it('never makes work due before the full delay at subsecond admission, failure or rearm', () => {
    const { store } = open();
    const now = new Date(NOW.getTime() + 850);
    const row = store.enqueueMaterializationRetries([retryInput()], now)[0];
    if (!row) throw new Error('Expected retry');
    const assertNotEarly = (delay: number) => {
      expect(
        store.listMaterializationRetries({
          dueAt: new Date(now.getTime() + delay - 1),
        }),
      ).toEqual([]);
      const deadline = store.getMaterializationRetry(row.id).nextAttemptAt;
      expect(deadline?.getTime()).toBeGreaterThanOrEqual(now.getTime() + delay);
      if (!deadline) throw new Error('Expected deadline');
      expect(
        store
          .listMaterializationRetries({ dueAt: deadline })
          .map((record) => record.id),
      ).toEqual([row.id]);
    };
    assertNotEarly(1000);
    store.markMaterializationRetryFailed(row.id, 'failed', now);
    assertNotEarly(5000);
    for (let attempt = 1; attempt < 5; attempt += 1)
      store.markMaterializationRetryFailed(row.id, 'failed', now);
    store.rearmMaterializationRetry(row.id, now);
    assertNotEarly(1000);
  });

  it('sanitizes and bounds diagnostics on failed-attempt updates', () => {
    const { store } = open();
    const id = enqueue(store);
    const record = store.markMaterializationRetryFailed(
      id,
      `bad\u0000\n\u001b\u007f\u0085\u2028\u2029${'x'.repeat(2000)}`,
      NOW,
    );
    expect(record.lastError).toHaveLength(1024);
    expect(record.lastError).toBe(`bad${' '.repeat(7)}${'x'.repeat(1014)}`);
  });

  it('exposes typed, stable not-found and lifecycle errors', () => {
    const { store } = open();
    for (const operation of [
      () => store.getMaterializationRetry('absent'),
      () => store.markMaterializationRetryFailed('absent', 'failure'),
      () => store.rearmMaterializationRetry('absent'),
      () => store.completeMaterializationRetry('absent', eventInput()),
    ]) {
      expect(operation).toThrow(
        expect.objectContaining({
          name: 'MaterializationRetryNotFoundError',
          code: 'materialization_retry_not_found',
          retryId: 'absent',
        }),
      );
    }
    const id = enqueue(store);
    expect(() => store.rearmMaterializationRetry(id)).toThrow(
      expect.objectContaining({
        name: 'MaterializationRetryTransitionError',
        code: 'materialization_retry_invalid_transition',
        retryId: id,
      }),
    );
    terminalize(store, id);
    for (const operation of [
      () => store.markMaterializationRetryFailed(id, 'failure'),
      () => store.completeMaterializationRetry(id, eventInput()),
    ]) {
      expect(operation).toThrow(
        expect.objectContaining({
          name: 'MaterializationRetryTransitionError',
          code: 'materialization_retry_invalid_transition',
          retryId: id,
        }),
      );
    }
  });
});
