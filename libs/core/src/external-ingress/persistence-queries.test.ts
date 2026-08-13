import { describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { RuntimeStore } from '../runtime/store.js';
import {
  RECEIPT_EVENT_ID,
  RECEIPT_MATERIALIZED_AT,
  RECEIPT_NOW,
  receiptInput,
} from './persistence.fixtures.js';

describe('external event persistence queries', () => {
  it('reads safe receipt and high-water state only through the exact workspace', () => {
    const store = new RuntimeStore(createDb(':memory:'));
    const accepted = store.withExternalEventReceipt(
      receiptInput(),
      () => ({
        outcome: 'materialized',
        eventIds: [RECEIPT_EVENT_ID],
        materializedAt: RECEIPT_MATERIALIZED_AT,
      }),
      RECEIPT_NOW,
    );
    if (accepted.decision !== 'accepted')
      throw new Error('expected acceptance');

    expect(
      store.externalEventReceiptStatus(
        '/workspace-a',
        accepted.receipt.receiptId,
      ),
    ).toEqual(accepted.receipt);
    expect(
      store.externalEventReceiptStatus(
        '/workspace-b',
        accepted.receipt.receiptId,
      ),
    ).toBeNull();
    expect(
      store.externalEventReceiptStatus('/workspace-a', 'missing-receipt'),
    ).toBeNull();

    expect(
      store.externalObjectSequence(
        '/workspace-a',
        'build-health',
        'example-build-system',
        'build-group-123',
      ),
    ).toEqual({
      workspaceIdentity: '/workspace-a',
      monitorId: 'build-health',
      source: 'example-build-system',
      objectId: 'build-group-123',
      highestSequence: 42,
      receiptId: accepted.receipt.receiptId,
      upstreamEventId: 'delivery-42',
      updatedAt: RECEIPT_NOW,
    });
    expect(
      store.externalObjectSequence(
        '/workspace-b',
        'build-health',
        'example-build-system',
        'build-group-123',
      ),
    ).toBeNull();
  });

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
});
