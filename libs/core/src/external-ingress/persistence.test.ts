import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../inbox/db.js';
import { RuntimeStore } from '../runtime/store.js';
import {
  RECEIPT_EVENT_ID,
  RECEIPT_MATERIALIZED_AT,
  RECEIPT_NOW,
  cleanupReceiptTempDirs,
  receiptInput,
  receiptScratchDb,
} from './persistence.fixtures.js';

afterEach(cleanupReceiptTempDirs);

describe('external event receipt persistence', () => {
  it('retains exact safe receipt status and object ordering across reopen', () => {
    const dbPath = receiptScratchDb();
    const first = new RuntimeStore(createDb(dbPath));
    const result = first.withExternalEventReceipt(
      receiptInput(),
      () => ({
        outcome: 'materialized',
        eventIds: [RECEIPT_EVENT_ID],
        materializedAt: RECEIPT_MATERIALIZED_AT,
      }),
      RECEIPT_NOW,
    );
    if (result.decision !== 'accepted') throw new Error('expected acceptance');

    new RuntimeStore(createDb(dbPath));
    expect(Object.keys(result.receipt).sort()).toEqual(
      [
        'acceptedAt',
        'attemptCount',
        'changeKind',
        'eventIds',
        'eventKind',
        'lastError',
        'materializedAt',
        'monitorId',
        'nextAttemptAt',
        'objectId',
        'objectSequence',
        'occurredAt',
        'outcome',
        'receiptId',
        'source',
        'updatedAt',
        'upstreamEventId',
      ].sort(),
    );
    for (const forbidden of [
      'workspaceIdentity',
      'semanticHash',
      'scope',
      'state',
      'payload',
      'resumeToken',
    ]) {
      expect(result.receipt).not.toHaveProperty(forbidden);
    }

    const sqlite = new Database(dbPath, { readonly: true });
    const columns = (
      sqlite.pragma('table_info(external_event_receipts)') as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'workspace_identity',
      'monitor_id',
      'source',
      'upstream_event_id',
      'semantic_hash',
      'object_id',
      'object_sequence',
      'event_kind',
      'change_kind',
      'occurred_at',
      'outcome',
      'event_ids',
      'attempt_count',
      'last_error',
      'next_attempt_at',
      'accepted_at',
      'materialized_at',
      'updated_at',
    ]);
    const persisted = sqlite
      .prepare('SELECT * FROM external_event_receipts WHERE id = ?')
      .get(result.receipt.receiptId) as Record<string, unknown>;
    const sequence = sqlite
      .prepare(
        `SELECT workspace_identity, monitor_id, source, object_id,
                highest_sequence, receipt_id, upstream_event_id, updated_at
         FROM external_object_sequences`,
      )
      .get();
    sqlite.close();
    expect(sequence).toEqual({
      workspace_identity: '/workspace-a',
      monitor_id: 'build-health',
      source: 'example-build-system',
      object_id: 'build-group-123',
      highest_sequence: 42,
      receipt_id: result.receipt.receiptId,
      upstream_event_id: 'delivery-42',
      updated_at: Math.floor(RECEIPT_NOW.getTime() / 1_000),
    });
    expect(persisted['semantic_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted).not.toHaveProperty('scope');
    expect(JSON.stringify(persisted)).not.toMatch(
      /PRIVATE-STATE|PRIVATE-SCOPE|private-relay-cursor/,
    );
  });

  it('deduplicates cursor replay, reports conflict, and rejects stale work', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    const work = vi.fn(() => ({ outcome: 'held' as const }));
    const accepted = store.withExternalEventReceipt(
      receiptInput(),
      work,
      RECEIPT_NOW,
    );
    const duplicate = store.withExternalEventReceipt(
      receiptInput({ resumeToken: 'replayed-cursor' }),
      work,
      new Date(RECEIPT_NOW.getTime() + 1_000),
    );
    const conflict = store.withExternalEventReceipt(
      receiptInput({ state: { status: 'failed' } }),
      work,
      new Date(RECEIPT_NOW.getTime() + 2_000),
    );
    const stale = store.withExternalEventReceipt(
      receiptInput({ upstreamEventId: 'delivery-41', objectSequence: 41 }),
      work,
      new Date(RECEIPT_NOW.getTime() + 3_000),
    );

    expect(work).toHaveBeenCalledTimes(1);
    expect(accepted).toMatchObject({ decision: 'accepted' });
    expect(duplicate).toMatchObject({ decision: 'duplicate' });
    expect(conflict).toMatchObject({ decision: 'conflict' });
    expect(stale).toMatchObject({
      decision: 'accepted',
      receipt: { outcome: 'stale' },
    });
  });

  it.each(['held', 'suppressed', 'failed'] as const)(
    'commits the valid %s non-materialized outcome',
    (outcome) => {
      const store = new RuntimeStore(createDb(':memory:'));
      expect(
        store.withExternalEventReceipt(
          receiptInput(),
          () => ({ outcome }),
          RECEIPT_NOW,
        ),
      ).toMatchObject({
        decision: 'accepted',
        receipt: { outcome, eventIds: [] },
      });
    },
  );

  it('rolls callback writes back with receipt, sequence, and marker state', () => {
    const dbPath = receiptScratchDb();
    const store = new RuntimeStore(createDb(dbPath));
    let attemptedReceiptId = '';
    expect(() =>
      store.withExternalEventReceipt(
        receiptInput(),
        ({ receiptId }) => {
          attemptedReceiptId = receiptId;
          store.setMonitorState('callback-write', '/workspace-a', {
            sourceState: { shouldRollback: true },
          });
          throw new Error('injected callback failure');
        },
        RECEIPT_NOW,
      ),
    ).toThrow('injected callback failure');

    const sqlite = new Database(dbPath, { readonly: true });
    const counts = sqlite
      .prepare(
        `SELECT
          (SELECT count(*) FROM external_event_receipts) AS receipts,
          (SELECT count(*) FROM external_object_sequences) AS sequences,
          (SELECT count(*) FROM database_compatibility_markers) AS markers`,
      )
      .get();
    sqlite.close();
    expect(attemptedReceiptId).not.toBe('');
    expect(counts).toEqual({ receipts: 0, sequences: 0, markers: 0 });
    expect(store.getMonitorState('callback-write', '/workspace-a')).toEqual({
      notifyState: {},
    });
  });
});
