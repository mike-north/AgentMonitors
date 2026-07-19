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
  previewSettledHighDeliveryClient: vi.fn(),
  releaseDeliveryClient: vi.fn(),
  reserveDeliveryClient: vi.fn(),
}));

import { reserveSizedHookDelivery } from './hook.js';
import {
  previewSettledHighDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import {
  MAX_ADDITIONAL_CONTEXT,
  resolveHookClaimFit,
} from '../hook-deliver-render.js';

const previewMock = vi.mocked(previewSettledHighDeliveryClient);
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
