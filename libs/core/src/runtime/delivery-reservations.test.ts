/**
 * Reserve → commit/release delivery semantics (006 §4, issue #300).
 *
 * These are the core state-machine tests for the fix that stops the channel
 * transport consuming a delivery before it has actually surfaced it. They assert
 * the contract directly against a real runtime + store (no socket): reserving
 * renders the claim and LEASES its rows without marking them claimed; committing
 * marks them claimed ("was surfaced", never acknowledged); releasing returns
 * them to the hook path; and a leased row is hidden from a concurrent claim so
 * the two transports do not double-surface it.
 *
 * @see docs/specs/006-agent-integration.md §4 (channel transport), §4.5 (cross-transport dedup)
 * @see docs/specs/002-runtime-delivery.md §7 (unread / claimed / acknowledged states)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  sessionId: string;
  workspacePath: string;
}

/**
 * A runtime with one lead session and one settled (20s-old) high-urgency event
 * projected into it — the minimal state a `turn-interruptible` delivery
 * surfaces. `reservationTtlMs` overrides the uncommitted-reservation lifetime so
 * expiry can be exercised deterministically.
 */
function makeHarness(reservationTtlMs?: number): Harness {
  const workspacePath = mkdtempSync(path.join(tmpdir(), 'agentmon-reserve-'));
  tempDirs.push(workspacePath);
  const db = createDb(':memory:');
  const store = new RuntimeStore(db);
  const runtime = new AgentMonitorRuntime(
    store,
    new SourceRegistry(),
    [claudeCodeAdapter],
    undefined,
    reservationTtlMs === undefined
      ? {}
      : { deliveryReservationTtlMs: reservationTtlMs },
  );
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: `reserve-${String(Math.random()).slice(2)}`,
      workspacePath,
    }),
  );
  store.insertEvent({
    workspacePath,
    monitorId: 'urgent-monitor',
    sourceName: 'manual',
    urgency: 'high',
    title: 'CI failed',
    body: 'CI failed on the default branch',
    summary: 'CI failed on the default branch',
    payload: {},
    snapshotMetadata: {},
    snapshotText: null,
    diffText: null,
    objectKey: 'ci/default',
    queryScope: { pipeline: 'default' },
    tags: ['ci'],
    // 20s old → past the 15s high-urgency settle window (002 §9.1).
    createdAt: new Date(Date.now() - 20_000),
  });
  return { runtime, store, sessionId: session.id, workspacePath };
}

/** The single event's delivery state as `events list` would report it. */
function deliveryState(h: Harness): string | undefined {
  const [event] = h.runtime.listEvents({ sessionId: h.sessionId });
  return event?.deliveryState;
}

function unreadCount(h: Harness): number {
  return h.runtime.listEvents({ sessionId: h.sessionId, unreadOnly: true })
    .length;
}

describe('reserve → commit/release delivery semantics (issue #300)', () => {
  it('reserveDelivery renders the claim but does NOT mark the rows claimed', () => {
    const h = makeHarness();

    const reservation = h.runtime.reserveDelivery(
      h.sessionId,
      'turn-interruptible',
    );

    // The reserved claim is exactly what a direct claim would surface.
    expect(reservation).not.toBeNull();
    expect(reservation?.reservationId).toBeTruthy();
    expect(reservation?.claim.urgency).toBe('high');
    expect(reservation?.claim.events).toHaveLength(1);
    expect(reservation?.claim.events[0]?.title).toBe('CI failed');

    // But the row is NOT yet claimed: still unread AND unclaimed ("was surfaced"
    // is only stamped at commit — criterion 5).
    expect(deliveryState(h)).toBe('unread');
    expect(unreadCount(h)).toBe(1);
  });

  it('a leased row is hidden from a concurrent claim (hook/channel race, dedup)', () => {
    const h = makeHarness();

    const reservation = h.runtime.reserveDelivery(
      h.sessionId,
      'turn-interruptible',
    );
    expect(reservation).not.toBeNull();

    // While the reservation is outstanding, the hook transport's claim finds
    // nothing to surface — the channel is mid-surfacing this row, so it must not
    // be double-surfaced (006 §4.5).
    expect(
      h.runtime.claimDelivery(h.sessionId, 'turn-interruptible'),
    ).toBeNull();
    // previewSettledHighDelivery (the hook sizing path) agrees.
    expect(h.runtime.previewSettledHighDelivery(h.sessionId)).toHaveLength(0);
  });

  it('commitDelivery marks the reserved rows claimed but NOT acknowledged', () => {
    const h = makeHarness();

    const reservation = h.runtime.reserveDelivery(
      h.sessionId,
      'turn-interruptible',
    );
    if (!reservation) throw new Error('expected a reservation');

    const committed = h.runtime.commitDelivery(reservation.reservationId);
    expect(committed?.events).toHaveLength(1);

    // Now claimed ("was surfaced"), and deduped: a subsequent claim surfaces
    // nothing (criterion 3).
    expect(deliveryState(h)).toBe('claimed');
    expect(
      h.runtime.claimDelivery(h.sessionId, 'turn-interruptible'),
    ).toBeNull();
    // Claiming is never acknowledgement (BP2 / criterion 5): still unread.
    expect(unreadCount(h)).toBe(1);
  });

  it('releaseDelivery returns the rows to the hook path (failed-push fallback)', () => {
    const h = makeHarness();

    const reservation = h.runtime.reserveDelivery(
      h.sessionId,
      'turn-interruptible',
    );
    if (!reservation) throw new Error('expected a reservation');

    // Simulate a rejected/disconnected push: release without committing.
    h.runtime.releaseDelivery(reservation.reservationId);

    // The row was never claimed, so the hook transport now surfaces it
    // (criterion 2: failed pushes become eligible for immediate hook fallback).
    expect(deliveryState(h)).toBe('unread');
    const fallback = h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
    expect(fallback?.events).toHaveLength(1);
    expect(deliveryState(h)).toBe('claimed');
  });

  it('a released reservation is re-reservable (retry after a failed push)', () => {
    const h = makeHarness();

    const first = h.runtime.reserveDelivery(h.sessionId, 'turn-interruptible');
    if (!first) throw new Error('expected a reservation');
    h.runtime.releaseDelivery(first.reservationId);

    // Next poll reserves the same delivery again and, this time, commits it.
    const retry = h.runtime.reserveDelivery(h.sessionId, 'turn-interruptible');
    expect(retry?.claim.events).toHaveLength(1);
    if (!retry) throw new Error('expected a retry reservation');
    expect(retry.reservationId).not.toBe(first.reservationId);
    expect(h.runtime.commitDelivery(retry.reservationId)).not.toBeNull();
    expect(deliveryState(h)).toBe('claimed');
  });

  it('an expired reservation self-heals: rows return to pending, commit is a no-op', () => {
    // TTL 0 → the lease is void the instant it is taken.
    const h = makeHarness(0);

    const reservation = h.runtime.reserveDelivery(
      h.sessionId,
      'turn-interruptible',
    );
    if (!reservation) throw new Error('expected a reservation');

    // The lease has already expired, so the row is visible to the hook path
    // again (a crashed reserve must not hide it forever).
    expect(h.runtime.previewSettledHighDelivery(h.sessionId)).toHaveLength(1);

    // Committing an expired reservation claims nothing (safe no-op) — the rows
    // may already have re-delivered via the hook path.
    expect(h.runtime.commitDelivery(reservation.reservationId)).toBeNull();
    expect(deliveryState(h)).toBe('unread');
  });

  it('commitDelivery is single-use: a second commit is a no-op', () => {
    const h = makeHarness();

    const reservation = h.runtime.reserveDelivery(
      h.sessionId,
      'turn-interruptible',
    );
    if (!reservation) throw new Error('expected a reservation');

    expect(h.runtime.commitDelivery(reservation.reservationId)).not.toBeNull();
    expect(h.runtime.commitDelivery(reservation.reservationId)).toBeNull();
  });

  it('reserveDelivery returns null when nothing is pending', () => {
    const h = makeHarness();
    // Claim the only event so nothing is left pending.
    h.runtime.claimDelivery(h.sessionId, 'turn-interruptible');
    expect(
      h.runtime.reserveDelivery(h.sessionId, 'turn-interruptible'),
    ).toBeNull();
  });
});
