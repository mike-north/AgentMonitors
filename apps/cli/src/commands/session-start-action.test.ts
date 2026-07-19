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
  previewSettledHighDeliveryClient: vi.fn(),
  releaseDeliveryClient: vi.fn(),
  reserveDeliveryClient: vi.fn(),
}));

import { runSessionStartAction } from './session.js';
import { readHookPayload } from '../hook-payload.js';
import { readLocalState, writeLocalState } from '../local-state.js';
import { daemonAvailable } from '../daemon-ipc.js';
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

  it('a write failure releases the reservation instead of committing — nothing durably claimed', async () => {
    const event = makeEvent();
    reserveMock.mockResolvedValueOnce({
      reservationId: 'recap-r-2',
      claim: recapClaim([event]),
    });
    releaseMock.mockResolvedValueOnce(undefined);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(
        (
          _chunk: string | Uint8Array,
          callback?: (error?: Error | null) => void,
        ) => {
          callback?.(new Error('simulated EPIPE'));
          return true;
        },
      );

    try {
      // `start`'s always-exit-0 hook contract means the action's own
      // try/catch swallows the write failure (reported via `reportError`)
      // rather than rejecting — assert on the durable side effects instead.
      await runSessionStartAction();
    } finally {
      writeSpy.mockRestore();
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
});
