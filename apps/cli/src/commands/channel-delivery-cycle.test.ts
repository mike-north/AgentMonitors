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
import {
  buildChannelTruncatedMarker,
  CHANNEL_DEFERRED_MARKER,
  MAX_CHANNEL_CONTENT,
  renderChannelEvent,
} from '../channel-render.js';
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

// ---------------------------------------------------------------------------
// PR #442 round-3 review: the actual-claim fit check must validate against
// the SAME effective budget `renderChannelEvent` uses, not the full cap alone
// (`packChannelEventsUnderCap(actualEvents)` in isolation omits the
// deferred-marker budget). Reproduces the reviewer's on-head probe: two
// blocks whose joined length lands strictly between `(cap − marker)` and
// `cap` pass a full-cap-only check, but `renderChannelEvent` — because
// `moreDeferred` is true — repacks WITH marker room reserved and drops the
// second block. Before the fix, `meta.event_count` reported 2 while only one
// block's content was actually rendered, and both rows were committed
// (silently losing the second event's surfaced content, though the row
// itself stayed durable).
// ---------------------------------------------------------------------------
describe('reserveSizedChannelDelivery actual-claim fit vs. renderer budget (issue #442, round-3 review)', () => {
  // Calibrated so the two blocks joined (b1 + '\n\n' + b2) land at 19,938
  // chars: > (MAX_CHANNEL_CONTENT − CHANNEL_DEFERRED_MARKER.length = 19,929)
  // but <= MAX_CHANNEL_CONTENT (20,000) — the exact boundary window the old
  // full-cap-only check could not see.
  const BOUNDARY_BODY = 'x'.repeat(9950);

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

  it('releases and re-sizes a claim that fits the full cap but not the marker-reserved budget when moreDeferred is true', async () => {
    const boundaryEvents = [
      makeEvent({ eventId: 'e1', monitorId: 'm1', body: BOUNDARY_BODY }),
      makeEvent({ eventId: 'e2', monitorId: 'm2', body: BOUNDARY_BODY }),
    ];
    // The preview must be faithful to what `packChannelEventsUnderCap` (core's
    // actual sizing function) computes `maxEvents` as — otherwise the mocked
    // reservation below (returning 2 events) is a claim core could never
    // produce for that `maxEvents`. Two small preview events fit the full cap
    // easily; a third, oversized one pushes the joined set over
    // MAX_CHANNEL_CONTENT, forcing marker-room reservation. That reserved
    // pack still fits the two small blocks (they're tiny), so
    // `packChannelEventsUnderCap` sizes `maxEvents` to 2 (moreDeferred: true,
    // since 2 < 3 previewed) — a reservation returning 2 events is exactly
    // what core would produce here. The mocked reservation then "substitutes"
    // the two BOUNDARY-sized events instead (mirroring the preview↔reserve
    // race the existing race(a)/(b) tests exercise), so the actually-claimed
    // set is the boundary pair above — same count (2) as `maxEvents`, but
    // sized to land in the exact boundary window this test targets.
    const previewSmallEvents = [
      makeEvent({ eventId: 'p1', monitorId: 'p1', body: 'small body 1' }),
      makeEvent({ eventId: 'p2', monitorId: 'p2', body: 'small body 2' }),
    ];
    const thirdEvent = makeEvent({
      eventId: 'e3',
      monitorId: 'm3',
      body: 'z'.repeat(19_960),
    });
    previewMock.mockResolvedValueOnce([
      previewSmallEvents[0] as DeliveryEventSummary,
      previewSmallEvents[1] as DeliveryEventSummary,
      thirdEvent,
    ]);
    const mismatchedClaim = claimWith(boundaryEvents);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-boundary',
      claim: mismatchedClaim,
    });
    releaseMock.mockResolvedValueOnce(undefined);

    // Retry: the rows are still pending (released, not claimed) and this
    // time size/reserve correctly to a single event.
    previewMock.mockResolvedValueOnce([
      boundaryEvents[0] as DeliveryEventSummary,
    ]);
    const fixedClaim = claimWith([boundaryEvents[0] as DeliveryEventSummary]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-fixed',
      claim: fixedClaim,
    });

    const result = await reserveSizedChannelDelivery('session-1', '/sock');

    expect(result).not.toBeNull();
    // The boundary-fitting-but-marker-shrinking claim was released, not
    // trusted as-is.
    expect(releaseMock).toHaveBeenCalledWith('r-boundary', '/sock');
    expect(result?.reservation.reservationId).toBe('r-fixed');

    // The invariant this fixes: render the FINAL committed claim and assert
    // the committed set equals the rendered set — every committed event's
    // block actually appears, and `event_count` matches the events actually
    // present (never reporting more than what was rendered).
    const { content, meta } = renderChannelEvent(
      result?.reservation.claim as DeliveryClaim,
      { moreDeferred: result?.moreDeferred ?? false },
    );
    const committedEvents = (result?.reservation.claim as DeliveryClaim).events;
    expect(meta.event_count).toBe(String(committedEvents.length));
    for (const event of committedEvents) {
      expect(content).toContain(`### ${event.monitorId} (high)`);
    }
    expect(content.length).toBeLessThanOrEqual(MAX_CHANNEL_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// PR #442 round-4 review: a stale settled-high preview that seeded
// `moreDeferred: true` must not be applied to a REMINDER reservation
// (`claim.events: []`) that `reserveDelivery` legitimately returns instead —
// the previewed rows raced to another transport's lease/claim before reserve
// ran, and `renderChannelEvent` renders the reminder's `message` directly,
// never consulting `moreDeferred`/`resolveChannelClaimFit` on that path.
// ---------------------------------------------------------------------------
describe('reserveSizedChannelDelivery eventless reminder claim (issue #442, round-4 review)', () => {
  const REMINDER_CLAIM: DeliveryClaim = {
    sessionId: 'session-1',
    mode: 'delivery',
    urgency: 'normal',
    lifecycle: 'turn-interruptible',
    message: '3 monitor(s) updated',
    unreadCounts: { low: 0, normal: 2, high: 1, total: 3 },
    events: [],
  };

  it('accepts a reminder claim with events: [] on the first reservation, without releasing or retrying, even when the stale high preview set moreDeferred', async () => {
    // Two oversized high events in the preview force `moreDeferred: true` and
    // a tight `maxEvents` — but by the time `reserveDelivery` runs, another
    // transport has already leased/claimed both, so the reservation that
    // comes back is a normal reminder (`events: []`), which core returns
    // irrespective of `maxEvents` for the reminder branch.
    const oversizedEvents = [
      makeEvent({
        eventId: 'e1',
        monitorId: 'm1',
        body: 'x'.repeat(MAX_CHANNEL_CONTENT),
      }),
      makeEvent({
        eventId: 'e2',
        monitorId: 'm2',
        body: 'y'.repeat(MAX_CHANNEL_CONTENT),
      }),
    ];
    previewMock.mockResolvedValueOnce(oversizedEvents);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-reminder',
      claim: REMINDER_CLAIM,
    });

    const result = await reserveSizedChannelDelivery('session-1', '/sock');

    expect(result).not.toBeNull();
    expect(result?.reservation.reservationId).toBe('r-reminder');
    expect(result?.reservation.claim.events).toEqual([]);
    // The stale high-preview's moreDeferred must not leak into the accepted
    // reminder result: renderChannelEvent's reminder branch ignores it, so it
    // would only ever cause a spurious release/retry loop here.
    expect(result?.moreDeferred).toBe(false);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(previewMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PR #442 round-6 review (comment 3609676601): candidate-set GROWTH race —
// the preview holds exactly one event (maxEvents=1, moreDeferred=false); a
// SECOND event settles before `reserveDelivery` runs; the resulting claim
// legitimately contains only the first event and fits, so the earlier
// mismatch check reports `fits: true` — but the second, now-settled event is
// left pending with no `CHANNEL_DEFERRED_MARKER` signposting it, contrary to
// 006 §5.5 ("the render omits any pending event ... signposting that more
// updates are pending").
// ---------------------------------------------------------------------------
describe('reserveSizedChannelDelivery candidate-set growth race (issue #442, round-6 review)', () => {
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

  it('sets moreDeferred when a second event settles between the sizing preview and the reservation', async () => {
    const firstEvent = makeEvent({ eventId: 'e1', monitorId: 'm1' });
    const secondEvent = makeEvent({ eventId: 'e2', monitorId: 'm2' });

    // Sizing preview sees only the first event → maxEvents=1, moreDeferred
    // computed false (nothing else was settled AT THAT TIME).
    previewMock.mockResolvedValueOnce([firstEvent]);
    const claim = claimWith([firstEvent]);
    reserveMock.mockResolvedValueOnce({ reservationId: 'r-1', claim });
    // Revalidation preview (run AFTER the reservation is accepted): the
    // second event has now settled too, so it is visible here even though it
    // was never part of this claim.
    previewMock.mockResolvedValueOnce([firstEvent, secondEvent]);

    const result = await reserveSizedChannelDelivery('session-1', '/sock');

    expect(result).not.toBeNull();
    expect(result?.reservation.reservationId).toBe('r-1');
    expect(result?.reservation.claim.events.map((e) => e.eventId)).toEqual([
      'e1',
    ]);
    // The claim itself was never released/retried — it genuinely fits.
    expect(releaseMock).not.toHaveBeenCalled();
    expect(reserveMock).toHaveBeenCalledTimes(1);
    // The revalidation preview ran once more, after the reservation.
    expect(previewMock).toHaveBeenCalledTimes(2);
    // The pushed content must carry the deferred marker, since e2 remains
    // settled-but-unclaimed even though the claim of e1 alone fits.
    expect(result?.moreDeferred).toBe(true);
    const { content } = renderChannelEvent(
      result?.reservation.claim as DeliveryClaim,
      { moreDeferred: result?.moreDeferred ?? false },
    );
    expect(content).toContain(CHANNEL_DEFERRED_MARKER.trim());
  });

  it('leaves moreDeferred false when no further settled work remains beyond the claimed set', async () => {
    const onlyEvent = makeEvent({ eventId: 'e1', monitorId: 'm1' });

    previewMock.mockResolvedValueOnce([onlyEvent]);
    const claim = claimWith([onlyEvent]);
    reserveMock.mockResolvedValueOnce({ reservationId: 'r-1', claim });
    // Revalidation preview: still just the one (now-claimed) event — nothing
    // grew in the gap.
    previewMock.mockResolvedValueOnce([onlyEvent]);

    const result = await reserveSizedChannelDelivery('session-1', '/sock');

    expect(result).not.toBeNull();
    expect(result?.moreDeferred).toBe(false);
    const { content } = renderChannelEvent(
      result?.reservation.claim as DeliveryClaim,
      { moreDeferred: result?.moreDeferred ?? false },
    );
    expect(content).not.toContain(CHANNEL_DEFERRED_MARKER.trim());
  });
});

// ---------------------------------------------------------------------------
// PR #442 round-3 review: a release failure on the mismatch path must
// propagate — not be swallowed — so the oversized reservation's stuck-leased
// rows are surfaced as a cycle failure rather than misreported as `'idle'`.
// ---------------------------------------------------------------------------
describe('reserveSizedChannelDelivery mismatch-release failure propagation (issue #442, round-3 review)', () => {
  const BIG_BODY = 'q'.repeat(Math.floor(MAX_CHANNEL_CONTENT / 2.2));

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

  it('propagates a release rejection instead of swallowing it, and does not attempt a retry reservation', async () => {
    const oversizedEvents = [
      makeEvent({ eventId: 'o1', monitorId: 'om1', body: BIG_BODY }),
      makeEvent({ eventId: 'o2', monitorId: 'om2', body: BIG_BODY }),
      makeEvent({ eventId: 'o3', monitorId: 'om3', body: BIG_BODY }),
    ];
    previewMock.mockResolvedValueOnce(oversizedEvents);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-oversized',
      claim: claimWith(oversizedEvents),
    });
    releaseMock.mockRejectedValueOnce(new Error('daemon unreachable'));

    await expect(
      reserveSizedChannelDelivery('session-1', '/sock'),
    ).rejects.toThrow('daemon unreachable');

    // No retry: the loop must not proceed past a release it could not
    // confirm succeeded.
    expect(reserveMock).toHaveBeenCalledTimes(1);
  });

  it('propagates through runChannelDeliveryCycle too (never misreports "idle")', async () => {
    const oversizedEvents = [
      makeEvent({ eventId: 'o1', monitorId: 'om1', body: BIG_BODY }),
      makeEvent({ eventId: 'o2', monitorId: 'om2', body: BIG_BODY }),
      makeEvent({ eventId: 'o3', monitorId: 'om3', body: BIG_BODY }),
    ];
    previewMock.mockResolvedValueOnce(oversizedEvents);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-oversized',
      claim: claimWith(oversizedEvents),
    });
    releaseMock.mockRejectedValueOnce(new Error('daemon unreachable'));
    const push = vi.fn(okPush);

    await expect(
      runChannelDeliveryCycle('session-1', '/sock', push),
    ).rejects.toThrow('daemon unreachable');

    expect(push).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR #442 round-5 review: a single event whose own block already exceeds the
// ceiling still gets COMMITTED after `push` resolves (the mid-truncation
// happens inside `push`'s rendering, not before reserve/commit) — committing
// sets `first_notified_at`, and `pendingEventsForSession()` only returns rows
// where that column is still NULL (006 §9), so this event can NEVER surface
// on a later poll. The old `CHANNEL_DEFERRED_MARKER` falsely told the agent
// "they will surface on a later poll"; the cycle goes idle instead, and the
// full body is only recoverable via the durable unread copy (claiming ≠
// acking, BP2 / SP4).
// ---------------------------------------------------------------------------
describe('runChannelDeliveryCycle oversized single-event commit (issue #442, round-5 review)', () => {
  it('commits an oversized event whose content was mid-truncated, then reports idle on the next poll (never re-surfaces the omitted tail)', async () => {
    const hugeEvent = makeEvent({
      eventId: 'huge-1',
      monitorId: 'runaway-monitor',
      body: 'x'.repeat(5_000_000),
    });
    const claim: DeliveryClaim = {
      sessionId: 'session-1',
      mode: 'delivery',
      urgency: 'high',
      lifecycle: 'turn-interruptible',
      message: '1 monitor(s) fired',
      unreadCounts: { low: 0, normal: 0, high: 1, total: 1 },
      events: [hugeEvent],
    };

    // --- Poll 1: the oversized event is reserved, mid-truncated by the
    // renderer inside `push`, and committed (the push resolved). ---
    previewMock.mockResolvedValueOnce([hugeEvent]);
    reserveMock.mockResolvedValueOnce({ reservationId: 'r-huge', claim });
    commitMock.mockResolvedValueOnce(claim);

    let renderedContent = '';
    const push = (pushedClaim: DeliveryClaim, moreDeferred: boolean) => {
      renderedContent = renderChannelEvent(pushedClaim, {
        moreDeferred,
      }).content;
      return Promise.resolve();
    };

    const first = await runChannelDeliveryCycle('session-1', '/sock', push);

    expect(first).toBe('surfaced');
    expect(commitMock).toHaveBeenCalledWith('r-huge', '/sock');
    // The rendered content signposts the durable unread copy — not a later
    // poll re-delivery, which cannot happen for a row that is now committed.
    // The marker must be the DIRECTLY RUNNABLE session-scoped command (issue
    // #442 round-6 review): a bare `--unread` without `--session` exits 1.
    expect(renderedContent).toContain(
      buildChannelTruncatedMarker(claim.sessionId).trim(),
    );
    expect(renderedContent).not.toContain(CHANNEL_DEFERRED_MARKER.trim());
    expect(renderedContent).toContain(
      `agentmonitors events list --session ${claim.sessionId} --unread`,
    );

    // --- Poll 2: the row is now committed (`first_notified_at` set), so a
    // real daemon's `pendingEventsForSession()` would no longer return it —
    // nothing else is pending, so both the settled-high preview and the
    // reservation come back empty/null. ---
    previewMock.mockResolvedValueOnce([]);
    reserveMock.mockResolvedValueOnce(null);
    const push2 = vi.fn(okPush);

    const second = await runChannelDeliveryCycle('session-1', '/sock', push2);

    // The omitted tail does NOT surface on this later poll: the cycle is
    // idle, not "surfaced" again.
    expect(second).toBe('idle');
    expect(push2).not.toHaveBeenCalled();
    expect(commitMock).toHaveBeenCalledTimes(1);
  });
});
