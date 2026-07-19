/**
 * Failure-injection tests for `session start`'s SessionStart post-compact
 * recap ordering (issue #442, PR #442 round-16 review).
 *
 * Before this fix, `session start` committed the reservation via a direct
 * `claimDeliveryClient` call — the durable `first_notified_at` mutation —
 * BEFORE rendering or writing anything, then wrote the recap via a bare,
 * un-awaited `process.stdout.write(JSON.stringify(delivery))`. That is the
 * SAME claim-before-fallible-surface ordering `hook deliver` closed for its
 * own transport in round 9 (see `hook-deliver-commit-ordering.test.ts`): an
 * asynchronous write failure (e.g. `EPIPE` once Claude Code's hook consumer
 * has already closed its end of the pipe) arriving after that call would
 * durably claim the recap rows while the recap itself never reached the
 * agent — an at-most-once loss window.
 *
 * The fix routes `session start`'s recap through the exact SAME shared
 * `reserveRenderAndCommitHookDelivery` / `writeAndCommitHookDelivery` /
 * `writeStreamChunk` flow `hook.ts`'s `deliver` action uses (`session.ts`
 * imports them directly from `./hook.js`), for the `post-compact` lifecycle
 * specifically — the lifecycle `session start` actually claims. These tests
 * exercise that flow end-to-end against a REAL, delayed-failure `Writable`
 * (mirroring `hook-deliver-commit-ordering.test.ts`'s real-stream regressions
 * for the `turn-interruptible`/generic case), proving a write failure
 * releases the reservation instead of committing — the rows stay pending and
 * redeliver at the next context event rather than being lost.
 *
 * @see docs/specs/005-cli-reference.md §10.4
 * @see docs/specs/006-agent-integration.md §5.6
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import { closeSync, createWriteStream, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../runtime-client.js', () => ({
  claimDeliveryClient: vi.fn(),
  commitDeliveryClient: vi.fn(),
  diagnoseHookDeliveryClient: vi.fn(),
  listSessionsClient: vi.fn(),
  previewSettledHighDeliveryClient: vi.fn(),
  releaseDeliveryClient: vi.fn(),
  reserveDeliveryClient: vi.fn(),
}));

import {
  reserveRenderAndCommitHookDelivery,
  writeAndCommitHookDelivery,
  writeStreamChunk,
} from './hook.js';
import {
  commitDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';

const reserveMock = vi.mocked(reserveDeliveryClient);
const commitMock = vi.mocked(commitDeliveryClient);
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
    body: 'recap body text',
    ...overrides,
  };
}

function recapClaim(events: DeliveryEventSummary[]): DeliveryClaim {
  return {
    sessionId: 'session-1',
    mode: 'delivery',
    urgency: 'high',
    lifecycle: 'post-compact',
    message: `${String(events.length)} monitor(s) fired`,
    unreadCounts: {
      low: 0,
      normal: 0,
      high: events.length,
      total: events.length,
    },
    events,
  };
}

beforeEach(() => {
  reserveMock.mockReset();
  commitMock.mockReset();
  releaseMock.mockReset();
});

describe("session start's post-compact recap: reserve -> render -> write -> commit (issue #442, round-16 review)", () => {
  it('the exact flow session.ts calls (post-compact, no --socket sizing preview) reserves and renders BEFORE ever committing', async () => {
    const event = makeEvent();
    reserveMock.mockResolvedValueOnce({
      reservationId: 'recap-r-1',
      claim: recapClaim([event]),
    });

    const flow = await reserveRenderAndCommitHookDelivery(
      'session-1',
      'post-compact',
      '/sock',
      'SessionStart',
    );

    expect(flow).not.toBeNull();
    expect(flow?.output?.hookSpecificOutput.additionalContext).toContain(
      'recap body text',
    );
    expect(flow?.output?.hookSpecificOutput.hookEventName).toBe('SessionStart');
    // Rendering happened without ever calling commit.
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('a write failure against a REAL closed-fd Writable releases the reservation instead of committing — nothing durably claimed', async () => {
    const event = makeEvent();
    reserveMock.mockResolvedValueOnce({
      reservationId: 'recap-r-2',
      claim: recapClaim([event]),
    });
    releaseMock.mockResolvedValueOnce(undefined);

    const flow = await reserveRenderAndCommitHookDelivery(
      'session-1',
      'post-compact',
      '/sock',
      'SessionStart',
    );
    expect(flow).not.toBeNull();

    // A real fs write stream on an already-closed fd: every write to it fails
    // with EBADF — the same "real, delayed-failure Writable" shape as
    // `hook-deliver-commit-ordering.test.ts`'s round-11 regressions, not a
    // hand-rolled mock that only fires one of (callback, 'error' event).
    const dir = mkdtempSync(join(tmpdir(), 'am-session-start-recap-'));
    const fd = openSync(join(dir, 'target.txt'), 'w');
    closeSync(fd);
    const stream = createWriteStream('', { fd, autoClose: false });

    try {
      await expect(
        writeAndCommitHookDelivery(
          flow as NonNullable<typeof flow>,
          (toWrite) => writeStreamChunk(stream, JSON.stringify(toWrite)),
        ),
      ).rejects.toThrow(/EBADF/);
    } finally {
      stream.destroy();
    }

    // Never committed: the write failed, so nothing gets durably claimed.
    expect(commitMock).not.toHaveBeenCalled();
    // Released instead — the recap rows return to pending and redeliver at
    // the next context event.
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith('recap-r-2', '/sock');
  });

  it('a successful write against a real Writable commits only AFTER the write settles', async () => {
    const event = makeEvent();
    reserveMock.mockResolvedValueOnce({
      reservationId: 'recap-r-3',
      claim: recapClaim([event]),
    });

    const flow = await reserveRenderAndCommitHookDelivery(
      'session-1',
      'post-compact',
      '/sock',
      'SessionStart',
    );
    expect(flow).not.toBeNull();

    const order: string[] = [];
    const chunks: string[] = [];
    const stream = {
      write: vi.fn(
        (chunk: string, callback: (error?: Error | null) => void) => {
          chunks.push(chunk);
          order.push('write');
          callback();
          return true;
        },
      ),
      once: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.WritableStream;
    commitMock.mockImplementationOnce(async () => {
      order.push('commit');
      return recapClaim([event]);
    });

    const claim = await writeAndCommitHookDelivery(
      flow as NonNullable<typeof flow>,
      (toWrite) => writeStreamChunk(stream, JSON.stringify(toWrite)),
    );

    expect(order).toEqual(['write', 'commit']);
    expect(chunks[0]).toContain('recap body text');
    expect(claim).not.toBeNull();
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
