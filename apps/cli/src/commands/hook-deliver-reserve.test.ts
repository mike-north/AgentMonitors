/**
 * Unit tests for `reserveSizedHookDelivery`'s reserve → validate-fit →
 * release/retry branching (issue #442, PR #442 round-8 review).
 *
 * Before this fix, `hook deliver` sized a `turn-interruptible` claim by
 * COUNT alone (`previewSettledHighDeliveryClient` + `packEventsUnderCap`,
 * then `claimDeliveryClient(..., fit)`) — but the sizing preview and the
 * claim itself are two SEPARATE IPC round-trips, so the events actually
 * claimed could differ from the ones the preview measured (a "substitution
 * race": a concurrent caller claims/leases the previewed rows first, and the
 * claim instead fills the same requested count from different, larger
 * pending events). Because `claimDelivery` marks the underlying rows claimed
 * SYNCHRONOUSLY, a substituted, oversized set would pass the count check but
 * still get cut by `renderHookDelivery`'s own repack — and the cut tail of an
 * already-claimed event can never redeliver (006 §5.5's core guarantee).
 *
 * `reserveSizedHookDelivery` closes this gap by reserving first (leasing, not
 * claiming) and re-validating the fit of the ACTUAL reserved claim via
 * `resolveHookClaimFit` before the caller ever commits — releasing and
 * retrying on a mismatch, mirroring the channel transport's
 * `reserveSizedChannelDelivery` (`channel-delivery-cycle.test.ts`).
 *
 * @see docs/specs/006-agent-integration.md §5.1, §5.5
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';

vi.mock('../runtime-client.js', () => ({
  claimDeliveryClient: vi.fn(),
  commitDeliveryClient: vi.fn(),
  diagnoseHookDeliveryClient: vi.fn(),
  listSessionsClient: vi.fn(),
  previewCoalescedReminderClient: vi.fn(),
  previewSettledHighDeliveryClient: vi.fn(),
  releaseDeliveryClient: vi.fn(),
  reserveDeliveryClient: vi.fn(),
}));

import { reserveSizedHookDelivery } from './hook.js';
import {
  previewCoalescedReminderClient,
  previewSettledHighDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import {
  MAX_ADDITIONAL_CONTEXT,
  resolveHookClaimFit,
} from '../hook-deliver-render.js';

const previewMock = vi.mocked(previewSettledHighDeliveryClient);
const previewReminderMock = vi.mocked(previewCoalescedReminderClient);
const reserveMock = vi.mocked(reserveDeliveryClient);
const releaseMock = vi.mocked(releaseDeliveryClient);

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

beforeEach(() => {
  previewMock.mockReset();
  previewReminderMock.mockReset();
  previewReminderMock.mockResolvedValue(undefined);
  reserveMock.mockReset();
  releaseMock.mockReset();
  releaseMock.mockResolvedValue(undefined);
});

// ~2200 chars alone fits comfortably; two together (~4400) exceed the 4000
// additionalContext cap.
const BIG_BODY = 'x'.repeat(2200);

describe('reserveSizedHookDelivery substitution race (issue #442)', () => {
  it('releases and re-sizes when the reserved claim differs from the sized preview', async () => {
    const smallEvents = [
      makeEvent({ eventId: 's1', monitorId: 'sm1', body: 'tiny' }),
      makeEvent({ eventId: 's2', monitorId: 'sm2', body: 'tiny' }),
    ];
    const substitutedBigEvents = [
      makeEvent({ eventId: 'b1', monitorId: 'bm1', body: BIG_BODY }),
      makeEvent({ eventId: 'b2', monitorId: 'bm2', body: BIG_BODY }),
    ];
    // Attempt 1: the preview sizes off the small events (both fit under the
    // cap → maxEvents = 2), but the ACTUAL reservation substitutes different,
    // larger pending events that were never measured.
    previewMock.mockResolvedValueOnce(smallEvents);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-substituted',
      claim: claimWith(substitutedBigEvents),
    });

    // Attempt 2: retry, correctly bounded to 1 of the (still pending)
    // substituted events.
    previewMock.mockResolvedValueOnce(substitutedBigEvents);
    const fixedClaim = claimWith([
      substitutedBigEvents[0] as DeliveryEventSummary,
    ]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-fixed',
      claim: fixedClaim,
    });

    const result = await reserveSizedHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
    );

    expect(result).not.toBeNull();
    // The substituted, oversized reservation was released — NEVER committed,
    // so its rows return to pending rather than being irreversibly claimed
    // and then silently dropped from the render.
    expect(releaseMock).toHaveBeenCalledWith('r-substituted', '/sock');
    expect(result?.reservation.reservationId).toBe('r-fixed');
    expect(result?.reservation.claim.events.map((e) => e.eventId)).toEqual([
      'b1',
    ]);

    // The retried claim genuinely fits the renderer's own budget — proving
    // the fix, not just the release call.
    const fit = resolveHookClaimFit(
      result?.reservation.claim.events ?? [],
      'session-1',
      '/sock',
      result?.moreDeferred ?? false,
      MAX_ADDITIONAL_CONTEXT,
    );
    expect(fit.fits).toBe(true);
  });

  it('falls back to a single-event reservation after repeated mismatches (forward progress)', async () => {
    const bigEvents = [
      makeEvent({ eventId: 'p1', monitorId: 'pm1', body: BIG_BODY }),
      makeEvent({ eventId: 'p2', monitorId: 'pm2', body: BIG_BODY }),
      makeEvent({ eventId: 'p3', monitorId: 'pm3', body: BIG_BODY }),
    ];
    // Every attempt keeps coming back oversized relative to what was sized —
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
        // fits `resolveHookClaimFit`'s own-length check.
        reservationId: 'r-3',
        claim: claimWith([bigEvents[0] as DeliveryEventSummary]),
      });

    const result = await reserveSizedHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
    );

    expect(result).not.toBeNull();
    expect(reserveMock).toHaveBeenCalledTimes(3);
    // The final attempt forces maxEvents: 1, which is always accepted.
    expect(reserveMock).toHaveBeenNthCalledWith(
      3,
      'session-1',
      'turn-interruptible',
      '/sock',
      1,
    );
    expect(result?.reservation.reservationId).toBe('r-3');
    // Two mismatches were released before the forced final attempt.
    expect(releaseMock).toHaveBeenCalledTimes(2);
  });

  it('does not release or retry when the reserved claim is a reminder (no events)', async () => {
    previewMock.mockResolvedValueOnce([]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-reminder',
      claim: claimWith([]),
    });

    const result = await reserveSizedHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
    );

    expect(result?.reservation.reservationId).toBe('r-reminder');
    expect(result?.moreDeferred).toBe(false);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(reserveMock).toHaveBeenCalledTimes(1);
  });

  /**
   * (issue #442, PR #442 round-10 review) A reminder claim is a race-fallback:
   * `reserveDelivery` can legitimately return one even though the sizing
   * PREVIEW saw settled-high rows and computed `moreDeferred: true` from
   * them (the previewed rows got leased/claimed by another transport before
   * this reservation landed). Before this fix, `reserveSizedHookDelivery`
   * returned that STALE preview-derived `moreDeferred` unchanged for the
   * eventless branch — `renderHookDelivery` never reads it for a `claim.events
   * .length === 0` reminder (so the render itself was never wrong), but
   * `hook.ts`'s `--debug` `describeCapDeferral` line DOES read it, so it
   * would wrongly report a "cap deferral" for a claim that carries no
   * cap-truncated events at all. Reproduces that exact race: the preview sees
   * two oversized settled-high events (too big to both fit, so `moreDeferred`
   * would be computed `true`), but the actual reservation comes back as a
   * plain reminder.
   */
  it('clears a stale preview-derived moreDeferred when the reservation races down to an eventless reminder', async () => {
    const staleHighEvents = [
      makeEvent({ eventId: 'p1', monitorId: 'pm1', body: BIG_BODY }),
      makeEvent({ eventId: 'p2', monitorId: 'pm2', body: BIG_BODY }),
    ];
    previewMock.mockResolvedValueOnce(staleHighEvents);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-reminder-raced',
      claim: claimWith([]),
    });

    const result = await reserveSizedHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
    );

    expect(result?.reservation.reservationId).toBe('r-reminder-raced');
    // The stale high-preview's moreDeferred must NOT leak into this eventless
    // reminder's result.
    expect(result?.moreDeferred).toBe(false);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(reserveMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a non-turn-interruptible (post-compact) claim unsized, with no fit re-validation', async () => {
    const hugeRecap = [makeEvent({ body: 'x'.repeat(50_000) })];
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-recap',
      claim: claimWith(hugeRecap),
    });

    const result = await reserveSizedHookDelivery(
      'session-1',
      'post-compact',
      '/sock',
    );

    expect(result?.reservation.reservationId).toBe('r-recap');
    // No settled-high preview is taken for a non-turn-interruptible claim.
    expect(previewMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('returns null when nothing is pending to reserve', async () => {
    previewMock.mockResolvedValueOnce([]);
    reserveMock.mockResolvedValueOnce(null);

    const result = await reserveSizedHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
    );

    expect(result).toBeNull();
  });
});

/**
 * Candidate-set-growth race (issue #442, PR #442 round-9 review): a settled
 * event that arrives AFTER the sizing preview but BEFORE `reserve` returns is
 * invisible to that preview's `moreDeferred`, yet still needs to signpost as
 * pending — mirrors `channel-delivery-cycle.test.ts`'s
 * `reserveSizedChannelDelivery candidate-set growth race` suite exactly, on
 * the hook transport's `reserveSizedHookDelivery`.
 *
 * Before this fix: the preview sees only event A → `maxEvents=1`,
 * `moreDeferred=false`. Event B settles (crosses the 15s debounce boundary)
 * before `reserve` runs. The reservation legitimately returns only A, which
 * fits under the cap on its own — so the fit check passed and the (stale)
 * `moreDeferred: false` was returned unchanged, silently dropping the marker
 * that would have told the agent B is genuinely pending (§5.5).
 */
describe('reserveSizedHookDelivery candidate-set growth race (issue #442, round-9 review)', () => {
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
    // was never part of this reservation.
    previewMock.mockResolvedValueOnce([firstEvent, secondEvent]);

    const result = await reserveSizedHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
    );

    expect(result).not.toBeNull();
    expect(result?.reservation.reservationId).toBe('r-1');
    expect(result?.reservation.claim.events.map((e) => e.eventId)).toEqual([
      'e1',
    ]);
    // The reservation itself was never released/retried — it genuinely fits.
    expect(releaseMock).not.toHaveBeenCalled();
    expect(reserveMock).toHaveBeenCalledTimes(1);
    // The revalidation preview ran once more, after the reservation.
    expect(previewMock).toHaveBeenCalledTimes(2);
    // e2 remains settled-but-unclaimed even though the reservation of e1
    // alone fits — moreDeferred must flip true so the render signposts it.
    expect(result?.moreDeferred).toBe(true);
  });

  it('leaves moreDeferred false when no further settled work remains beyond the reserved set', async () => {
    const onlyEvent = makeEvent({ eventId: 'e1', monitorId: 'm1' });

    previewMock.mockResolvedValueOnce([onlyEvent]);
    const claim = claimWith([onlyEvent]);
    reserveMock.mockResolvedValueOnce({ reservationId: 'r-1', claim });
    // Revalidation preview: still just the one (now-reserved) event —
    // nothing grew in the gap.
    previewMock.mockResolvedValueOnce([onlyEvent]);

    const result = await reserveSizedHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
    );

    expect(result).not.toBeNull();
    expect(result?.moreDeferred).toBe(false);
  });

  it('releases the reservation before propagating when the revalidation preview rejects', async () => {
    const onlyEvent = makeEvent({ eventId: 'e1', monitorId: 'm1' });
    previewMock.mockResolvedValueOnce([onlyEvent]);
    const claim = claimWith([onlyEvent]);
    reserveMock.mockResolvedValueOnce({ reservationId: 'r-1', claim });
    previewMock.mockRejectedValueOnce(new Error('daemon unreachable'));
    releaseMock.mockResolvedValueOnce(undefined);

    await expect(
      reserveSizedHookDelivery('session-1', 'turn-interruptible', '/sock'),
    ).rejects.toThrow('daemon unreachable');

    expect(releaseMock).toHaveBeenCalledWith('r-1', '/sock');
    expect(releaseMock).toHaveBeenCalledTimes(1);
    // No retry: the reservation is released and the error propagates
    // immediately.
    expect(reserveMock).toHaveBeenCalledTimes(1);
  });

  it('recomputes fit against the final moreDeferred value and retries when marker room no longer fits', async () => {
    // Two events whose combined blocks fit under the FULL cap, but not under
    // (cap − deferred-marker length) once moreDeferred flips true.
    const BODY = 'y'.repeat(1900);
    const firstEvent = makeEvent({
      eventId: 'e1',
      monitorId: 'm1',
      body: BODY,
    });
    const secondEvent = makeEvent({
      eventId: 'e2',
      monitorId: 'm2',
      body: BODY,
    });
    const thirdEvent = makeEvent({ eventId: 'e3', monitorId: 'm3' });

    // Attempt 1: sizing preview sees e1+e2 (fits at maxEvents=2, moreDeferred
    // false); reservation returns exactly those two, which fit under the
    // FULL cap — but a third event (e3) settles in the gap, so the
    // revalidation preview flips moreDeferred true, and marker-reserved
    // repacking can no longer fit both e1 and e2.
    previewMock.mockResolvedValueOnce([firstEvent, secondEvent]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-grown',
      claim: claimWith([firstEvent, secondEvent]),
    });
    previewMock.mockResolvedValueOnce([firstEvent, secondEvent, thirdEvent]);

    // Attempt 2 (retry, tightened to the just-measured includedCount).
    previewMock.mockResolvedValueOnce([firstEvent, secondEvent, thirdEvent]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-fixed',
      claim: claimWith([firstEvent]),
    });

    const result = await reserveSizedHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
    );

    expect(result).not.toBeNull();
    expect(releaseMock).toHaveBeenCalledWith('r-grown', '/sock');
    expect(result?.reservation.reservationId).toBe('r-fixed');
    expect(result?.moreDeferred).toBe(true);
    const fit = resolveHookClaimFit(
      result?.reservation.claim.events ?? [],
      'session-1',
      '/sock',
      true,
      MAX_ADDITIONAL_CONTEXT,
    );
    expect(fit.fits).toBe(true);
  });
});
