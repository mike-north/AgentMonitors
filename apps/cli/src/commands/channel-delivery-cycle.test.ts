/**
 * Unit tests for `runChannelDeliveryCycle`'s reserve → push → commit/release
 * branching (006 §4.5.1, issue #300) — in particular the null-commit path.
 *
 * The daemon round-trip (real `hook.reserve`/`hook.commit`/`hook.release` IPC
 * against a live daemon) is covered end to end by the integration suite
 * ("channel reserve → commit/release delivery cycle" in `cli.integration.test.ts`).
 * These tests instead pin how the cycle REACTS to each documented client return
 * value — including `commitDeliveryClient` returning `null` (the reservation
 * lapsed during a slow/hung push, or the daemon restarted and dropped the
 * in-memory lease), which the daemon TTL makes hard to force deterministically
 * over a socket. Stubbing the client is the precise, honest way to exercise that
 * branch: it tests the CLI's handling of `DeliveryClaim | null`, not an
 * approximation of the daemon.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DeliveryClaim, DeliveryReservation } from '@agentmonitors/core';

vi.mock('../runtime-client.js', () => ({
  reserveDeliveryClient: vi.fn(),
  commitDeliveryClient: vi.fn(),
  releaseDeliveryClient: vi.fn(),
}));

import { runChannelDeliveryCycle } from './channel.js';
import {
  reserveDeliveryClient,
  commitDeliveryClient,
  releaseDeliveryClient,
} from '../runtime-client.js';

const reserveMock = vi.mocked(reserveDeliveryClient);
const commitMock = vi.mocked(commitDeliveryClient);
const releaseMock = vi.mocked(releaseDeliveryClient);

const CLAIM: DeliveryClaim = {
  sessionId: 'session-1',
  mode: 'delivery',
  urgency: 'high',
  lifecycle: 'turn-interruptible',
  message: 'CI failed',
  unreadCounts: { low: 0, normal: 0, high: 1, total: 1 },
  events: [],
};
const RESERVATION: DeliveryReservation = {
  reservationId: 'r-1',
  claim: CLAIM,
};

const okPush = () => Promise.resolve();

beforeEach(() => {
  reserveMock.mockReset();
  commitMock.mockReset();
  releaseMock.mockReset();
});

describe('runChannelDeliveryCycle branching (issue #300)', () => {
  it('reports "idle" and never pushes when nothing is reserved', async () => {
    reserveMock.mockResolvedValue(null);
    const push = vi.fn(okPush);

    const outcome = await runChannelDeliveryCycle('session-1', '/sock', push);

    expect(outcome).toBe('idle');
    expect(push).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('commits after a successful push and reports "surfaced"', async () => {
    reserveMock.mockResolvedValue(RESERVATION);
    commitMock.mockResolvedValue(CLAIM);

    const outcome = await runChannelDeliveryCycle('session-1', '/sock', okPush);

    expect(outcome).toBe('surfaced');
    expect(commitMock).toHaveBeenCalledWith('r-1', '/sock');
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('reports "surfaced-uncommitted" when the push succeeded but commit returned null (does NOT claim success)', async () => {
    reserveMock.mockResolvedValue(RESERVATION);
    // Reservation lapsed/daemon restarted → commit finds nothing to commit.
    commitMock.mockResolvedValue(null);

    const outcome = await runChannelDeliveryCycle('session-1', '/sock', okPush);

    expect(outcome).toBe('surfaced-uncommitted');
    expect(commitMock).toHaveBeenCalledWith('r-1', '/sock');
    // The push already happened, so we do NOT release; the rows simply remain
    // unclaimed and re-deliver via the hook path / next poll (at-least-once).
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('releases the reservation and reports "push-failed" when the push rejects', async () => {
    reserveMock.mockResolvedValue(RESERVATION);
    releaseMock.mockResolvedValue(undefined);
    const push = vi.fn(() => Promise.reject(new Error('MCP disconnected')));

    const outcome = await runChannelDeliveryCycle('session-1', '/sock', push);

    expect(outcome).toBe('push-failed');
    expect(releaseMock).toHaveBeenCalledWith('r-1', '/sock');
    // Never commit an unsurfaced claim — that is the delivery-loss bug.
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('swallows a release failure on the push-reject path (still reports "push-failed")', async () => {
    reserveMock.mockResolvedValue(RESERVATION);
    releaseMock.mockRejectedValue(new Error('daemon unreachable'));
    const push = () => Promise.reject(new Error('MCP disconnected'));

    // The reservation self-expires if release can't reach the daemon; the cycle
    // must not throw out of the poll on this path.
    await expect(
      runChannelDeliveryCycle('session-1', '/sock', push),
    ).resolves.toBe('push-failed');
  });

  it('propagates a reserve IPC failure (poll loop maps it to a dropped session)', async () => {
    reserveMock.mockRejectedValue(new Error('daemon unreachable'));

    await expect(
      runChannelDeliveryCycle('session-1', '/sock', okPush),
    ).rejects.toThrow('daemon unreachable');
  });
});
