/**
 * The external-event receipt operation (`RuntimeStore.withExternalEventReceipt`):
 * one immediate transaction decides new, duplicate, conflict or stale, keeps
 * the per-object high-water sequence monotonic (including re-entrant calls
 * from the callback), and commits the receipt with the callback's durable
 * consequence or rolls all of it back.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md (§2.6, §15 external ingress receipts)
 * @see ../../../../docs/specs/004-validation-testing.md (§2.14)
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, type InboxDb } from '../inbox/db.js';
import { RuntimeStore } from '../runtime/store.js';
import type {
  ExternalEventReceiptCompletion,
  ExternalEventReceiptDecision,
  ExternalEventReceiptOperation,
  ExternalEventReceiptRecord,
} from '../runtime/types.js';
import type { ExternalEventIngestInput } from './contract.js';
import {
  RECEIPT_EVENT_ID,
  RECEIPT_MATERIALIZED_AT,
  RECEIPT_NOW,
  cleanupReceiptTempDirs,
  receiptInput,
  receiptScratchDb,
} from './persistence.fixtures.js';

const sql = String.raw;

afterEach(cleanupReceiptTempDirs);

/** 002 §15: SQLite timestamps are epoch seconds. */
const NOW_SECONDS = Math.floor(RECEIPT_NOW.getTime() / 1_000);

function later(seconds: number): Date {
  return new Date(RECEIPT_NOW.getTime() + seconds * 1_000);
}

/** The connection a store writes through, for fault triggers and inspection. */
function clientOf(db: InboxDb): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client;
}

function openStore(dbPath = receiptScratchDb()) {
  const db = createDb(dbPath);
  return { dbPath, store: new RuntimeStore(db), client: clientOf(db) };
}

/** Every row any part of the operation, or its callback, could write. */
function dump(client: Database.Database) {
  const rows = (table: string) =>
    client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return {
    receipts: rows('external_event_receipts'),
    sequences: rows('external_object_sequences'),
    markers: rows('database_compatibility_markers'),
    events: rows('monitor_events'),
    snapshots: rows('monitor_snapshots'),
    states: rows('monitor_state'),
  };
}

function sequenceRow(client: Database.Database) {
  return client
    .prepare(
      sql`SELECT highest_sequence, receipt_id, upstream_event_id, updated_at
       FROM external_object_sequences`,
    )
    .all();
}

/**
 * Durable work shaped like real materialization: one event plus the object's
 * snapshot of the envelope state, committed inside the receipt transaction.
 */
function materialize(
  store: RuntimeStore,
  input: ExternalEventIngestInput,
): ExternalEventReceiptOperation {
  return ({ acceptedAt }) => {
    const objectKey = `external:${input.envelope.objectId}`;
    const event = store.insertEvent({
      workspacePath: input.workspaceIdentity,
      monitorId: input.envelope.monitorId,
      sourceName: input.envelope.source,
      urgency: 'normal',
      title: input.envelope.upstreamEventId,
      body: '',
      summary: input.envelope.upstreamEventId,
      payload: {},
      snapshotMetadata: {},
      snapshotText: JSON.stringify(input.envelope.state),
      diffText: null,
      objectKey,
      baselineStrategy: null,
      queryScope: {},
      tags: [],
      createdAt: acceptedAt,
    });
    store.saveSnapshot({
      workspacePath: input.workspaceIdentity,
      monitorId: input.envelope.monitorId,
      objectKey,
      eventId: event.id,
      content: JSON.stringify(input.envelope.state),
    });
    return { outcome: 'materialized', eventIds: [event.id] };
  };
}

function accepted(
  decision: ExternalEventReceiptDecision,
): ExternalEventReceiptRecord {
  if (decision.decision !== 'accepted') {
    throw new Error(`expected acceptance, got ${decision.decision}`);
  }
  return decision.receipt;
}

/** The safe receipt fields, and the ones that must never appear (002 §15). */
const RECEIPT_KEYS = [
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
].sort();
const FORBIDDEN_RECEIPT_KEYS = [
  'workspaceIdentity',
  'semanticHash',
  'scope',
  'state',
  'payload',
  'resumeToken',
];

describe('external event receipt persistence', () => {
  it('returns the same safe receipt from a reopened database on replay, without running work', () => {
    const { dbPath, store } = openStore();
    const receipt = accepted(
      store.withExternalEventReceipt(
        receiptInput(),
        () => ({
          outcome: 'materialized',
          eventIds: [RECEIPT_EVENT_ID],
          materializedAt: RECEIPT_MATERIALIZED_AT,
        }),
        RECEIPT_NOW,
      ),
    );

    const reopened = new RuntimeStore(createDb(dbPath));
    const work = vi.fn((): ExternalEventReceiptCompletion => {
      throw new Error('replay must not run durable work');
    });
    const replay = reopened.withExternalEventReceipt(
      receiptInput({ resumeToken: 'another-relay-cursor' }),
      work,
      later(60),
    );
    expect(work).not.toHaveBeenCalled();
    expect(replay.decision).toBe('duplicate');
    if (replay.decision !== 'duplicate') return;
    const hydrated = replay.receipt;

    expect(Object.keys(hydrated).sort()).toEqual(RECEIPT_KEYS);
    for (const forbidden of FORBIDDEN_RECEIPT_KEYS) {
      expect(hydrated).not.toHaveProperty(forbidden);
    }
    expect(hydrated).toEqual({
      receiptId: receipt.receiptId,
      monitorId: 'build-health',
      source: 'example-build-system',
      upstreamEventId: 'delivery-42',
      objectId: 'build-group-123',
      objectSequence: 42,
      eventKind: 'build.updated',
      changeKind: 'modified',
      occurredAt: '2026-08-13T17:59:59.000Z',
      outcome: 'materialized',
      eventIds: [RECEIPT_EVENT_ID],
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      // Dates round-trip through epoch seconds; the replay clock is not used.
      acceptedAt: RECEIPT_NOW,
      materializedAt: RECEIPT_MATERIALIZED_AT,
      updatedAt: RECEIPT_NOW,
    });
    expect(hydrated.acceptedAt).toBeInstanceOf(Date);
    expect(hydrated).toEqual(receipt);
    expect(JSON.stringify(hydrated)).not.toMatch(
      /PRIVATE-STATE|PRIVATE-SCOPE|private-relay-cursor|workspace-a/,
    );

    const sqlite = new Database(dbPath, { readonly: true });
    const persisted = sqlite
      .prepare('SELECT * FROM external_event_receipts WHERE id = ?')
      .get(receipt.receiptId) as Record<string, unknown>;
    sqlite.close();
    expect(persisted['semantic_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted)).not.toMatch(
      /PRIVATE-STATE|PRIVATE-SCOPE|private-relay-cursor/,
    );
  });

  it('treats replay as a successful no-op that changes nothing', () => {
    const { store, client } = openStore();
    const input = receiptInput();
    const first = accepted(
      store.withExternalEventReceipt(
        input,
        materialize(store, input),
        RECEIPT_NOW,
      ),
    );
    const before = dump(client);
    const work = vi.fn(materialize(store, input));
    const replay = store.withExternalEventReceipt(
      receiptInput({ resumeToken: 'replayed-cursor' }),
      work,
      later(1),
    );
    expect(replay).toEqual({ decision: 'duplicate', receipt: first });
    expect(work).not.toHaveBeenCalled();
    expect(dump(client)).toEqual(before);
  });

  it('refuses identity reuse with different content and changes nothing', () => {
    const { store, client } = openStore();
    const input = receiptInput();
    const first = accepted(
      store.withExternalEventReceipt(
        input,
        materialize(store, input),
        RECEIPT_NOW,
      ),
    );
    const before = dump(client);
    for (const changed of [
      receiptInput({ state: { status: 'failed' } }),
      receiptInput({ objectSequence: 43 }),
      receiptInput({ scope: { project: 'other' } }),
    ]) {
      const work = vi.fn(materialize(store, changed));
      expect(store.withExternalEventReceipt(changed, work, later(1))).toEqual({
        decision: 'conflict',
        existingReceiptId: first.receiptId,
      });
      expect(work).not.toHaveBeenCalled();
    }
    expect(dump(client)).toEqual(before);
  });

  it('advances the high-water mark from 42 to 43', () => {
    const { store, client } = openStore();
    accepted(
      store.withExternalEventReceipt(
        receiptInput(),
        () => ({
          outcome: 'held',
        }),
        RECEIPT_NOW,
      ),
    );
    const next = accepted(
      store.withExternalEventReceipt(
        receiptInput({ upstreamEventId: 'delivery-43', objectSequence: 43 }),
        () => ({ outcome: 'held' }),
        later(1),
      ),
    );
    expect(sequenceRow(client)).toEqual([
      {
        highest_sequence: 43,
        receipt_id: next.receiptId,
        upstream_event_id: 'delivery-43',
        updated_at: NOW_SECONDS + 1,
      },
    ]);
  });

  it('records an equal or older sequence as stale without work or high-water change', () => {
    const { store, client } = openStore();
    const input = receiptInput();
    accepted(
      store.withExternalEventReceipt(
        input,
        materialize(store, input),
        RECEIPT_NOW,
      ),
    );
    const sequenceBefore = sequenceRow(client);
    for (const [upstreamEventId, objectSequence] of [
      ['delivery-42b', 42],
      ['delivery-41', 41],
    ] as const) {
      const work = vi.fn(materialize(store, input));
      const stale = accepted(
        store.withExternalEventReceipt(
          receiptInput({ upstreamEventId, objectSequence }),
          work,
          later(1),
        ),
      );
      expect(work).not.toHaveBeenCalled();
      expect(stale).toMatchObject({
        outcome: 'stale',
        objectSequence,
        eventIds: [],
        materializedAt: null,
      });
      expect(sequenceRow(client)).toEqual(sequenceBefore);
    }
  });

  it('never lets an older sequence replace a newer snapshot', () => {
    const { store } = openStore();
    const newer = receiptInput({
      upstreamEventId: 'delivery-43',
      objectSequence: 43,
      state: { status: 'passed', revision: 'newer' },
    });
    const older = receiptInput({
      upstreamEventId: 'delivery-42',
      objectSequence: 42,
      state: { status: 'failed', revision: 'older' },
    });
    accepted(
      store.withExternalEventReceipt(
        newer,
        materialize(store, newer),
        RECEIPT_NOW,
      ),
    );
    accepted(
      store.withExternalEventReceipt(
        older,
        materialize(store, older),
        later(1),
      ),
    );
    expect(
      store.latestSnapshot(
        'build-health',
        'external:build-group-123',
        '/workspace-a',
      ),
    ).toEqual({
      content: JSON.stringify({ status: 'passed', revision: 'newer' }),
    });
    expect(store.listEvents()).toHaveLength(1);
  });

  it('writes the workspace compatibility marker once, with its identity, capability and time', () => {
    const { store, client } = openStore();
    accepted(
      store.withExternalEventReceipt(
        receiptInput(),
        () => ({
          outcome: 'held',
        }),
        RECEIPT_NOW,
      ),
    );
    accepted(
      store.withExternalEventReceipt(
        receiptInput({ upstreamEventId: 'delivery-43', objectSequence: 43 }),
        () => ({ outcome: 'held' }),
        later(5),
      ),
    );
    accepted(
      store.withExternalEventReceipt(
        receiptInput({}, '/workspace-b'),
        () => ({ outcome: 'held' }),
        later(9),
      ),
    );
    expect(
      client
        .prepare(
          sql`SELECT workspace_identity, capability, created_at
           FROM database_compatibility_markers ORDER BY workspace_identity`,
        )
        .all(),
    ).toEqual([
      {
        workspace_identity: '/workspace-a',
        capability: 'durable-ingress-v1',
        created_at: NOW_SECONDS,
      },
      {
        workspace_identity: '/workspace-b',
        capability: 'durable-ingress-v1',
        created_at: NOW_SECONDS + 9,
      },
    ]);
  });

  it.each(['held', 'suppressed'] as const)(
    'commits the %s initial outcome with no correlation',
    (outcome) => {
      const { store } = openStore();
      expect(
        accepted(
          store.withExternalEventReceipt(
            receiptInput(),
            () => ({ outcome }),
            RECEIPT_NOW,
          ),
        ),
      ).toMatchObject({
        outcome,
        eventIds: [],
        materializedAt: null,
        attemptCount: 0,
        lastError: null,
        nextAttemptAt: null,
      });
    },
  );

  it('refuses failed as an initial outcome, changing nothing', () => {
    const { store, client } = openStore();
    const before = dump(client);
    expect(() =>
      store.withExternalEventReceipt(
        receiptInput(),
        // @ts-expect-error failed is a retry-exhaustion state, never an initial outcome
        () => ({ outcome: 'failed' }),
        RECEIPT_NOW,
      ),
    ).toThrow(/outcome is invalid/);
    expect(dump(client)).toEqual(before);
  });
});

describe('the callback boundary', () => {
  it('refuses an asynchronous callback and rolls back its synchronous writes', () => {
    const { store, client } = openStore();
    const before = dump(client);
    expect(() =>
      store.withExternalEventReceipt(
        receiptInput(),
        // @ts-expect-error the operation must return its completion synchronously
        async () => {
          store.setMonitorState('async-write', '/workspace-a', {
            sourceState: { written: true },
          });
          await Promise.resolve();
          return { outcome: 'held' as const };
        },
        RECEIPT_NOW,
      ),
    ).toThrow(/must be synchronous/);
    expect(dump(client)).toEqual(before);
  });

  it('rolls callback writes back with receipt, sequence and marker state when it throws', () => {
    const { store, client } = openStore();
    const before = dump(client);
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
    expect(attemptedReceiptId).not.toBe('');
    expect(dump(client)).toEqual(before);
  });
});

describe('re-entrant acceptance from inside the callback', () => {
  it('keeps the high-water mark at the inner sequence instead of overwriting 3 with 2', () => {
    const { store, client } = openStore();
    accepted(
      store.withExternalEventReceipt(
        receiptInput({ upstreamEventId: 'delivery-1', objectSequence: 1 }),
        () => ({ outcome: 'held' }),
        RECEIPT_NOW,
      ),
    );
    let inner: ExternalEventReceiptRecord | undefined;
    const outer = accepted(
      store.withExternalEventReceipt(
        receiptInput({ upstreamEventId: 'delivery-2', objectSequence: 2 }),
        () => {
          inner = accepted(
            store.withExternalEventReceipt(
              receiptInput({
                upstreamEventId: 'delivery-3',
                objectSequence: 3,
              }),
              () => ({ outcome: 'held' }),
              later(1),
            ),
          );
          return { outcome: 'held' };
        },
        later(1),
      ),
    );
    expect(outer.outcome).toBe('held');
    expect(inner?.outcome).toBe('held');
    expect(sequenceRow(client)).toEqual([
      {
        highest_sequence: 3,
        receipt_id: inner?.receiptId,
        upstream_event_id: 'delivery-3',
        updated_at: NOW_SECONDS + 1,
      },
    ]);
    // A later new event at sequence 3 is stale: its work must not run again.
    const work = vi.fn(
      (): ExternalEventReceiptCompletion => ({
        outcome: 'held',
      }),
    );
    expect(
      accepted(
        store.withExternalEventReceipt(
          receiptInput({ upstreamEventId: 'delivery-3b', objectSequence: 3 }),
          work,
          later(2),
        ),
      ).outcome,
    ).toBe('stale');
    expect(work).not.toHaveBeenCalled();
  });

  it('commits both calls when the object has no high-water row yet', () => {
    const { store, client } = openStore();
    const calls: string[] = [];
    let inner: ExternalEventReceiptRecord | undefined;
    const outer = accepted(
      store.withExternalEventReceipt(
        receiptInput({ upstreamEventId: 'delivery-2', objectSequence: 2 }),
        () => {
          calls.push('outer');
          inner = accepted(
            store.withExternalEventReceipt(
              receiptInput({
                upstreamEventId: 'delivery-3',
                objectSequence: 3,
              }),
              () => {
                calls.push('inner');
                return { outcome: 'held' };
              },
              RECEIPT_NOW,
            ),
          );
          return { outcome: 'held' };
        },
        RECEIPT_NOW,
      ),
    );
    expect(calls).toEqual(['outer', 'inner']);
    expect(
      client
        .prepare(
          `SELECT id, object_sequence, outcome FROM external_event_receipts ORDER BY object_sequence`,
        )
        .all(),
    ).toEqual([
      { id: outer.receiptId, object_sequence: 2, outcome: 'held' },
      { id: inner?.receiptId, object_sequence: 3, outcome: 'held' },
    ]);
    expect(sequenceRow(client)).toMatchObject([
      { highest_sequence: 3, receipt_id: inner?.receiptId },
    ]);
  });

  it('records an inner call at or below the outer reserved sequence as stale', () => {
    const { store, client } = openStore();
    const innerWork = vi.fn(
      (): ExternalEventReceiptCompletion => ({
        outcome: 'held',
      }),
    );
    let inner: ExternalEventReceiptRecord | undefined;
    const outer = accepted(
      store.withExternalEventReceipt(
        receiptInput({ upstreamEventId: 'delivery-5', objectSequence: 5 }),
        () => {
          inner = accepted(
            store.withExternalEventReceipt(
              receiptInput({
                upstreamEventId: 'delivery-4',
                objectSequence: 4,
              }),
              innerWork,
              RECEIPT_NOW,
            ),
          );
          return { outcome: 'held' };
        },
        RECEIPT_NOW,
      ),
    );
    expect(innerWork).not.toHaveBeenCalled();
    expect(inner?.outcome).toBe('stale');
    expect(sequenceRow(client)).toMatchObject([
      { highest_sequence: 5, receipt_id: outer.receiptId },
    ]);
  });

  it('refuses a nested call for the identity being accepted, and the outer call rolls back', () => {
    const { store, client } = openStore();
    const before = dump(client);
    const input = receiptInput();
    expect(() =>
      store.withExternalEventReceipt(
        input,
        () => {
          store.withExternalEventReceipt(input, () => ({ outcome: 'held' }));
          return { outcome: 'held' };
        },
        RECEIPT_NOW,
      ),
    ).toThrow(/already being accepted/);
    expect(dump(client)).toEqual(before);
  });

  it('rolls back an inner acceptance with the outer call when the outer callback then fails', () => {
    const { store, client } = openStore();
    const before = dump(client);
    expect(() =>
      store.withExternalEventReceipt(
        receiptInput({ upstreamEventId: 'delivery-2', objectSequence: 2 }),
        () => {
          store.withExternalEventReceipt(
            receiptInput({ upstreamEventId: 'delivery-3', objectSequence: 3 }),
            () => ({ outcome: 'held' }),
          );
          throw new Error('outer failure after inner acceptance');
        },
        RECEIPT_NOW,
      ),
    ).toThrow('outer failure after inner acceptance');
    expect(dump(client)).toEqual(before);
  });
});

describe('a failure anywhere leaves no receipt, sequence change, marker or event', () => {
  /** Abort one write on the store's own connection with a temporary trigger. */
  function injectFault(
    client: Database.Database,
    timing: 'INSERT' | 'UPDATE',
    table: string,
  ) {
    client.exec(sql`
      CREATE TEMP TRIGGER injected_fault BEFORE ${timing} ON main.${table}
      BEGIN SELECT RAISE(ABORT, 'injected ${table} fault'); END
    `);
    return () => {
      client.exec('DROP TRIGGER temp.injected_fault');
    };
  }

  it.each([
    ['the callback event write', 'INSERT', 'monitor_events', false],
    ['the callback snapshot write', 'INSERT', 'monitor_snapshots', false],
    ['the receipt write', 'INSERT', 'external_event_receipts', false],
    [
      'the first high-water write',
      'INSERT',
      'external_object_sequences',
      false,
    ],
    ['the high-water advance', 'UPDATE', 'external_object_sequences', true],
    [
      'the compatibility marker write',
      'INSERT',
      'database_compatibility_markers',
      false,
    ],
  ] as const)(
    'rolls everything back when %s fails, and a retry then succeeds',
    (_step, timing, table, withPriorSequence) => {
      const { store, client } = openStore();
      if (withPriorSequence) {
        accepted(
          store.withExternalEventReceipt(
            receiptInput({
              upstreamEventId: 'delivery-41',
              objectSequence: 41,
            }),
            () => ({ outcome: 'held' }),
            RECEIPT_NOW,
          ),
        );
      }
      const before = dump(client);
      const input = receiptInput();
      const clear = injectFault(client, timing, table);
      expect(() =>
        store.withExternalEventReceipt(
          input,
          materialize(store, input),
          later(1),
        ),
      ).toThrow(`injected ${table} fault`);
      expect(dump(client)).toEqual(before);

      clear();
      const work = vi.fn(materialize(store, input));
      const retried = accepted(
        store.withExternalEventReceipt(input, work, later(2)),
      );
      expect(work).toHaveBeenCalledTimes(1);
      expect(retried.outcome).toBe('materialized');
      expect(sequenceRow(client)).toMatchObject([
        { highest_sequence: 42, receipt_id: retried.receiptId },
      ]);
    },
  );
});

describe('a rolled-back receipt leaves the projection cache as it was', () => {
  // insertEvent records the event's recipients in memory, outside SQLite
  // rollback (002 §2.6.1: any error rolls the whole operation back). Without a
  // restore, the cache would name the recipients of an event that no longer
  // exists after the receipt rolls back.
  it.each([
    ['an invalid completion', null],
    ['an aborted receipt write', 'external_event_receipts'],
    ['an aborted marker write', 'database_compatibility_markers'],
  ] as const)('after %s', (_case, faultTable) => {
    const { store, client } = openStore();
    const committedLead = store.openSession({
      adapter: 'claude',
      hostSessionId: 'host-b',
      workspacePath: '/workspace-b',
      role: 'lead',
      agentIdentity: 'lead-b',
      hookStatePath: '/hook-state-b.json',
    });
    store.openSession({
      adapter: 'claude',
      hostSessionId: 'host-a',
      workspacePath: '/workspace-a',
      role: 'lead',
      agentIdentity: 'lead-a',
      hookStatePath: '/hook-state-a.json',
    });
    // A committed event in another workspace sets the cache to its own lead.
    accepted(
      store.withExternalEventReceipt(
        receiptInput({ upstreamEventId: 'delivery-b' }, '/workspace-b'),
        materialize(
          store,
          receiptInput({ upstreamEventId: 'delivery-b' }, '/workspace-b'),
        ),
        RECEIPT_NOW,
      ),
    );
    expect(store.projectedSessionIdsForLastEvent()).toEqual([committedLead.id]);

    const input = receiptInput();
    if (faultTable !== null) {
      client.exec(sql`
        CREATE TEMP TRIGGER injected_fault BEFORE INSERT ON main.${faultTable}
        BEGIN SELECT RAISE(ABORT, 'injected fault'); END
      `);
    }
    const work = materialize(store, input);
    expect(() =>
      store.withExternalEventReceipt(
        input,
        faultTable === null
          ? (context) => {
              work(context);
              // Materialized work must name its events; this rolls back.
              return { outcome: 'materialized', eventIds: [] } as never;
            }
          : work,
        later(1),
      ),
    ).toThrow();

    expect(
      store
        .listEvents({})
        .filter((event) => event.workspacePath === '/workspace-a'),
    ).toEqual([]);
    expect(store.projectedSessionIdsForLastEvent()).toEqual([committedLead.id]);
  });
});

describe('hydrating a stored receipt fails closed on an impossible state', () => {
  function storedThenCorrupted(update: string) {
    const { dbPath, store } = openStore();
    accepted(
      store.withExternalEventReceipt(
        receiptInput(),
        () => ({ outcome: 'held' }),
        RECEIPT_NOW,
      ),
    );
    const raw = new Database(dbPath);
    raw.exec(`UPDATE external_event_receipts SET ${update}`);
    raw.close();
    return store;
  }

  it.each([
    ['an unknown outcome', `outcome = 'nonsense'`],
    ['an unknown change kind', `change_kind = 'renamed'`],
    [
      'materialized without event ids',
      `outcome = 'materialized', materialized_at = accepted_at`,
    ],
    [
      'materialized without a materialization time',
      `outcome = 'materialized', event_ids = '["01EVENT"]'`,
    ],
    ['held with event ids', `event_ids = '["01EVENT"]'`],
    ['held with a materialization time', `materialized_at = accepted_at`],
    ['malformed event ids', `event_ids = 'not json'`],
    [
      'duplicate event ids',
      `outcome = 'materialized', materialized_at = accepted_at, event_ids = '["a","a"]'`,
    ],
    ['stale with retry state', `outcome = 'stale', attempt_count = 1`],
    ['failed with no recorded attempt', `outcome = 'failed'`],
    ['failed without an error', `outcome = 'failed', attempt_count = 3`],
    [
      'failed with a retry still scheduled',
      `outcome = 'failed', attempt_count = 3, last_error = 'x', next_attempt_at = accepted_at`,
    ],
    ['a negative attempt count', `attempt_count = -1`],
    ['a fractional object sequence', `object_sequence = 4.5`],
    ['an unreadable acceptance time', `accepted_at = 'yesterday'`],
  ])('refuses %s', (_case, update) => {
    const store = storedThenCorrupted(update);
    const work = vi.fn(
      (): ExternalEventReceiptCompletion => ({
        outcome: 'held',
      }),
    );
    let thrown: unknown;
    try {
      store.withExternalEventReceipt(receiptInput(), work, later(1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /^Stored external event receipt \S+ is invalid: /,
    );
    expect((thrown as Error).message).not.toMatch(
      /PRIVATE|private-relay-cursor|workspace-a/,
    );
    expect(work).not.toHaveBeenCalled();
  });

  // 002 §2.6.1: stored envelope fields must be values envelope admission
  // accepts (002 §2.6), checked by the envelope validator itself.
  it.each([
    [
      'an occurrence time that is not RFC 3339',
      `occurred_at = 'yesterday'`,
      'occurrence time',
    ],
    ['an empty occurrence time', `occurred_at = ''`, 'occurrence time'],
    [
      'an impossible calendar date',
      `occurred_at = '2026-02-30T00:00:00Z'`,
      'occurrence time',
    ],
    ['an empty event kind', `event_kind = ''`, 'event kind'],
    [
      'an event kind over the identifier bound',
      `event_kind = substr(hex(zeroblob(257)), 1, 513)`,
      'event kind',
    ],
    ['an empty object id', `object_id = ''`, 'object id'],
  ])('refuses %s, naming the field', (_case, update, field) => {
    const store = storedThenCorrupted(update);
    expect(() =>
      store.withExternalEventReceipt(
        receiptInput(),
        () => ({ outcome: 'held' }),
        later(1),
      ),
    ).toThrow(
      new RegExp(
        `^Stored external event receipt \\S+ is invalid: ${field} is not a valid envelope value\\.$`,
      ),
    );
  });

  it('hydrates a stored leap-second occurrence time the envelope accepts', () => {
    const store = storedThenCorrupted(
      `occurred_at = '2016-12-31T23:59:60Z', event_kind = 'build.updated'`,
    );
    expect(
      store.withExternalEventReceipt(
        receiptInput(),
        () => ({ outcome: 'held' }),
        later(1),
      ),
    ).toMatchObject({
      decision: 'duplicate',
      receipt: { occurredAt: '2016-12-31T23:59:60Z' },
    });
  });

  it('hydrates a coherent failed receipt recorded after exhausted retries', () => {
    const store = storedThenCorrupted(
      `outcome = 'failed', attempt_count = 3, last_error = 'materialization failed'`,
    );
    const replay = store.withExternalEventReceipt(
      receiptInput(),
      () => ({ outcome: 'held' }),
      later(1),
    );
    expect(replay).toMatchObject({
      decision: 'duplicate',
      receipt: {
        outcome: 'failed',
        attemptCount: 3,
        lastError: 'materialization failed',
        nextAttemptAt: null,
        eventIds: [],
        materializedAt: null,
      },
    });
  });
});

describe('overlapping independent processes', () => {
  const CHILD_COUNT = 4;
  const TRIALS = 12;

  /**
   * Start one bounded child that runs every trial under `root` (see the
   * fixture's protocol). Each process starts once for all trials, so the
   * test's cost is the racing acceptances rather than repeated startup.
   */
  function startChild(root: string) {
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--import',
        path.resolve('src/runtime/__fixtures__/typescript-loader.ts'),
        path.resolve('src/external-ingress/__fixtures__/receipt-race-child.ts'),
        root,
        String(TRIALS),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 60_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return {
      child,
      exited,
      get output() {
        return output;
      },
      get errors() {
        return errors;
      },
    };
  }

  type Child = ReturnType<typeof startChild>;

  /** The line a child printed for `trial` with one of `prefixes`, if any. */
  function lineFor(c: Child, trial: string, prefixes: string[]) {
    return c.output
      .split('\n')
      .find((line) => prefixes.some((p) => line.startsWith(`${p} ${trial}`)));
  }

  /** Wait until every child has printed a `prefixes` line for `trial`. */
  async function waitForTrial(
    children: Child[],
    trial: string,
    prefixes: string[],
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!children.every((c) => lineFor(c, trial, prefixes) !== undefined)) {
      if (Date.now() >= deadline) {
        const report = children.map((c) => c.output + c.errors).join('\n');
        throw new Error(`children never reported trial ${trial}:\n${report}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  it('accepts the same event exactly once, running its work once; the rest see duplicates', async () => {
    const root = path.dirname(receiptScratchDb());
    const children = Array.from({ length: CHILD_COUNT }, () =>
      startChild(root),
    );
    try {
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const n = String(trial);
        const dbPath = path.join(root, `trial-${n}`, 'agentmon.db');
        // Create the schema first so the race is over acceptance, not first open.
        clientOf(createDb(dbPath)).close();
        await waitForTrial(children, n, ['READY']);
        writeFileSync(path.join(root, `go-${n}`), 'go');
        await waitForTrial(children, n, ['RESULT', 'ERROR']);
        const results = children.map((c) => {
          const line = lineFor(c, n, ['RESULT', 'ERROR']);
          expect(line, `trial ${n}`).toMatch(new RegExp(`^RESULT ${n} `));
          return JSON.parse(line?.slice(`RESULT ${n} `.length) ?? 'null') as {
            decision: string;
            ran: boolean;
            receiptId: string;
          };
        });
        expect(results.filter((r) => r.decision === 'accepted')).toHaveLength(
          1,
        );
        expect(results.filter((r) => r.decision === 'duplicate')).toHaveLength(
          CHILD_COUNT - 1,
        );
        expect(results.filter((r) => r.ran)).toHaveLength(1);
        expect(new Set(results.map((r) => r.receiptId)).size).toBe(1);

        const sqlite = new Database(dbPath, { readonly: true });
        expect(
          sqlite
            .prepare(
              sql`SELECT
                (SELECT count(*) FROM external_event_receipts) AS receipts,
                (SELECT count(*) FROM external_object_sequences) AS sequences,
                (SELECT count(*) FROM monitor_events) AS events`,
            )
            .get(),
        ).toEqual({ receipts: 1, sequences: 1, events: 1 });
        sqlite.close();
      }
      const codes = await Promise.all(children.map((c) => c.exited));
      expect(codes).toEqual(Array.from({ length: CHILD_COUNT }, () => 0));
    } finally {
      for (const c of children) {
        if (c.child.exitCode === null && c.child.signalCode === null)
          c.child.kill('SIGKILL');
      }
      await Promise.allSettled(children.map((c) => c.exited));
    }
  }, 120_000);
});
