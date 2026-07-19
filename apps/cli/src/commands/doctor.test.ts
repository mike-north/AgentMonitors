import type {
  AgentSessionRecord,
  MonitorDoctorReport,
} from '@agentmonitors/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnoseHookDeliveryClient } from '../runtime-client.js';
import { gatherDeliveryDiagnoses } from './doctor.js';

/**
 * `gatherDeliveryDiagnoses` — issue #425 review, round 4.
 *
 * Regression: a thrown `hook.diagnose` call (e.g. `DaemonUnsupportedRequestError`
 * from a daemon that predates it) used to be swallowed with a bare `continue`,
 * leaving the returned diagnosis list indistinguishable from "checked, nothing
 * suppressed". `computeTransportHealth` then reported `deliverable: true` even
 * though the suppression check never actually ran for that session — a false
 * green. This now surfaces as `unavailableSessionIds`, which `doctor` threads
 * into `computeTransportHealth` as an explicit advisory (transport-health.test.ts
 * covers the resulting verdict).
 *
 * @see ../../../docs/specs/006-agent-integration.md §12 (transport health)
 */

vi.mock('../runtime-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime-client.js')>();
  return {
    ...actual,
    diagnoseHookDeliveryClient: vi.fn(),
  };
});

const mockedDiagnose = vi.mocked(diagnoseHookDeliveryClient);

afterEach(() => {
  mockedDiagnose.mockReset();
});

function leadSession(id: string): AgentSessionRecord {
  return {
    id,
    adapter: 'claude-code',
    hostSessionId: `host-${id}`,
    agentIdentity: 'claude',
    role: 'lead',
    hookStatePath: `/tmp/${id}.json`,
    status: 'active',
    baselineAt: new Date('2026-07-19T11:00:00.000Z'),
    lastActiveAt: new Date('2026-07-19T11:00:00.000Z'),
    createdAt: new Date('2026-07-19T11:00:00.000Z'),
    updatedAt: new Date('2026-07-19T11:00:00.000Z'),
  };
}

function report(sessions: AgentSessionRecord[]): MonitorDoctorReport {
  return {
    generatedAt: new Date('2026-07-19T12:00:00.000Z'),
    monitorsDir: '/workspace/.claude/monitors',
    workspacePath: '/workspace',
    monitorsDirExists: true,
    monitors: [],
    invalidCount: 0,
    duplicateIds: [],
    parseErrors: [],
    leadSessions: sessions,
    hasLeadSession: sessions.length > 0,
  };
}

const SOCKET = '/tmp/agentmonitors-doctor-test.sock';

describe('gatherDeliveryDiagnoses', () => {
  it('collects a diagnosis for every lead session at both lifecycles', async () => {
    mockedDiagnose.mockImplementation((sessionId, lifecycle) =>
      Promise.resolve({
        sessionId,
        lifecycle,
        unreadCounts: { low: 0, normal: 0, high: 0, total: 0 },
        holds: [],
      }),
    );

    const result = await gatherDeliveryDiagnoses(
      report([leadSession('session-a')]),
      SOCKET,
    );

    expect(result.diagnoses).toHaveLength(2);
    expect(result.unavailableSessionIds).toEqual([]);
  });

  it('records the session id as unavailable when a lifecycle diagnosis throws, instead of silently dropping it', async () => {
    mockedDiagnose.mockImplementation((sessionId, lifecycle) => {
      if (lifecycle === 'turn-idle') {
        return Promise.reject(
          new Error('daemon does not support hook.diagnose'),
        );
      }
      return Promise.resolve({
        sessionId,
        lifecycle,
        unreadCounts: { low: 0, normal: 0, high: 0, total: 0 },
        holds: [],
      });
    });

    const result = await gatherDeliveryDiagnoses(
      report([leadSession('session-a')]),
      SOCKET,
    );

    // The successful lifecycle's diagnosis is still collected...
    expect(result.diagnoses).toHaveLength(1);
    expect(result.diagnoses[0]?.lifecycle).toBe('turn-interruptible');
    // ...but the session is flagged, not silently treated as "no suppression".
    expect(result.unavailableSessionIds).toEqual(['session-a']);
  });

  it('lists each affected session exactly once even if both lifecycles fail', async () => {
    mockedDiagnose.mockRejectedValue(
      new Error('daemon unreachable mid-report'),
    );

    const result = await gatherDeliveryDiagnoses(
      report([leadSession('session-a')]),
      SOCKET,
    );

    expect(result.diagnoses).toEqual([]);
    expect(result.unavailableSessionIds).toEqual(['session-a']);
  });

  it('returns no unavailable sessions when there are no lead sessions', async () => {
    const result = await gatherDeliveryDiagnoses(report([]), SOCKET);
    expect(result.diagnoses).toEqual([]);
    expect(result.unavailableSessionIds).toEqual([]);
  });
});
