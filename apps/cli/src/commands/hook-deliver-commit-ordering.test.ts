/**
 * Failure-injection tests for the hook-deliver transport's render-before-commit
 * ordering (issue #442, PR #442 round-9 review).
 *
 * Before this fix, `hook deliver` called `commitDeliveryClient` — the durable
 * `first_notified_at` mutation — BEFORE any hook output was rendered or
 * written to stdout. If the daemon applied the commit but its RPC response
 * was lost, or if rendering/stdout writing failed AFTER commit, the outer
 * try/catch (the hook's always-exit-0 contract) swallowed the error and
 * emitted nothing while the rows were PERMANENTLY excluded from ordinary
 * redelivery (`pendingEventsForSession` never returns an already-claimed
 * row, §5.5). That is an at-most-once loss window.
 *
 * The fix (`reserveRenderAndCommitHookDelivery` + `writeAndCommitHookDelivery`,
 * `hook.ts`) renders off the RESERVATION's own claim first and defers commit
 * until AFTER a successful write:
 *
 * (a) a commit RPC failure AFTER output was successfully written must leave
 *     the rows pending (nothing was ever durably claimed) — the safe
 *     direction is a later DUPLICATE delivery, never a loss.
 * (b) a render/write failure BEFORE commit must release the reservation —
 *     nothing durably claimed, rows return to pending.
 *
 * @see docs/specs/006-agent-integration.md §5.2, §5.5
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

import {
  reserveRenderAndCommitHookDelivery,
  writeAndCommitHookDelivery,
  type HookDeliveryFlowResult,
} from './hook.js';
import {
  commitDeliveryClient,
  previewSettledHighDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import type { HookDeliveryOutput } from '../hook-deliver-render.js';

const previewMock = vi.mocked(previewSettledHighDeliveryClient);
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
  commitMock.mockReset();
  releaseMock.mockReset();
});

describe('writeAndCommitHookDelivery ordering (issue #442, round-9 review)', () => {
  function makeFlow(
    output: HookDeliveryOutput | null,
  ): HookDeliveryFlowResult & {
    commit: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  } {
    return {
      output,
      moreDeferred: false,
      previewCount: undefined,
      reservedClaim: claimWith([makeEvent()]),
      commit: vi.fn().mockResolvedValue(claimWith([makeEvent()])),
      release: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('(a) commits only AFTER the write succeeds — write happens strictly before commit', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const order: string[] = [];
    const write = vi.fn(() => {
      order.push('write');
    });
    flow.commit.mockImplementation(async () => {
      order.push('commit');
      return claimWith([makeEvent()]);
    });

    await writeAndCommitHookDelivery(flow, write);

    expect(order).toEqual(['write', 'commit']);
    expect(flow.release).not.toHaveBeenCalled();
  });

  it('(a) a commit RPC failure AFTER a successful write never releases — rows stay pending, output already delivered (duplicate OK)', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const write = vi.fn();
    flow.commit.mockRejectedValueOnce(new Error('daemon unreachable'));

    await expect(writeAndCommitHookDelivery(flow, write)).rejects.toThrow(
      'daemon unreachable',
    );

    // The output WAS already written before commit was attempted.
    expect(write).toHaveBeenCalledTimes(1);
    // A commit failure must NOT trigger a release: the reservation's own TTL
    // is the only recovery path here, and releasing after a successful write
    // would be wrong too (there is no "undo the write").
    expect(flow.release).not.toHaveBeenCalled();
  });

  it('(a) commit returning null (lease expired) after a successful write is a safe no-op, not an error', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const write = vi.fn();
    flow.commit.mockResolvedValueOnce(null);

    const claim = await writeAndCommitHookDelivery(flow, write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(claim).toBeNull();
    expect(flow.release).not.toHaveBeenCalled();
  });

  it('(b) a render/write failure releases the reservation instead of committing — nothing durably claimed', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const write = vi.fn(() => {
      throw new Error('EPIPE: broken stdout pipe');
    });

    await expect(writeAndCommitHookDelivery(flow, write)).rejects.toThrow(
      'EPIPE',
    );

    expect(flow.release).toHaveBeenCalledTimes(1);
    expect(flow.commit).not.toHaveBeenCalled();
  });

  it('never writes and commits unconditionally when output is null (nothing to render)', async () => {
    const flow = makeFlow(null);
    const write = vi.fn();

    const claim = await writeAndCommitHookDelivery(flow, write);

    expect(write).not.toHaveBeenCalled();
    expect(flow.commit).toHaveBeenCalledTimes(1);
    expect(claim).not.toBeNull();
  });
});

describe('reserveRenderAndCommitHookDelivery renders off the reservation, never a committed claim (issue #442, round-9 review)', () => {
  it('the commit callback is independent of rendering — output reflects reservation.claim before commit is ever called', async () => {
    const event = makeEvent({ body: 'monitored body text' });
    // Sizing preview, then the post-reservation candidate-growth revalidation
    // preview (issue #442, PR #442 round-9 review) — both see just this one
    // event, so nothing grew in the gap.
    previewMock.mockResolvedValueOnce([event]);
    previewMock.mockResolvedValueOnce([event]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-1',
      claim: claimWith([event]),
    });

    const flow = await reserveRenderAndCommitHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
      'UserPromptSubmit',
    );

    expect(flow).not.toBeNull();
    expect(flow?.output?.hookSpecificOutput.additionalContext).toContain(
      'monitored body text',
    );
    // Rendering happened WITHOUT ever calling commit.
    expect(commitMock).not.toHaveBeenCalled();

    // Now write + commit via the shared helper, in the correct order.
    commitMock.mockResolvedValueOnce(claimWith([event]));
    const write = vi.fn();
    await writeAndCommitHookDelivery(flow as NonNullable<typeof flow>, write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledWith('r-1', '/sock');
  });
});
