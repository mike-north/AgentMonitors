/**
 * Reading external receipts and per-object sequences back, and marking held
 * notification state forward-only: workspace-exact receipt status, exact
 * four-dimension sequence reads, fail-closed hydration of stored rows, and the
 * compatibility marker committed with the state it protects.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md (§2.6.1 receipt reads, §15 external ingress receipts and compatibility markers)
 * @see ../../../../docs/specs/004-validation-testing.md (§2.14)
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type InboxDb } from '../inbox/db.js';
import { RuntimeStore } from '../runtime/store.js';
import type { ExternalEventIngestInput } from './contract.js';
import {
  RECEIPT_EVENT_ID,
  RECEIPT_MATERIALIZED_AT,
  RECEIPT_NOW,
  cleanupReceiptTempDirs,
  receiptInput,
  receiptScratchDb,
} from './persistence.fixtures.js';

afterEach(cleanupReceiptTempDirs);

function clientOf(db: InboxDb): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client;
}

/** Accept `input` with materialized work and return its receipt id. */
function accept(store: RuntimeStore, input: ExternalEventIngestInput): string {
  const decision = store.withExternalEventReceipt(
    input,
    () => ({
      outcome: 'materialized',
      eventIds: [RECEIPT_EVENT_ID],
      materializedAt: RECEIPT_MATERIALIZED_AT,
    }),
    RECEIPT_NOW,
  );
  if (decision.decision !== 'accepted') throw new Error('expected acceptance');
  return decision.receipt.receiptId;
}

/** The base route of `receiptInput()`. */
const ROUTE = {
  workspaceIdentity: '/workspace-a',
  monitorId: 'build-health',
  source: 'example-build-system',
  objectId: 'build-group-123',
} as const;

type Route = { -readonly [K in keyof typeof ROUTE]: string };

function readSequence(store: RuntimeStore, route: Route) {
  return store.externalObjectSequence(
    route.workspaceIdentity,
    route.monitorId,
    route.source,
    route.objectId,
  );
}

describe('reading receipt status', () => {
  it('returns only the compact receipt fields, and only through the exact workspace', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    const receiptId = accept(store, receiptInput());

    const status = store.externalEventReceiptStatus('/workspace-a', receiptId);
    // 002 §2.6.1: a receipt carries correlation metadata, outcome, event ids
    // and timestamps; never state, scope, resume token, workspace identity or
    // semantic hash.
    expect(status).toEqual({
      receiptId,
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
      acceptedAt: RECEIPT_NOW,
      materializedAt: RECEIPT_MATERIALIZED_AT,
      updatedAt: RECEIPT_NOW,
    });
    const serialized = JSON.stringify(status);
    for (const secret of [
      'PRIVATE-STATE',
      'PRIVATE-SCOPE',
      'private-relay-cursor',
      '/workspace-a',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // 002 §2.6.1: another workspace's receipt is indistinguishable from a
    // missing one.
    expect(
      store.externalEventReceiptStatus('/workspace-b', receiptId),
    ).toBeNull();
    expect(
      store.externalEventReceiptStatus('/workspace-a', 'missing-receipt'),
    ).toBeNull();
  });

  it('reports a corrupt stored receipt instead of returning it', () => {
    const dbPath = receiptScratchDb();
    const store = new RuntimeStore(createDb(dbPath));
    const receiptId = accept(store, receiptInput());
    const raw = new Database(dbPath);
    raw.exec(`UPDATE external_event_receipts SET monitor_id = ''`);
    raw.close();

    expect(() =>
      store.externalEventReceiptStatus('/workspace-a', receiptId),
    ).toThrow(
      `Stored external event receipt ${receiptId} is invalid: monitor id is not a valid envelope value.`,
    );
  });
});

describe('reading an object sequence', () => {
  it('keeps two workspaces on one database apart', () => {
    const dbPath = receiptScratchDb();
    const writer = new RuntimeStore(createDb(dbPath));
    const receiptA = accept(writer, receiptInput());
    const receiptB = accept(
      writer,
      receiptInput(
        { upstreamEventId: 'delivery-7', objectSequence: 7 },
        '/workspace-b',
      ),
    );

    // A second connection reads the committed state of both workspaces.
    const reader = new RuntimeStore(createDb(dbPath));
    expect(readSequence(reader, ROUTE)).toEqual({
      ...ROUTE,
      highestSequence: 42,
      receiptId: receiptA,
      upstreamEventId: 'delivery-42',
      updatedAt: RECEIPT_NOW,
    });
    expect(
      readSequence(reader, { ...ROUTE, workspaceIdentity: '/workspace-b' }),
    ).toEqual({
      ...ROUTE,
      workspaceIdentity: '/workspace-b',
      highestSequence: 7,
      receiptId: receiptB,
      upstreamEventId: 'delivery-7',
      updatedAt: RECEIPT_NOW,
    });
    expect(
      reader.externalEventReceiptStatus('/workspace-b', receiptA),
    ).toBeNull();
    expect(
      reader.externalEventReceiptStatus('/workspace-a', receiptB),
    ).toBeNull();
  });

  // 002 §15: the key is exactly (workspace, monitor, source, object). Each row
  // is a sibling of the base route differing in one dimension; it advances on
  // its own, and a value no row has on that dimension reads as missing.
  it.each([
    ['workspace', 'workspaceIdentity', '/workspace-b', '/workspace-missing'],
    ['monitor', 'monitorId', 'deploy-health', 'missing-monitor'],
    ['source', 'source', 'other-build-system', 'missing-source'],
    ['object', 'objectId', 'build-group-456', 'missing-object'],
  ] as const)(
    'matches the %s dimension exactly',
    (_dimension, field, siblingValue, missingValue) => {
      const store = new RuntimeStore(createDb(':memory:'));
      const base = accept(store, receiptInput());
      const siblingInput = receiptInput(
        {
          upstreamEventId: 'delivery-sibling',
          objectSequence: 9,
          ...(field === 'monitorId' ? { monitorId: siblingValue } : {}),
          ...(field === 'source' ? { source: siblingValue } : {}),
          ...(field === 'objectId' ? { objectId: siblingValue } : {}),
        },
        field === 'workspaceIdentity' ? siblingValue : ROUTE.workspaceIdentity,
      );
      const sibling = accept(store, siblingInput);
      const siblingRoute: Route = { ...ROUTE, [field]: siblingValue };

      expect(readSequence(store, ROUTE)).toMatchObject({
        highestSequence: 42,
        receiptId: base,
      });
      expect(readSequence(store, siblingRoute)).toEqual({
        ...siblingRoute,
        highestSequence: 9,
        receiptId: sibling,
        upstreamEventId: 'delivery-sibling',
        updatedAt: RECEIPT_NOW,
      });
      expect(
        readSequence(store, { ...ROUTE, [field]: missingValue }),
      ).toBeNull();
    },
  );

  describe('reports a corrupt stored row instead of returning it', () => {
    function storedThenCorrupted(...updates: string[]) {
      const dbPath = receiptScratchDb();
      const store = new RuntimeStore(createDb(dbPath));
      accept(store, receiptInput());
      const raw = new Database(dbPath);
      for (const update of updates) raw.exec(update);
      raw.close();
      return store;
    }

    const sequenceUpdate = (set: string) =>
      `UPDATE external_object_sequences SET ${set}`;

    it.each([
      [
        'a non-numeric high-water mark',
        [sequenceUpdate(`highest_sequence = 'not-a-number'`)],
        'highest sequence is not a non-negative safe integer',
      ],
      [
        'a negative high-water mark',
        [sequenceUpdate('highest_sequence = -1')],
        'highest sequence is not a non-negative safe integer',
      ],
      [
        'a fractional high-water mark',
        [sequenceUpdate('highest_sequence = 4.5')],
        'highest sequence is not a non-negative safe integer',
      ],
      [
        'an empty receipt id',
        [sequenceUpdate(`receipt_id = ''`)],
        'receipt id is not a non-empty string',
      ],
      [
        'an empty upstream event id',
        [sequenceUpdate(`upstream_event_id = ''`)],
        'upstream event id is not a valid envelope value',
      ],
      [
        'an unreadable update time',
        [sequenceUpdate(`updated_at = 'yesterday'`)],
        'update time is not a valid time',
      ],
      [
        'a receipt id that names no receipt',
        [sequenceUpdate(`receipt_id = 'missing-receipt'`)],
        'it does not match the receipt that set it',
      ],
      [
        'a high-water mark its receipt did not set',
        [sequenceUpdate('highest_sequence = 41')],
        'it does not match the receipt that set it',
      ],
      [
        'an upstream event id its receipt does not carry',
        [sequenceUpdate(`upstream_event_id = 'delivery-other'`)],
        'it does not match the receipt that set it',
      ],
      [
        'a receipt on another route',
        [`UPDATE external_event_receipts SET object_id = 'build-group-456'`],
        'it does not match the receipt that set it',
      ],
    ])('%s', (_case, updates, rule) => {
      const store = storedThenCorrupted(...updates);
      expect(() => readSequence(store, ROUTE)).toThrow(
        `Stored external object sequence for the requested object is invalid: ${rule}.`,
      );
    });

    it('rejects the combined corruption first reported against this read', () => {
      const store = storedThenCorrupted(
        sequenceUpdate(
          `highest_sequence = 'not-a-number', receipt_id = '', updated_at = 'yesterday'`,
        ),
      );
      expect(() => readSequence(store, ROUTE)).toThrow(
        /^Stored external object sequence for the requested object is invalid: /,
      );
    });
  });
});

describe('marking held notification state', () => {
  it('marks only nonempty durable notification state at its exact route', () => {
    const store = new RuntimeStore(createDb(':memory:'));

    store.setMonitorState('empty', '/workspace-empty', {
      notifyState: {
        suppressedUntil: RECEIPT_NOW.toISOString(),
        pendingDebounce: {
          observations: [],
          dueAt: RECEIPT_NOW.toISOString(),
        },
        pendingRollup: { observations: [] },
      },
    });
    expect(store.hasDatabaseCompatibilityMarker('/workspace-empty')).toBe(
      false,
    );

    store.setMonitorState('debounce', '/workspace-debounce', {
      notifyState: {
        pendingDebounce: {
          observations: [{ captured: 'debounce' }],
          dueAt: RECEIPT_NOW.toISOString(),
        },
      },
    });
    expect(store.hasDatabaseCompatibilityMarker('/workspace-debounce')).toBe(
      true,
    );
    expect(store.hasDatabaseCompatibilityMarker(null)).toBe(false);

    store.setMonitorState('rollup', null, {
      notifyState: {
        pendingRollup: { observations: [{ captured: 'rollup' }] },
      },
    });
    expect(store.hasDatabaseCompatibilityMarker(null)).toBe(true);
    expect(store.hasDatabaseCompatibilityMarker('')).toBe(false);
  });

  it('decides the marker from the state that was stored, not a second look at the caller object', () => {
    // A `toJSON` that serializes a nonempty rollup and then removes it once
    // left the held batch stored with no marker.
    const store = new RuntimeStore(createDb(':memory:'));
    const notifyState: Record<string, unknown> = {
      pendingRollup: { observations: [{ captured: 'rollup' }] },
      toJSON() {
        const copy = { pendingRollup: notifyState['pendingRollup'] };
        delete notifyState['pendingRollup'];
        return copy;
      },
    };

    store.setMonitorState('rollup', '/workspace-rollup', { notifyState });

    expect(store.getMonitorState('rollup', '/workspace-rollup')).toEqual({
      sourceState: {},
      notifyState: {
        pendingRollup: { observations: [{ captured: 'rollup' }] },
      },
    });
    expect(store.hasDatabaseCompatibilityMarker('/workspace-rollup')).toBe(
      true,
    );
  });

  it('commits neither the state nor the marker when the marker write fails, then succeeds on retry', () => {
    // 002 §15: the marker shares the monitor-state transaction.
    const db = createDb(':memory:');
    const store = new RuntimeStore(db);
    const client = clientOf(db);
    const held = {
      notifyState: {
        pendingDebounce: {
          observations: [{ captured: 'held' }],
          dueAt: RECEIPT_NOW.toISOString(),
        },
      },
    };
    // An earlier, empty state for the same route: the failed write must not
    // replace it either.
    store.setMonitorState('debounce', '/workspace-debounce', {
      notifyState: {},
    });
    client.exec(`
      CREATE TRIGGER fail_marker BEFORE INSERT ON database_compatibility_markers
      BEGIN SELECT RAISE(ABORT, 'injected marker fault'); END
    `);

    expect(() =>
      store.setMonitorState('debounce', '/workspace-debounce', held),
    ).toThrow('injected marker fault');
    expect(store.getMonitorState('debounce', '/workspace-debounce')).toEqual({
      sourceState: {},
      notifyState: {},
    });
    expect(store.hasDatabaseCompatibilityMarker('/workspace-debounce')).toBe(
      false,
    );

    client.exec('DROP TRIGGER fail_marker');
    store.setMonitorState('debounce', '/workspace-debounce', held);
    expect(store.getMonitorState('debounce', '/workspace-debounce')).toEqual({
      sourceState: {},
      notifyState: held.notifyState,
    });
    expect(store.hasDatabaseCompatibilityMarker('/workspace-debounce')).toBe(
      true,
    );
  });
});
