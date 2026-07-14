/**
 * Tests for the pure `hook deliver --debug` line-formatters (issue #334).
 *
 * @see ./commands/hook.ts (wires these into --debug's stderr output)
 * @see ../../../docs/specs/006-agent-integration.md §5 (hook-deliver transport)
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentSessionRecord,
  DeliveryClaim,
  HookDeliveryDiagnosis,
} from '@agentmonitors/core';
import {
  describeCapDeferral,
  describeClaim,
  describeDaemonUnreachable,
  describeDiagnosisFailure,
  describeHolds,
  describeInternalError,
  describeLifecycle,
  describeNoSessionId,
  describeNoSessionMatch,
  describeNoSocket,
  describeOutput,
  describePayload,
  describeSessionMatch,
  describeUnmappedLifecycle,
  describeUnreadCounts,
  describeWorkspace,
  describeWorkspaceDisabled,
} from './hook-deliver-debug.js';

const PREFIX = 'agentmonitors hook deliver --debug:';

function makeSession(
  overrides: Partial<AgentSessionRecord> = {},
): AgentSessionRecord {
  return {
    id: 's1',
    adapter: 'claude-code',
    hostSessionId: 'host-1',
    agentIdentity: 'host-1',
    role: 'lead',
    workspacePath: '/ws',
    hookStatePath: '/ws/.agentmonitors/sessions/host-1/hook-state.json',
    status: 'active',
    baselineAt: new Date('2026-01-01T00:00:00.000Z'),
    lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('hook-deliver-debug line formatters', () => {
  it('every line is prefixed for easy grepping/filtering in real hook logs', () => {
    expect(describeNoSessionId()).toMatch(new RegExp(`^${PREFIX} `));
    expect(describeNoSocket()).toMatch(new RegExp(`^${PREFIX} `));
  });

  it('describePayload echoes the resolved fields, or "(none)" when absent', () => {
    expect(
      describePayload({
        session_id: 'abc',
        hook_event_name: 'PostToolUse',
        cwd: '/ws',
      }),
    ).toBe(
      `${PREFIX} stdin payload — session_id=abc hook_event_name=PostToolUse cwd=/ws`,
    );
    expect(describePayload({})).toContain('session_id=(none)');
    expect(describePayload({})).toContain('hook_event_name=(none)');
    expect(describePayload({})).toContain('cwd=(none)');
  });

  it('describeNoSessionId names the missing-session_id branch (§5.2 step 2)', () => {
    expect(describeNoSessionId()).toContain('no session_id');
  });

  it('describeUnmappedLifecycle names the unmapped hook_event_name branch (§5.4)', () => {
    const msg = describeUnmappedLifecycle('PreToolUse');
    expect(msg).toContain('PreToolUse');
    expect(msg).toContain('does not map to a delivery lifecycle');
  });

  it('describeLifecycle distinguishes an explicit override from a derived lifecycle', () => {
    expect(describeLifecycle('turn-idle', true, undefined)).toContain(
      '--lifecycle override',
    );
    expect(
      describeLifecycle('turn-interruptible', false, 'PostToolUse'),
    ).toContain('derived from hook_event_name "PostToolUse"');
  });

  it('describeWorkspace reports the resolved path, enabled flag, and socket', () => {
    const msg = describeWorkspace('/ws', true, '/tmp/x.sock');
    expect(msg).toContain('/ws');
    expect(msg).toContain('enabled=true');
    expect(msg).toContain('/tmp/x.sock');
    expect(describeWorkspace('/ws', false, undefined)).toContain(
      'socket=(none)',
    );
  });

  it('describeWorkspaceDisabled names the "cwd mismatch" / disabled-workspace branch (§5.2 step 4)', () => {
    const msg = describeWorkspaceDisabled('/other/ws');
    expect(msg).toContain('/other/ws');
    expect(msg).toContain('is not enabled');
    expect(msg).toContain('agentmonitors.local.md');
  });

  it('describeDaemonUnreachable names the socket path that failed to answer', () => {
    expect(describeDaemonUnreachable('/tmp/x.sock')).toContain('/tmp/x.sock');
  });

  it('describeNoSessionMatch reports the unresolved host session id and known-session count (unknown session_id branch)', () => {
    const msg = describeNoSessionMatch('unknown-host', [
      makeSession(),
      makeSession({ id: 's2', hostSessionId: 'host-2' }),
    ]);
    expect(msg).toContain('unknown-host');
    expect(msg).toContain('2 session(s)');
  });

  it('describeSessionMatch reports the resolved AgentMon session id and workspace', () => {
    const msg = describeSessionMatch(makeSession({ id: 's42' }));
    expect(msg).toContain('s42');
    expect(msg).toContain('/ws');
    expect(msg).toContain('active');
  });

  it('describeUnreadCounts reports pending-event counts by urgency (criterion 1)', () => {
    const diagnosis: HookDeliveryDiagnosis = {
      sessionId: 's1',
      lifecycle: 'turn-interruptible',
      unreadCounts: { low: 1, normal: 2, high: 3, total: 6 },
      holds: [],
    };
    const msg = describeUnreadCounts(diagnosis);
    expect(msg).toContain('high=3');
    expect(msg).toContain('normal=2');
    expect(msg).toContain('low=1');
    expect(msg).toContain('total 6');
  });

  it('describeHolds reports one line per hold, or an explicit "no held events" line', () => {
    const empty: HookDeliveryDiagnosis = {
      sessionId: 's1',
      lifecycle: 'turn-idle',
      unreadCounts: { low: 0, normal: 0, high: 0, total: 0 },
      holds: [],
    };
    expect(describeHolds(empty)).toEqual([
      `${PREFIX} no held events for this lifecycle right now.`,
    ]);

    const held: HookDeliveryDiagnosis = {
      sessionId: 's1',
      lifecycle: 'turn-interruptible',
      unreadCounts: { low: 0, normal: 1, high: 1, total: 2 },
      holds: [
        {
          urgency: 'high',
          reason: 'settle-window',
          unreadCount: 1,
          pendingCount: 1,
          message: 'held msg 1',
        },
        {
          urgency: 'normal',
          reason: 'already-claimed',
          unreadCount: 1,
          pendingCount: 0,
          message: 'held msg 2',
        },
      ],
    };
    const lines = describeHolds(held);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('(high, settle-window): held msg 1');
    expect(lines[1]).toContain('(normal, already-claimed): held msg 2');
  });

  it('describeDiagnosisFailure names the underlying error message', () => {
    expect(describeDiagnosisFailure(new Error('boom'))).toContain('boom');
    expect(describeDiagnosisFailure('raw string')).toContain('raw string');
  });

  it('describeCapDeferral names the deferred-by-cap hold (issue #299 + #334)', () => {
    const msg = describeCapDeferral(5, 3);
    expect(msg).toContain('deferred-by-cap');
    expect(msg).toContain('2 of 5');
  });

  it('describeClaim summarizes a non-null claim, and names null explicitly', () => {
    const claim: DeliveryClaim = {
      sessionId: 's1',
      mode: 'delivery',
      urgency: 'high',
      lifecycle: 'turn-interruptible',
      message: 'msg',
      unreadCounts: { low: 0, normal: 0, high: 1, total: 1 },
      events: [
        {
          eventId: 'e1',
          monitorId: 'm1',
          title: 't',
          summary: 's',
          urgency: 'high',
          createdAt: '2026-01-01T00:00:00.000Z',
          body: 'b',
        },
      ],
    };
    expect(describeClaim(claim)).toContain('mode=delivery');
    expect(describeClaim(claim)).toContain('urgency=high');
    expect(describeClaim(claim)).toContain('events=1');
    expect(describeClaim(null)).toContain('claim: null');
  });

  it('describeOutput distinguishes an emitted payload from nothing to emit, and reflects the format', () => {
    const output = { hookSpecificOutput: { additionalContext: 'x' } };
    expect(describeOutput(output, 'json')).toContain('hook wire JSON');
    expect(describeOutput(output, 'text')).toContain('text');
    expect(describeOutput(null, 'json')).toContain('nothing to emit');
  });

  it('describeInternalError names the swallowed error (always-exit-0 contract)', () => {
    expect(describeInternalError(new Error('kaboom'))).toContain('kaboom');
    expect(describeInternalError(new Error('kaboom'))).toContain(
      'always exits 0',
    );
  });
});
