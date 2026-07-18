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
import type {
  DeliveryClaim,
  DeliveryEventSummary,
  DeliveryReservation,
} from '@agentmonitors/core';

vi.mock('../runtime-client.js', () => ({
  reserveDeliveryClient: vi.fn(),
  commitDeliveryClient: vi.fn(),
  releaseDeliveryClient: vi.fn(),
  previewSettledHighDeliveryClient: vi.fn(),
}));

import {
  reserveSizedChannelDelivery,
  runChannelDeliveryCycle,
} from './channel.js';
import { MAX_CHANNEL_CONTENT, renderChannelEvent } from '../channel-render.js';
import {
  reserveDeliveryClient,
  commitDeliveryClient,
  releaseDeliveryClient,
  previewSettledHighDeliveryClient,
} from '../runtime-client.js';

const reserveMock = vi.mocked(reserveDeliveryClient);
const commitMock = vi.mocked(commitDeliveryClient);
const releaseMock = vi.mocked(releaseDeliveryClient);
const previewMock = vi.mocked(previewSettledHighDeliveryClient);

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

function makeEvent(
  overrides: Partial<DeliveryEventSummary> = {},
): DeliveryEventSummary {
  return {
    eventId: 'e1',
    monitorId: 'm1',
    title: 't1',
    summary: 's1',
    urgency: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    body: 'a body',
    ...overrides,
  };
}

beforeEach(() => {
  reserveMock.mockReset();
  commitMock.mockReset();
  releaseMock.mockReset();
  // Most branching tests below are not about the settled-high preview/packing
  // path (issue #442) — default to "nothing settled" so `maxEvents` is
  // omitted, matching this file's pre-existing reservations/claims.
  previewMock.mockReset();
  previewMock.mockResolvedValue([]);
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

// ---------------------------------------------------------------------------
// Bounded reservation (006 §5.5, issue #442): previews the settled-high
// delivery, sizes how many WHOLE event blocks fit under the channel's content
// ceiling via the REAL `packChannelEventsUnderCap`, and passes that count as
// `reserveDelivery`'s `maxEvents` — so a large coalesced delivery re-delivers
// its deferred remainder on a LATER poll rather than being reserved/rendered
// unbounded in one push.
// ---------------------------------------------------------------------------
describe('runChannelDeliveryCycle bounded reservation (006 §5.5, issue #442)', () => {
  // Each body alone is well under the ceiling, but three together exceed it —
  // forcing `packChannelEventsUnderCap` to defer the third to a later poll.
  const BIG_BODY = 'x'.repeat(Math.floor(MAX_CHANNEL_CONTENT / 2.2));
  const events = [
    makeEvent({ eventId: 'e1', monitorId: 'm1', body: BIG_BODY }),
    makeEvent({ eventId: 'e2', monitorId: 'm2', body: BIG_BODY }),
    makeEvent({ eventId: 'e3', monitorId: 'm3', body: BIG_BODY }),
  ];

  function claimWith(surfaced: DeliveryEventSummary[]): DeliveryClaim {
    return {
      sessionId: 'session-1',
      mode: 'delivery',
      urgency: 'high',
      lifecycle: 'turn-interruptible',
      message: `${String(surfaced.length)} monitor(s) fired`,
      unreadCounts: {
        low: 0,
        normal: 0,
        high: events.length,
        total: events.length,
      },
      events: surfaced,
    };
  }

  it('reserves only as many whole blocks as fit under the ceiling, and defers the rest to a later poll', async () => {
    // --- Poll 1: all three events are still settled/pending. ---
    previewMock.mockResolvedValueOnce(events);
    const firstClaim = claimWith(events.slice(0, 2));
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-1',
      claim: firstClaim,
    });
    commitMock.mockResolvedValueOnce(firstClaim);
    const pushed: { events: DeliveryEventSummary[]; moreDeferred: boolean }[] =
      [];
    const push = (claim: DeliveryClaim, moreDeferred: boolean) => {
      pushed.push({ events: claim.events, moreDeferred });
      return Promise.resolve();
    };

    const first = await runChannelDeliveryCycle('session-1', '/sock', push);

    expect(first).toBe('surfaced');
    // Sized to 2, not 3: the third block did not fit under the ceiling.
    expect(reserveMock).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'turn-interruptible',
      '/sock',
      2,
    );
    expect(pushed[0]?.events.map((e) => e.eventId)).toEqual(['e1', 'e2']);
    // The push is told more was deferred, so the rendered content can
    // signpost it (`CHANNEL_DEFERRED_MARKER`).
    expect(pushed[0]?.moreDeferred).toBe(true);

    // --- Poll 2: only the deferred third event is still settled/pending —
    // the daemon's own preview reflects that e1/e2 are now claimed. ---
    const remaining = [events[2]];
    if (!remaining[0]) throw new Error('expected a third event');
    previewMock.mockResolvedValueOnce(remaining as DeliveryEventSummary[]);
    const secondClaim = claimWith(remaining as DeliveryEventSummary[]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-2',
      claim: secondClaim,
    });
    commitMock.mockResolvedValueOnce(secondClaim);

    const second = await runChannelDeliveryCycle('session-1', '/sock', push);

    expect(second).toBe('surfaced');
    // The single remaining event fits alone → reserved in full, nothing left
    // to defer.
    expect(reserveMock).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'turn-interruptible',
      '/sock',
      1,
    );
    expect(pushed[1]?.events.map((e) => e.eventId)).toEqual(['e3']);
    expect(pushed[1]?.moreDeferred).toBe(false);
  });

  it('omits maxEvents (reserves the full claim) when nothing is settled-high yet — a reminder claim needs no sizing', async () => {
    previewMock.mockResolvedValueOnce([]);
    reserveMock.mockResolvedValueOnce(RESERVATION);
    commitMock.mockResolvedValueOnce(CLAIM);

    const outcome = await runChannelDeliveryCycle('session-1', '/sock', okPush);

    expect(outcome).toBe('surfaced');
    expect(reserveMock).toHaveBeenCalledWith(
      'session-1',
      'turn-interruptible',
      '/sock',
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// PR #442 review comment 3609314772: preview and reservation are separate IPC
// operations, so `maxEvents` does not guarantee the reserved claim is the
// sized set. `reserveSizedChannelDelivery` must detect a mismatch between what
// was sized and what was actually reserved, release, and retry — in BOTH
// failure directions — so the pushed content never exceeds the ceiling.
// ---------------------------------------------------------------------------
describe('reserveSizedChannelDelivery race handling (issue #442)', () => {
  const BIG_BODY = 'z'.repeat(Math.floor(MAX_CHANNEL_CONTENT / 2.2));

  function claimWith(surfaced: DeliveryEventSummary[]): DeliveryClaim {
    return {
      sessionId: 'session-1',
      mode: 'delivery',
      urgency: 'high',
      lifecycle: 'turn-interruptible',
      message: `${String(surfaced.length)} monitor(s) fired`,
      unreadCounts: {
        low: 0,
        normal: 0,
        high: surfaced.length,
        total: surfaced.length,
      },
      events: surfaced,
    };
  }

  // Race (a): the preview raced empty (no settled-high events had crossed the
  // 15s settle boundary yet), so `maxEvents` was omitted — but by the time
  // `reserve` actually runs, three large events HAVE settled, and the
  // reservation comes back carrying the full, unbounded, unsized claim.
  it('releases and re-sizes when an empty preview is followed by an unbounded claim (race a)', async () => {
    const bigEvents = [
      makeEvent({ eventId: 'e1', monitorId: 'm1', body: BIG_BODY }),
      makeEvent({ eventId: 'e2', monitorId: 'm2', body: BIG_BODY }),
      makeEvent({ eventId: 'e3', monitorId: 'm3', body: BIG_BODY }),
    ];
    // Attempt 1: preview races empty → maxEvents omitted → the daemon still
    // returns the full, now-settled, three-event claim (unsized/oversized).
    previewMock.mockResolvedValueOnce([]);
    const oversizedClaim = claimWith(bigEvents);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-oversized',
      claim: oversizedClaim,
    });
    releaseMock.mockResolvedValueOnce(undefined);

    // Attempt 2: the retry previews again (the rows are still pending — they
    // were released, not claimed) and sizes/reserves correctly this time.
    previewMock.mockResolvedValueOnce(bigEvents);
    const sizedClaim = claimWith(bigEvents.slice(0, 2));
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-sized',
      claim: sizedClaim,
    });

    const result = await reserveSizedChannelDelivery('session-1', '/sock');

    expect(result).not.toBeNull();
    // The oversized reservation was released — never pushed, never committed.
    expect(releaseMock).toHaveBeenCalledWith('r-oversized', '/sock');
    expect(reserveMock).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'turn-interruptible',
      '/sock',
      undefined,
    );
    // Retry is bounded to what was actually measured on the mismatch.
    expect(reserveMock).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'turn-interruptible',
      '/sock',
      2,
    );
    expect(result?.reservation.reservationId).toBe('r-sized');
    expect(result?.moreDeferred).toBe(true);
    // End-to-end: the ACTUAL rendered/pushed content for the retried
    // reservation never exceeds the ceiling.
    const { content } = renderChannelEvent(
      result?.reservation.claim as DeliveryClaim,
      {
        moreDeferred: result?.moreDeferred ?? false,
      },
    );
    expect(content.length).toBeLessThanOrEqual(MAX_CHANNEL_CONTENT);
  });

  // Race (b): the previewed rows get leased/claimed by another transport (the
  // hook path) before `reserve` runs, so `reserveDelivery` fills the requested
  // COUNT (2) from DIFFERENT pending events — events whose sizes were never
  // measured by the preview that produced `maxEvents`, and which together
  // overflow the ceiling.
  it('releases and re-sizes when the reserved claim differs from the sized preview (race b)', async () => {
    const smallEvents = [
      makeEvent({ eventId: 's1', monitorId: 'sm1', body: 'tiny' }),
      makeEvent({ eventId: 's2', monitorId: 'sm2', body: 'tiny' }),
    ];
    // Sized so ONE alone fits under the ceiling but TWO together overflow it —
    // unlike the shared `BIG_BODY` (calibrated so three overflow but two fit,
    // for the "reserves only as many whole blocks as fit" test above).
    const HALF_BODY = 'w'.repeat(Math.floor(MAX_CHANNEL_CONTENT * 0.6));
    const substitutedBigEvents = [
      makeEvent({ eventId: 'b1', monitorId: 'bm1', body: HALF_BODY }),
      makeEvent({ eventId: 'b2', monitorId: 'bm2', body: HALF_BODY }),
    ];
    // Attempt 1: the preview sizes off the small events (both fit → maxEvents
    // = 2), but the actual reservation substitutes the DIFFERENT, oversized
    // events (they were leased elsewhere and the daemon filled the count from
    // whatever else was pending).
    previewMock.mockResolvedValueOnce(smallEvents);
    const substitutedClaim = claimWith(substitutedBigEvents);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-substituted',
      claim: substitutedClaim,
    });
    releaseMock.mockResolvedValueOnce(undefined);

    // Attempt 2: retry, now correctly bounded to 1 of the (still pending)
    // substituted events.
    previewMock.mockResolvedValueOnce(substitutedBigEvents);
    const fixedClaim = claimWith([
      substitutedBigEvents[0] as DeliveryEventSummary,
    ]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-fixed',
      claim: fixedClaim,
    });

    const result = await reserveSizedChannelDelivery('session-1', '/sock');

    expect(result).not.toBeNull();
    expect(releaseMock).toHaveBeenCalledWith('r-substituted', '/sock');
    expect(result?.reservation.reservationId).toBe('r-fixed');
    const { content } = renderChannelEvent(
      result?.reservation.claim as DeliveryClaim,
      {
        moreDeferred: result?.moreDeferred ?? false,
      },
    );
    expect(content.length).toBeLessThanOrEqual(MAX_CHANNEL_CONTENT);
  });

  // Forward-progress guarantee: repeated mismatches (the race keeps
  // reproducing on every retry) must not loop forever — the final attempt
  // forces a single-event reservation, which always terminates.
  it('falls back to a single-event reservation after repeated mismatches, and never pushes past the ceiling', async () => {
    const bigEvents = [
      makeEvent({ eventId: 'p1', monitorId: 'pm1', body: BIG_BODY }),
      makeEvent({ eventId: 'p2', monitorId: 'pm2', body: BIG_BODY }),
      makeEvent({ eventId: 'p3', monitorId: 'pm3', body: BIG_BODY }),
    ];
    // Every attempt keeps coming back oversized relative to what was sized,
    // simulating a persistently racing set of transports.
    previewMock.mockResolvedValue(bigEvents);
    reserveMock
      .mockResolvedValueOnce({
        reservationId: 'r-1',
        claim: claimWith(bigEvents),
      })
      .mockResolvedValueOnce({
        reservationId: 'r-2',
        claim: claimWith(bigEvents),
      })
      .mockResolvedValueOnce({
        // Final (forced maxEvents: 1) attempt: a single event, which always
        // fits `packChannelEventsUnderCap`'s own-length check.
        reservationId: 'r-3',
        claim: claimWith([bigEvents[0] as DeliveryEventSummary]),
      });
    releaseMock.mockResolvedValue(undefined);

    const result = await reserveSizedChannelDelivery('session-1', '/sock');

    expect(result).not.toBeNull();
    expect(reserveMock).toHaveBeenCalledTimes(3);
    expect(releaseMock).toHaveBeenCalledTimes(2);
    // The final attempt forced maxEvents: 1.
    expect(reserveMock).toHaveBeenNthCalledWith(
      3,
      'session-1',
      'turn-interruptible',
      '/sock',
      1,
    );
    expect(result?.reservation.reservationId).toBe('r-3');
    const { content } = renderChannelEvent(
      result?.reservation.claim as DeliveryClaim,
      {
        moreDeferred: result?.moreDeferred ?? false,
      },
    );
    expect(content.length).toBeLessThanOrEqual(MAX_CHANNEL_CONTENT);
  });
});
