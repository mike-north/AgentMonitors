import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { RuntimeStore } from '../runtime/store.js';
import type {
  ExternalEventReceiptCompletion,
  ExternalEventReceiptOperation,
} from '../runtime/types.js';
import type { ExternalEventIngestInput } from './contract.js';
import {
  RECEIPT_NOW,
  cleanupReceiptTempDirs,
  receiptInput,
  receiptScratchDb,
} from './persistence.fixtures.js';

afterEach(cleanupReceiptTempDirs);

type UnsafeReceiptCall = (
  input: unknown,
  operation: ExternalEventReceiptOperation,
  acceptedAt?: unknown,
) => unknown;

interface PersistenceSnapshot {
  receipts: unknown[];
  sequences: unknown[];
  markers: unknown[];
  callbackStates: unknown[];
}

function rows(
  dbPath: string,
  query: string,
  ...parameters: unknown[]
): unknown[] {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return sqlite.prepare(query).all(...parameters);
  } finally {
    sqlite.close();
  }
}

function persistenceSnapshot(dbPath: string): PersistenceSnapshot {
  return {
    receipts: rows(dbPath, 'SELECT * FROM external_event_receipts ORDER BY id'),
    sequences: rows(
      dbPath,
      'SELECT * FROM external_object_sequences ORDER BY id',
    ),
    markers: rows(
      dbPath,
      'SELECT * FROM database_compatibility_markers ORDER BY id',
    ),
    callbackStates: rows(
      dbPath,
      `SELECT * FROM monitor_state
       WHERE monitor_id LIKE 'callback-%'
       ORDER BY monitor_id, workspace_path`,
    ),
  };
}

function rowCount(dbPath: string, table: string): number {
  const result = rows(dbPath, `SELECT count(*) AS count FROM ${table}`)[0] as {
    count: number;
  };
  return result.count;
}

function acceptHeld(
  store: RuntimeStore,
  input: ExternalEventIngestInput,
  acceptedAt = RECEIPT_NOW,
) {
  return store.withExternalEventReceipt(
    input,
    () => ({ outcome: 'held' }),
    acceptedAt,
  );
}

describe('external receipt validation rollback', () => {
  it.each([
    ['null input', null, RECEIPT_NOW],
    ['wrong input type', 'not-an-input', RECEIPT_NOW],
    [
      'wrong workspace type',
      { ...receiptInput(), workspaceIdentity: 42 },
      RECEIPT_NOW,
    ],
    [
      'empty workspace',
      { ...receiptInput(), workspaceIdentity: '' },
      RECEIPT_NOW,
    ],
    ['missing envelope', { workspaceIdentity: '/workspace-a' }, RECEIPT_NOW],
    ['invalid envelope', receiptInput({ monitorId: '' }), RECEIPT_NOW],
    ['invalid date', receiptInput(), new Date(Number.NaN)],
    ['wrong date type', receiptInput(), '2026-08-13T18:00:00Z'],
  ])('rejects %s before callback or mutation', (_name, input, acceptedAt) => {
    const dbPath = receiptScratchDb();
    const store = new RuntimeStore(createDb(dbPath));
    const operation = vi.fn(() => {
      store.setMonitorState('callback-invalid-input', '/workspace-a', {
        sourceState: { leaked: true },
      });
      return { outcome: 'held' as const };
    });
    const unsafeCall = store.withExternalEventReceipt.bind(
      store,
    ) as unknown as UnsafeReceiptCall;

    expect(() => unsafeCall(input, operation, acceptedAt)).toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(persistenceSnapshot(dbPath)).toEqual({
      receipts: [],
      sequences: [],
      markers: [],
      callbackStates: [],
    });
  });

  it.each([
    ['null completion', null],
    ['unknown outcome', { outcome: 'unknown' }],
    ['callback stale outcome', { outcome: 'stale' }],
    ['missing materialized ids', { outcome: 'materialized' }],
    ['empty materialized ids', { outcome: 'materialized', eventIds: [] }],
    ['empty materialized id', { outcome: 'materialized', eventIds: [''] }],
    [
      'duplicate materialized ids',
      { outcome: 'materialized', eventIds: ['event-a', 'event-a'] },
    ],
    ['ids on held', { outcome: 'held', eventIds: ['event-a'] }],
    [
      'timestamp on suppressed',
      { outcome: 'suppressed', materializedAt: RECEIPT_NOW },
    ],
    [
      'invalid materialized timestamp',
      {
        outcome: 'materialized',
        eventIds: ['event-a'],
        materializedAt: new Date(Number.NaN),
      },
    ],
    [
      'null materialized timestamp',
      {
        outcome: 'materialized',
        eventIds: ['event-a'],
        materializedAt: null,
      },
    ],
  ])('rolls back callback work for %s', (_name, completion) => {
    const dbPath = receiptScratchDb();
    const store = new RuntimeStore(createDb(dbPath));
    const operation = vi.fn(() => {
      store.setMonitorState('callback-invalid-completion', '/workspace-a', {
        sourceState: { leaked: true },
      });
      return completion as unknown as ExternalEventReceiptCompletion;
    });

    expect(() =>
      store.withExternalEventReceipt(receiptInput(), operation, RECEIPT_NOW),
    ).toThrow();
    expect(operation).toHaveBeenCalledOnce();
    expect(persistenceSnapshot(dbPath)).toEqual({
      receipts: [],
      sequences: [],
      markers: [],
      callbackStates: [],
    });
  });
});

describe('external receipt reopen and key isolation', () => {
  it('keeps incumbent rows unchanged across replay, conflict, and stale decisions', () => {
    const dbPath = receiptScratchDb();
    const first = new RuntimeStore(createDb(dbPath));
    const accepted = acceptHeld(first, receiptInput());
    if (accepted.decision !== 'accepted')
      throw new Error('expected acceptance');

    const reopened = new RuntimeStore(createDb(dbPath));
    expect(
      reopened.externalObjectSequence(
        '/workspace-a',
        'build-health',
        'example-build-system',
        'build-group-123',
      ),
    ).toMatchObject({
      highestSequence: 42,
      receiptId: accepted.receipt.receiptId,
      updatedAt: RECEIPT_NOW,
    });
    const beforeNoOps = persistenceSnapshot(dbPath);
    const operation = vi.fn(() => ({ outcome: 'held' as const }));
    expect(
      reopened.withExternalEventReceipt(
        receiptInput({ resumeToken: 'replayed-cursor' }),
        operation,
        new Date(RECEIPT_NOW.getTime() + 1_000),
      ),
    ).toMatchObject({ decision: 'duplicate' });
    expect(
      reopened.withExternalEventReceipt(
        receiptInput({ state: { status: 'changed' } }),
        operation,
        new Date(RECEIPT_NOW.getTime() + 2_000),
      ),
    ).toMatchObject({ decision: 'conflict' });
    expect(operation).not.toHaveBeenCalled();
    expect(persistenceSnapshot(dbPath)).toEqual(beforeNoOps);

    const incumbent = {
      receipt: rows(
        dbPath,
        'SELECT * FROM external_event_receipts WHERE id = ?',
        accepted.receipt.receiptId,
      ),
      sequence: beforeNoOps.sequences,
      markers: beforeNoOps.markers,
    };
    const staleWork = vi.fn(() => ({ outcome: 'held' as const }));
    const lower = new RuntimeStore(createDb(dbPath)).withExternalEventReceipt(
      receiptInput({ upstreamEventId: 'delivery-41', objectSequence: 41 }),
      staleWork,
      new Date(RECEIPT_NOW.getTime() + 3_000),
    );
    const equal = new RuntimeStore(createDb(dbPath)).withExternalEventReceipt(
      receiptInput({ upstreamEventId: 'delivery-equal', objectSequence: 42 }),
      staleWork,
      new Date(RECEIPT_NOW.getTime() + 4_000),
    );
    expect(lower).toMatchObject({
      decision: 'accepted',
      receipt: { outcome: 'stale' },
    });
    expect(equal).toMatchObject({
      decision: 'accepted',
      receipt: { outcome: 'stale' },
    });
    expect(staleWork).not.toHaveBeenCalled();
    expect({
      receipt: rows(
        dbPath,
        'SELECT * FROM external_event_receipts WHERE id = ?',
        accepted.receipt.receiptId,
      ),
      sequence: rows(
        dbPath,
        'SELECT * FROM external_object_sequences ORDER BY id',
      ),
      markers: rows(
        dbPath,
        'SELECT * FROM database_compatibility_markers ORDER BY id',
      ),
    }).toEqual(incumbent);
    expect(rowCount(dbPath, 'external_event_receipts')).toBe(3);

    const higherWork = vi.fn(() => ({ outcome: 'held' as const }));
    const higher = new RuntimeStore(createDb(dbPath)).withExternalEventReceipt(
      receiptInput({ upstreamEventId: 'delivery-43', objectSequence: 43 }),
      higherWork,
      new Date(RECEIPT_NOW.getTime() + 5_000),
    );
    expect(higher).toMatchObject({ decision: 'accepted' });
    expect(higherWork).toHaveBeenCalledOnce();
    expect(
      new RuntimeStore(createDb(dbPath)).externalObjectSequence(
        '/workspace-a',
        'build-health',
        'example-build-system',
        'build-group-123',
      ),
    ).toMatchObject({ highestSequence: 43, upstreamEventId: 'delivery-43' });
  });

  it('isolates every receipt idempotency-key dimension', () => {
    const dbPath = receiptScratchDb();
    const store = new RuntimeStore(createDb(dbPath));
    const cases: [string, ExternalEventIngestInput][] = [
      [
        'base',
        receiptInput({ upstreamEventId: 'same-delivery', objectSequence: 1 }),
      ],
      [
        'workspace',
        receiptInput(
          { upstreamEventId: 'same-delivery', objectSequence: 1 },
          '/workspace-b',
        ),
      ],
      [
        'monitor',
        receiptInput({
          monitorId: 'other-monitor',
          upstreamEventId: 'same-delivery',
          objectSequence: 1,
        }),
      ],
      [
        'source',
        receiptInput({
          source: 'other-source',
          upstreamEventId: 'same-delivery',
          objectSequence: 1,
        }),
      ],
      [
        'upstream event',
        receiptInput({ upstreamEventId: 'other-delivery', objectSequence: 2 }),
      ],
    ];
    const work = vi.fn(() => ({ outcome: 'held' as const }));

    for (const [, input] of cases) {
      expect(
        store.withExternalEventReceipt(input, work, RECEIPT_NOW),
      ).toMatchObject({ decision: 'accepted' });
    }
    expect(work).toHaveBeenCalledTimes(cases.length);
    expect(rowCount(dbPath, 'external_event_receipts')).toBe(cases.length);
  });

  it('isolates every object high-water key dimension', () => {
    const dbPath = receiptScratchDb();
    const store = new RuntimeStore(createDb(dbPath));
    const cases: [string, ExternalEventIngestInput][] = [
      [
        'base',
        receiptInput({ upstreamEventId: 'high-water-base', objectSequence: 1 }),
      ],
      [
        'workspace',
        receiptInput(
          { upstreamEventId: 'high-water-workspace', objectSequence: 1 },
          '/workspace-b',
        ),
      ],
      [
        'monitor',
        receiptInput({
          monitorId: 'other-monitor',
          upstreamEventId: 'high-water-monitor',
          objectSequence: 1,
        }),
      ],
      [
        'source',
        receiptInput({
          source: 'other-source',
          upstreamEventId: 'high-water-source',
          objectSequence: 1,
        }),
      ],
      [
        'object',
        receiptInput({
          objectId: 'other-object',
          upstreamEventId: 'high-water-object',
          objectSequence: 1,
        }),
      ],
    ];
    const work = vi.fn(() => ({ outcome: 'held' as const }));

    for (const [, input] of cases) {
      expect(
        store.withExternalEventReceipt(input, work, RECEIPT_NOW),
      ).toMatchObject({ decision: 'accepted' });
    }
    expect(work).toHaveBeenCalledTimes(cases.length);
    expect(rowCount(dbPath, 'external_object_sequences')).toBe(cases.length);
  });
});

describe('external receipt post-callback rollback', () => {
  it.each([
    ['receipt insert', 'INSERT', 'external_event_receipts', false],
    ['sequence insert', 'INSERT', 'external_object_sequences', false],
    ['sequence update', 'UPDATE', 'external_object_sequences', true],
    ['marker insert', 'INSERT', 'database_compatibility_markers', false],
  ] as const)(
    'rolls back every write when %s fails',
    (name, action, table, needsSeed) => {
      const dbPath = receiptScratchDb();
      const store = new RuntimeStore(createDb(dbPath));
      if (needsSeed) {
        expect(
          acceptHeld(
            store,
            receiptInput({ upstreamEventId: 'seed', objectSequence: 1 }),
          ),
        ).toMatchObject({ decision: 'accepted' });
      }
      const before = persistenceSnapshot(dbPath);
      const triggerName = `fail_${table}_${action.toLowerCase()}`;
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE ${action} ON ${table}
        BEGIN
          SELECT RAISE(ABORT, 'injected ${name} failure');
        END;
      `);
      sqlite.close();
      const operation = vi.fn(() => {
        store.setMonitorState(`callback-${triggerName}`, '/workspace-a', {
          sourceState: { shouldRollback: true },
        });
        return { outcome: 'held' as const };
      });
      const attemptedInput = receiptInput({
        upstreamEventId: `attempt-${triggerName}`,
        objectSequence: needsSeed ? 2 : 1,
      });

      expect(() =>
        store.withExternalEventReceipt(
          attemptedInput,
          operation,
          new Date(RECEIPT_NOW.getTime() + 1_000),
        ),
      ).toThrow(`injected ${name} failure`);
      expect(operation).toHaveBeenCalledOnce();
      expect(persistenceSnapshot(dbPath)).toEqual(before);

      const cleanup = new Database(dbPath);
      cleanup.exec(`DROP TRIGGER ${triggerName}`);
      cleanup.close();
      expect(
        acceptHeld(
          new RuntimeStore(createDb(dbPath)),
          attemptedInput,
          new Date(RECEIPT_NOW.getTime() + 2_000),
        ),
      ).toMatchObject({ decision: 'accepted' });
    },
  );
});

describe('external receipt migration and concurrency', () => {
  it('recreates every persistence primitive and enforces replay after migration', () => {
    const dbPath = receiptScratchDb();
    const first = new RuntimeStore(createDb(dbPath));
    const session = first.openSession({
      adapter: 'test',
      hostSessionId: 'legacy-host-session',
      agentIdentity: 'legacy-agent',
      workspacePath: '/workspace-a',
      hookStatePath: '/tmp/legacy-hook-state.json',
    });
    const event = first.insertEvent({
      workspacePath: '/workspace-a',
      monitorId: 'legacy-monitor',
      sourceName: 'legacy-source',
      urgency: 'normal',
      title: 'Legacy event',
      body: '',
      summary: 'Preserve me',
      payload: {},
      snapshotMetadata: {},
      snapshotText: null,
      diffText: null,
      objectKey: null,
      baselineStrategy: null,
      queryScope: {},
      tags: [],
      createdAt: RECEIPT_NOW,
    });
    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE external_event_receipts;
      DROP TABLE external_object_sequences;
      DROP TABLE database_compatibility_markers;
    `);
    legacy.close();

    const migrated = new RuntimeStore(createDb(dbPath));
    const accepted = acceptHeld(migrated, receiptInput());
    if (accepted.decision !== 'accepted')
      throw new Error('expected acceptance');
    const reopened = new RuntimeStore(createDb(dbPath));
    const replayWork = vi.fn(() => ({ outcome: 'held' as const }));
    expect(
      reopened.withExternalEventReceipt(
        receiptInput({ resumeToken: 'migration-replay' }),
        replayWork,
        new Date(RECEIPT_NOW.getTime() + 1_000),
      ),
    ).toMatchObject({ decision: 'duplicate' });
    expect(
      reopened.withExternalEventReceipt(
        receiptInput({ state: { status: 'conflict' } }),
        replayWork,
        new Date(RECEIPT_NOW.getTime() + 2_000),
      ),
    ).toMatchObject({ decision: 'conflict' });
    expect(replayWork).not.toHaveBeenCalled();
    expect(
      reopened.externalObjectSequence(
        '/workspace-a',
        'build-health',
        'example-build-system',
        'build-group-123',
      ),
    ).toMatchObject({
      highestSequence: 42,
      receiptId: accepted.receipt.receiptId,
    });
    expect(reopened.listSessions().map((row) => row.id)).toContain(session.id);
    expect(reopened.listEvents().map((row) => row.id)).toContain(event.id);
    expect(rowCount(dbPath, 'external_event_receipts')).toBe(1);
    expect(rowCount(dbPath, 'external_object_sequences')).toBe(1);
    expect(rowCount(dbPath, 'database_compatibility_markers')).toBe(1);
    expect(
      rows(
        dbPath,
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'idx_external_event_receipt_key',
           'idx_external_object_sequence_key',
           'idx_database_compatibility_marker_workspace_key',
           'idx_database_compatibility_marker_global_key'
         )
         ORDER BY name`,
      ),
    ).toEqual([
      { name: 'idx_database_compatibility_marker_global_key' },
      { name: 'idx_database_compatibility_marker_workspace_key' },
      { name: 'idx_external_event_receipt_key' },
      { name: 'idx_external_object_sequence_key' },
    ]);
  });

  it('serializes genuine concurrent duplicate calls across processes', async () => {
    const dbPath = receiptScratchDb();
    new RuntimeStore(createDb(dbPath));
    const directory = path.dirname(dbPath);
    const coreRoot = fileURLToPath(new URL('../..', import.meta.url));
    const vitestCli = fileURLToPath(
      new URL('../vitest.mjs', import.meta.resolve('vitest')),
    );
    const config = 'src/external-ingress/persistence-concurrency.vitest.ts';
    const runChild = (role: 'a' | 'b') =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [vitestCli, 'run', '--config', config],
          {
            cwd: coreRoot,
            env: {
              ...process.env,
              AGENTMON_CONCURRENCY_DIR: directory,
              AGENTMON_CONCURRENCY_ROLE: role,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else
            reject(new Error(`Concurrency child ${role} failed:\n${output}`));
        });
      });

    await Promise.all([runChild('a'), runChild('b')]);
    const decisions = ['a', 'b']
      .map((role) =>
        JSON.parse(
          readFileSync(path.join(directory, `result-${role}.json`), 'utf8'),
        ),
      )
      .map((result: { decision: string }) => result.decision)
      .sort();
    expect(decisions).toEqual(['accepted', 'duplicate']);
    expect(
      readdirSync(directory).filter((name) => name.startsWith('callback-')),
    ).toHaveLength(1);
    expect(rowCount(dbPath, 'external_event_receipts')).toBe(1);
    expect(rowCount(dbPath, 'external_object_sequences')).toBe(1);
    expect(rowCount(dbPath, 'database_compatibility_markers')).toBe(1);
  }, 30_000);
});
