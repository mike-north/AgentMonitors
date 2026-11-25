/**
 * Claim cycles expire without acknowledgment (002 §7.1). Expected boundaries
 * and delivery points are specified explicitly, independent of store output.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { Urgency } from '../schema/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const roots: string[] = [];
const clients: Database.Database[] = [];
const START = Date.UTC(2026, 0, 1) + 123;
const TTL = 60_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Reopening the same file reconstructs all claim state without a running timer. */
function harness(urgency: Urgency = 'high', claimTtlMs: number | null = TTL) {
  const root = mkdtempSync(path.join(tmpdir(), 'claim-ttl-'));
  roots.push(root);
  const dbPath = path.join(root, 'db.sqlite');
  const reopen = () => {
    const db = createDb(dbPath);
    const client = (db as unknown as { $client: Database.Database }).$client;
    clients.push(client);
    const store = new RuntimeStore(
      db,
      claimTtlMs === null ? {} : { claimTtlMs },
    );
    const runtime = new AgentMonitorRuntime(
      store,
      new SourceRegistry(),
      [claudeCodeAdapter],
      undefined,
      { deliveryReservationTtlMs: TTL * 10 },
    );
    return { client, store, runtime };
  };
  const h = reopen();
  const sessionId = h.runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'receiver',
      workspacePath: root,
    }),
  ).id;
  const insert = (title: string, band = urgency) =>
    h.store.insertEvent({
      workspacePath: root,
      monitorId: 'monitor',
      sourceName: 'manual',
      urgency: band,
      title,
      body: '',
      summary: '',
      payload: {},
      snapshotMetadata: {},
      snapshotText: title,
      diffText: null,
      objectKey: 'object',
      queryScope: {},
      tags: [],
      createdAt: new Date(Date.now() - 20_000),
    }).id;
  const eventId = insert('first');
  return { ...h, reopen, sessionId, eventId, insert, root };
}

it.each(['high', 'normal', 'low'] as const)(
  'expires %s exactly at TTL and offers it at its next delivery point',
  (urgency) => {
    const h = harness(urgency);
    const lifecycle = urgency === 'low' ? 'turn-idle' : 'turn-interruptible';
    expect(h.runtime.claimDelivery(h.sessionId, lifecycle)?.urgency).toBe(
      urgency,
    );
    vi.setSystemTime(START + TTL - 1);
    expect(
      h.runtime.listEvents({ sessionId: h.sessionId })[0]?.deliveryState,
    ).toBe('claimed');
    expect(h.runtime.claimDelivery(h.sessionId, lifecycle)).toBeNull();
    vi.setSystemTime(START + TTL);
    expect(
      h.runtime.listEvents({ sessionId: h.sessionId })[0]?.deliveryState,
    ).toBe('unread');
    expect(
      h.store.pendingEventsForSession(h.sessionId).map((e) => e.id),
    ).toEqual([h.eventId]);
    expect(
      h.store.unreadEventsForSession(h.sessionId).map((e) => e.id),
    ).toEqual([h.eventId]);
    if (urgency === 'low')
      expect(
        h.runtime.claimDelivery(h.sessionId, 'turn-interruptible'),
      ).toBeNull();
    expect(
      h.runtime.refreshHookState(h.sessionId)[
        urgency === 'high'
          ? 'hasPendingHigh'
          : urgency === 'normal'
            ? 'hasPendingNormal'
            : 'hasPendingLow'
      ],
    ).toBe(true);
    expect(h.runtime.claimDelivery(h.sessionId, lifecycle)?.urgency).toBe(
      urgency,
    );
    expect(
      h.runtime.listEvents({ sessionId: h.sessionId })[0]?.deliveryState,
    ).toBe('claimed');
  },
);

it.each([TTL / 2, TTL + 1])(
  'survives reopening after %i ms, including expiry while down',
  (downtime) => {
    const h = harness();
    h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
    h.client.close();
    clients.splice(clients.indexOf(h.client), 1);
    vi.setSystemTime(START + downtime);
    const restarted = h.reopen();
    if (downtime < TTL) {
      expect(
        restarted.runtime.claimDelivery(h.sessionId, 'turn-interruptible'),
      ).toBeNull();
      vi.setSystemTime(START + TTL);
    }
    expect(
      restarted.store.pendingEventsForSession(h.sessionId).map((e) => e.id),
    ).toEqual([h.eventId]);
    expect(
      restarted.runtime
        .claimDelivery(h.sessionId, 'turn-interruptible')
        ?.events.map((e) => e.eventId),
    ).toEqual([h.eventId]);
  },
);

it('repeats cycles, preserves first-surfaced history and never moves the cursor backward', () => {
  const h = harness();
  h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
  const firstNotifiedAt = new Date(Date.UTC(2026, 0, 1));
  vi.setSystemTime(START + 1000);
  const newer = h.insert('newer');
  h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
  for (const cycle of [1, 2, 3]) {
    vi.setSystemTime(START + cycle * TTL);
    expect(
      h.store.pendingEventsForSession(h.sessionId).map((e) => e.id),
    ).toContain(h.eventId);
    expect(
      h.runtime.claimDelivery(h.sessionId, 'turn-interruptible'),
    ).not.toBeNull();
    expect(
      h.store.getSessionObjectCursor(h.sessionId, 'monitor', 'object', h.root)
        ?.baselineContent,
    ).toBe('newer');
    const original = h.store
      .listDeliveryProjectionsForMonitor('monitor', h.root)
      .find((e) => e.eventId === h.eventId);
    expect(original?.firstNotifiedAt).toEqual(firstNotifiedAt);
  }
  h.runtime.acknowledgeSession(h.sessionId, [h.eventId, newer]);
  vi.setSystemTime(START + TTL * 10);
  expect(h.store.pendingEventsForSession(h.sessionId)).toEqual([]);
  expect(h.runtime.claimDelivery(h.sessionId, 'turn-interruptible')).toBeNull();
  expect(
    h.runtime
      .listEvents({ sessionId: h.sessionId })
      .map((e) => e.deliveryState),
  ).toEqual(['acknowledged', 'acknowledged']);
});

it('recaps do not renew the current cycle and acknowledgment before TTL prevents expiry', () => {
  const h = harness();
  h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
  vi.setSystemTime(START + TTL - 1);
  h.runtime.claimDelivery(h.sessionId, 'post-compact');
  vi.setSystemTime(START + TTL);
  expect(h.store.pendingEventsForSession(h.sessionId).map((e) => e.id)).toEqual(
    [h.eventId],
  );
  h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
  vi.setSystemTime(START + TTL * 2 - 1);
  h.runtime.acknowledgeSession(h.sessionId, [h.eventId]);
  vi.setSystemTime(START + TTL * 2);
  expect(
    h.runtime.listEvents({ sessionId: h.sessionId })[0]?.deliveryState,
  ).toBe('acknowledged');
  expect(h.store.pendingEventsForSession(h.sessionId)).toEqual([]);
});

it('does not expire an in-flight lease or start its claim clock before commit', () => {
  const h = harness('normal');
  const reservation = h.runtime.reserveDelivery(
    h.sessionId,
    'turn-interruptible',
  );
  if (!reservation) throw new Error('Expected reservation');
  vi.setSystemTime(START + TTL);
  expect(h.runtime.claimDelivery(h.sessionId, 'turn-interruptible')).toBeNull();
  expect(
    h.runtime.diagnoseHookDelivery(h.sessionId, 'turn-interruptible').holds[0]
      ?.reason,
  ).toBe('reserved-in-flight');
  h.runtime.commitDelivery(reservation.reservationId);
  vi.setSystemTime(START + TTL * 2 - 1);
  expect(h.store.pendingEventsForSession(h.sessionId)).toEqual([]);
  vi.setSystemTime(START + TTL * 2);
  expect(
    h.runtime.claimDelivery(h.sessionId, 'turn-interruptible')?.urgency,
  ).toBe('normal');
});

it('defaults to a 30 minute claim TTL', () => {
  const h = harness('high', null);
  h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
  vi.setSystemTime(START + 30 * 60_000 - 1);
  expect(h.runtime.claimDelivery(h.sessionId, 'turn-interruptible')).toBeNull();
  vi.setSystemTime(START + 30 * 60_000);
  expect(
    h.runtime.claimDelivery(h.sessionId, 'turn-interruptible'),
  ).not.toBeNull();
});

it('keeps post deadlines independent of claim expiry and preserves the cursor in a mixed recap', () => {
  const h = harness();
  const { eventId: postId } = h.runtime.postMessage({
    sessionId: h.sessionId,
    body: 'Follow up on the handoff',
    requireAck: true,
    resurfaceAfterMs: TTL * 2,
    maxResurfaces: 1,
  });
  const { eventId: oneOffId } = h.runtime.postMessage({
    sessionId: h.sessionId,
    body: 'Handoff started',
  });
  expect(
    h.runtime
      .claimDelivery(h.sessionId, 'turn-interruptible')
      ?.events.map((event) => event.eventId),
  ).toEqual(expect.arrayContaining([h.eventId, postId, oneOffId]));

  vi.setSystemTime(START + 1000);
  const newer = h.insert('newer');
  expect(
    h.runtime
      .claimDelivery(h.sessionId, 'turn-interruptible')
      ?.events.map((event) => event.eventId),
  ).toEqual([newer]);
  h.runtime.acknowledgeSession(h.sessionId, [newer]);

  vi.setSystemTime(START + TTL);
  expect(h.store.pendingEventsForSession(h.sessionId).map((e) => e.id)).toEqual(
    [h.eventId],
  );
  expect(
    h.runtime
      .listEvents({ sessionId: h.sessionId })
      .find((e) => e.id === postId),
  ).toMatchObject({ deliveryState: 'claimed', messageState: 'delivered' });

  vi.setSystemTime(START + TTL * 2);
  expect(
    h.runtime
      .claimDelivery(h.sessionId, 'post-compact')
      ?.events.map((event) => event.eventId),
  ).toEqual([postId, h.eventId]);
  expect(
    h.store.getSessionObjectCursor(h.sessionId, 'monitor', 'object', h.root)
      ?.baselineSnapshotId,
  ).toBe(newer);

  vi.setSystemTime(START + TTL * 4);
  expect(
    h.runtime
      .claimDelivery(h.sessionId, 'post-compact')
      ?.events.map((event) => event.eventId),
  ).toEqual([postId, h.eventId]);
  expect(
    h.runtime
      .listEvents({ sessionId: h.sessionId })
      .find((e) => e.id === postId),
  ).toMatchObject({
    deliveryState: 'claimed',
    messageState: 'needs-attention',
  });

  vi.setSystemTime(START + TTL * 6);
  expect(h.store.pendingEventsForSession(h.sessionId).map((e) => e.id)).toEqual(
    [h.eventId],
  );
});
