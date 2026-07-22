/**
 * Action-level coverage for `session start`'s Commander wiring (issue #442,
 * PR #442 round-18 review).
 *
 * Every test in `session-start-recap-ordering.test.ts` calls
 * `deliverSessionStartRecap` directly, never the `start` command's actual
 * `.action()` handler. That left a mutation-blind gap: reverting only
 * `session.ts`'s call site (the block that invokes `deliverSessionStartRecap`)
 * back to the pre-fix shape — a direct `claimDeliveryClient` call, followed by
 * rendering and a raw, un-awaited `process.stdout.write` — while leaving
 * `deliverSessionStartRecap` itself unused and in place, left every ordering
 * test in that file green.
 *
 * This file drives `runSessionStartAction` — the exact function
 * `sessionCommand`'s `start` subcommand registers via `.action(...)` verbatim
 * (see `session.ts`) — with every I/O seam it touches mocked, so a regression
 * to the old direct-claim call site fails HERE regardless of whether
 * `deliverSessionStartRecap` remains reachable from anywhere else.
 *
 * @see docs/specs/005-cli-reference.md §10.4
 * @see docs/specs/006-agent-integration.md §5.6
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';

vi.mock('../hook-payload.js', () => ({
  readHookPayload: vi.fn(),
}));
vi.mock('../local-state.js', () => ({
  readLocalState: vi.fn(),
  writeLocalState: vi.fn(),
}));
vi.mock('../daemon-ipc.js', () => ({
  daemonAvailable: vi.fn(),
  resolveSocketPath: vi.fn((socket: string) => socket),
  // Not exercised directly by any case here (every case mocks `daemonAvailable`
  // to resolve `true`, so `session.ts`'s boot-wait branch is never entered),
  // but stubbed so the mocked module still has the shape `session.ts` imports.
  waitForDaemonAvailable: vi.fn(),
}));
vi.mock('../detached-spawn.js', () => ({
  spawnDetachedDaemon: vi.fn(),
}));
vi.mock('../runtime-client.js', () => ({
  claimDeliveryClient: vi.fn(),
  closeSessionClient: vi.fn(),
  commitDeliveryClient: vi.fn(),
  diagnoseHookDeliveryClient: vi.fn(),
  listSessionsClient: vi.fn(),
  openSessionClient: vi.fn(),
  previewCoalescedReminderClient: vi.fn().mockResolvedValue(undefined),
  previewSettledHighDeliveryClient: vi.fn(),
  releaseDeliveryClient: vi.fn(),
  reserveDeliveryClient: vi.fn(),
}));

import { runSessionStartAction } from './session.js';
import { readHookPayload } from '../hook-payload.js';
import { readLocalState, writeLocalState } from '../local-state.js';
import { daemonAvailable, waitForDaemonAvailable } from '../daemon-ipc.js';
import {
  claimDeliveryClient,
  commitDeliveryClient,
  openSessionClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';

const readHookPayloadMock = vi.mocked(readHookPayload);
const readLocalStateMock = vi.mocked(readLocalState);
const writeLocalStateMock = vi.mocked(writeLocalState);
const daemonAvailableMock = vi.mocked(daemonAvailable);
const waitForDaemonAvailableMock = vi.mocked(waitForDaemonAvailable);
const openSessionClientMock = vi.mocked(openSessionClient);
const reserveMock = vi.mocked(reserveDeliveryClient);
const commitMock = vi.mocked(commitDeliveryClient);
const releaseMock = vi.mocked(releaseDeliveryClient);
const claimMock = vi.mocked(claimDeliveryClient);

const WORKSPACE = '/workspace/project';
const SOCKET = '/tmp/agentmonitors.sock';

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
  vi.clearAllMocks();
  readHookPayloadMock.mockResolvedValue({
    session_id: 'host-1',
    cwd: WORKSPACE,
  });
  readLocalStateMock.mockReturnValue({
    enabled: true,
    socket: SOCKET,
    db: '/tmp/agentmonitors.db',
  });
  daemonAvailableMock.mockResolvedValue(true);
  openSessionClientMock.mockResolvedValue({
    id: 'session-1',
    adapter: 'claude-code',
    hostSessionId: 'host-1',
    agentIdentity: 'agent-1',
    role: 'lead',
    hookStatePath: '/tmp/hook-state.json',
    status: 'active',
    baselineAt: new Date('2026-01-01T00:00:00.000Z'),
    lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
});

describe("session start's actual Commander action (issue #442, round-18 review)", () => {
  it('reserves (never direct-claims), awaits the write, and commits only after the write settles', async () => {
    const event = makeEvent();
    reserveMock.mockResolvedValueOnce({
      reservationId: 'recap-r-1',
      claim: recapClaim([event]),
    });
    const order: string[] = [];
    const written: string[] = [];
    commitMock.mockImplementationOnce(async () => {
      order.push('commit');
      return recapClaim([event]);
    });
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(
        (
          chunk: string | Uint8Array,
          callback?: (error?: Error | null) => void,
        ) => {
          order.push('write');
          written.push(String(chunk));
          callback?.();
          return true;
        },
      );

    try {
      await runSessionStartAction();
    } finally {
      writeSpy.mockRestore();
    }

    expect(reserveMock).toHaveBeenCalledWith(
      'session-1',
      'post-compact',
      SOCKET,
      undefined,
    );
    expect(written[0]).toContain('recap body text');
    // Write happened strictly before commit.
    expect(order).toEqual(['write', 'commit']);
    // The reservation flows through reserve/commit only — never a direct
    // claim (the pre-fix shape this test guards against regressing to).
    expect(claimMock).not.toHaveBeenCalled();
    expect(writeLocalStateMock).toHaveBeenCalled();
  });

  it('a write failure releases the reservation instead of committing, sets exit code 1 (direct-CLI failure contract, 005 §10.4), and leaks no stdout error listener', async () => {
    const event = makeEvent();
    reserveMock.mockResolvedValueOnce({
      reservationId: 'recap-r-2',
      claim: recapClaim([event]),
    });
    releaseMock.mockResolvedValueOnce(undefined);
    // `writeStreamChunk` (hook.ts) deliberately leaves its `'error'` listener
    // armed after the write callback settles with an error — it must stay
    // attached to swallow the PAIRED `'error'` event a real `Writable` emits
    // on a later tick for the SAME failure (see `writeStreamChunk`'s doc
    // comment). A mock that only fires the callback, never the paired event,
    // never exercises that consumption path and leaks the listener onto the
    // real `process.stdout` across tests. Emit that paired event (on
    // `process.nextTick`, mirroring the real timing) so the seam is driven
    // exactly as production code expects.
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(
        (
          _chunk: string | Uint8Array,
          callback?: (error?: Error | null) => void,
        ) => {
          const error = new Error('simulated EPIPE');
          callback?.(error);
          process.nextTick(() => {
            process.stdout.emit('error', error);
          });
          return true;
        },
      );
    const listenerCountBefore = process.stdout.listenerCount('error');
    const exitCodeBefore = process.exitCode;

    try {
      // `start`'s always-exit-0 HOOK contract (via the plugin wrapper's
      // `|| true`) means the process never actually dies nonzero in that
      // context — but the direct CLI call itself still fails per 005 §10.4:
      // only the plugin wrapper makes hooks best-effort, not `reportError`
      // itself. So the action's own try/catch swallows the write failure
      // (reported via `reportError`) rather than rejecting, but
      // `process.exitCode` must still read 1 afterward.
      await runSessionStartAction();
      // Let the paired 'error' event (scheduled via `process.nextTick` above)
      // fire and be swallowed before asserting the listener is gone.
      await new Promise((resolve) => process.nextTick(resolve));

      expect(process.exitCode).toBe(1);
      expect(process.stdout.listenerCount('error')).toBe(listenerCountBefore);
    } finally {
      writeSpy.mockRestore();
      process.exitCode = exitCodeBefore;
    }

    expect(commitMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith('recap-r-2', SOCKET);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('a fresh session with nothing pending reserves nothing and writes nothing', async () => {
    reserveMock.mockResolvedValueOnce(null);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await runSessionStartAction();
    } finally {
      writeSpy.mockRestore();
    }

    expect(writeSpy).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  // Issue #389 review finding 6: a lazy boot that times out must record
  // `lastBootFailureAt` (WITHOUT persisting `socket`/`db`) so a later `hook
  // deliver` in this same, still-unbooted workspace can tell "the automated
  // boot just failed, and will retry" from "no session has ever started
  // here" — see `describeBootFailedNoSocketWarning` (`hook-deliver-warnings.ts`).
  it('records lastBootFailureAt (without socket/db) when the lazy boot times out', async () => {
    readLocalStateMock.mockReturnValue({ enabled: true });
    daemonAvailableMock.mockResolvedValue(false);
    waitForDaemonAvailableMock.mockResolvedValue(false);
    const exitCodeBefore = process.exitCode;

    try {
      await runSessionStartAction();
    } finally {
      process.exitCode = exitCodeBefore;
    }

    expect(writeLocalStateMock).toHaveBeenCalledTimes(1);
    const written = writeLocalStateMock.mock.calls[0]?.[1];
    expect(written?.lastBootFailureAt).toEqual(expect.any(String));
    expect(written?.socket).toBeUndefined();
    expect(written?.db).toBeUndefined();
    // The client that would have opened the session never runs — the boot
    // never came up.
    expect(openSessionClientMock).not.toHaveBeenCalled();
  });
});
