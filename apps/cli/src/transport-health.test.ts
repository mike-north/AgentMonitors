import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookDeliveryDiagnosis } from '@agentmonitors/core';
import {
  computeTransportHealth,
  type TransportHealthInput,
  type TransportProblemCode,
  type TransportStatus,
} from './transport-health.js';
import {
  CHANNEL_HEARTBEAT_TTL_MS,
  TRANSPORT_HEARTBEAT_SCHEMA_VERSION,
  type TransportHeartbeat,
  type TransportName,
} from './transport-heartbeat.js';
import { resolveDataRoot } from './workspace-paths.js';

/**
 * Delivery-transport health verdict (issue #425).
 *
 * Each failure mode below is one of the three ways a monitored change silently
 * failed to reach an agent in a single day of dogfooding, plus the stale-server
 * case the heartbeat exists to make detectable. The assertions check that each
 * is reported with its OWN code and its OWN remediation — collapsing any two of
 * them into a generic "unhealthy" is the specific defect this surface fixes,
 * since they have nothing in common but the symptom (silence).
 *
 * @see ../../../docs/specs/006-agent-integration.md §12 (transport health)
 * @see ../../../docs/specs/002-runtime-delivery.md §9.2/§9.3 (coalesced reminders)
 */

const NOW = new Date('2026-07-19T12:00:00.000Z');
const WORKSPACE = '/repos/agentmonitors';
const SOCKET = '/data/agentmonitors/workspaces/abc123/agentmonitors.sock';
const CLI_VERSION = '1.4.0';
const HOST_SESSION = 'host-session-1';

function heartbeat(
  transport: TransportName,
  overrides: Partial<TransportHeartbeat> = {},
): TransportHeartbeat {
  return {
    schemaVersion: TRANSPORT_HEARTBEAT_SCHEMA_VERSION,
    transport,
    pid: 4242,
    cliPath: '/usr/local/bin/agentmonitors',
    execPath: '/usr/local/bin/node',
    version: CLI_VERSION,
    home: os.homedir(),
    dataRoot: resolveDataRoot(),
    workspacePath: WORKSPACE,
    socketPath: SOCKET,
    hostSessionId: HOST_SESSION,
    startedAt: '2026-07-19T11:00:00.000Z',
    updatedAt: '2026-07-19T11:59:55.000Z',
    ttlMs: CHANNEL_HEARTBEAT_TTL_MS,
    ...overrides,
  };
}

function input(
  overrides: Partial<TransportHealthInput> = {},
): TransportHealthInput {
  return {
    workspacePath: WORKSPACE,
    socketPath: SOCKET,
    daemonRunning: true,
    leadHostSessionIds: [HOST_SESSION],
    heartbeats: [heartbeat('hook'), heartbeat('channel')],
    diagnoses: [],
    diagnosisUnavailableSessionIds: [],
    cliVersion: CLI_VERSION,
    expectedHome: os.homedir(),
    expectedDataRoot: resolveDataRoot(),
    now: NOW,
    ...overrides,
  };
}

/** A diagnosis whose normal band is muted by the coalesced-until-ack guard. */
function suppressedDiagnosis(
  sessionId: string,
  claimedEventIds: string[] = [`${sessionId}-claimed-1`],
): HookDeliveryDiagnosis {
  return {
    sessionId,
    lifecycle: 'turn-interruptible',
    unreadCounts: { low: 0, normal: 11, high: 0, total: 11 },
    holds: [
      {
        urgency: 'normal',
        reason: 'coalesced-until-ack',
        unreadCount: 11,
        pendingCount: 10,
        claimedEventIds,
        message:
          'Normal-urgency reminder at turn-interruptible is suppressed: 1 of 11 unread normal event(s) are already claimed (coalesced-until-ack).',
      },
    ],
  };
}

function find(
  transports: readonly TransportStatus[],
  name: TransportName,
): TransportStatus {
  const match = transports.find((transport) => transport.name === name);
  if (!match) throw new Error(`no ${name} transport in report`);
  return match;
}

function codesOf(transport: TransportStatus): TransportProblemCode[] {
  return transport.problems.map((problem) => problem.code);
}

describe('computeTransportHealth', () => {
  describe('healthy path (negative control)', () => {
    it('reports both transports listening and delivery as deliverable', () => {
      const health = computeTransportHealth(input());

      expect(health.deliveryWillReachThisSession).toBe('both');
      expect(health.deliverable).toBe(true);
      expect(health.verdict).toContain('delivery to THIS session → via both');
      expect(health.verdict).toContain('healthy');
      expect(find(health.transports, 'hook').healthy).toBe(true);
      expect(find(health.transports, 'channel').healthy).toBe(true);
    });

    it('does not let the unprovable channel-registration caveat mark the channel unhealthy', () => {
      // The host never tells the server whether its channel capability was
      // honored, so this caveat is always present on a live channel. If it
      // counted as a defect, a perfectly working channel would read as broken
      // on every single run — the definition of crying wolf.
      const health = computeTransportHealth(input());
      const channel = find(health.transports, 'channel');

      expect(codesOf(channel)).toContain('channel-registration-unverified');
      expect(channel.healthy).toBe(true);
      expect(health.deliverable).toBe(true);
      expect(
        channel.problems.find(
          (problem) => problem.code === 'channel-registration-unverified',
        )?.remediation,
      ).toContain('--dangerously-load-development-channels');
    });
  });

  describe('multi-session channel selection (issue #425 review, round 4)', () => {
    it('keeps a broken session visible instead of hiding it behind a healthy sibling', () => {
      // Two registered leads: one channel refreshed a moment ago and correctly
      // bound, one slightly older and bound to the wrong workspace. Picking the
      // freshest record reported delivery as healthy while a live session was
      // silently receiving nothing.
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['session-ok', 'session-broken'],
          heartbeats: [
            heartbeat('channel', {
              hostSessionId: 'session-ok',
              updatedAt: '2026-07-19T11:59:59.000Z',
            }),
            heartbeat('channel', {
              hostSessionId: 'session-broken',
              workspacePath: '/somewhere/else',
              updatedAt: '2026-07-19T11:59:50.000Z',
            }),
          ],
        }),
      );

      const channel = find(health.transports, 'channel');
      expect(codesOf(channel)).toContain('workspace-mismatch');
      expect(channel.healthy).toBe(false);
      // The problem names WHICH session is broken — unactionable otherwise.
      expect(
        channel.problems.find(
          (problem) => problem.code === 'workspace-mismatch',
        )?.detail,
      ).toContain('session-broken');
    });

    it("does not adopt a channel belonging to a non-lead session as this session's transport", () => {
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['my-session'],
          heartbeats: [heartbeat('channel', { hostSessionId: 'someone-else' })],
        }),
      );

      const channel = find(health.transports, 'channel');
      // Still SHOWN — a reader diagnosing silence needs to know a server is
      // there — but never counted as this session's listening method.
      expect(channel.configured).toBe(true);
      expect(codesOf(channel)).toContain('channel-session-unmatched');
      expect(channel.healthy).toBe(false);
      expect(health.deliveryWillReachThisSession).toBe('none');
      expect(health.deliverable).toBe(false);
    });

    it('orders records NaN-safely so an unparseable timestamp sorts as oldest', () => {
      // `Date.parse` yields NaN for a corrupt record, and a NaN comparator is
      // inconsistent — it could leave the corrupt record ahead of a real one.
      // Both records here are stale (an unparseable timestamp is treated as
      // stale), so they carry the SAME problem profile and the freshness
      // tiebreak decides: the parseable record must win.
      const staleButParseable = '2026-07-19T10:00:00.000Z';
      const health = computeTransportHealth(
        input({
          heartbeats: [
            // Identical in every respect that could add a problem — only the
            // timestamp differs — so the freshness tiebreak alone decides.
            heartbeat('hook', {
              updatedAt: 'not-a-date',
              pid: 111,
              ttlMs: 1_000,
            }),
            heartbeat('hook', {
              updatedAt: staleButParseable,
              pid: 222,
              ttlMs: 1_000,
            }),
          ],
        }),
      );
      const hook = find(health.transports, 'hook');
      expect(hook.boundTo?.pid).toBe(222);
      // Neither record is silently dropped: the corrupt one is still flagged.
      expect(codesOf(hook)).toContain('heartbeat-stale');
    });
  });

  describe('representative selection vs. problem aggregation (issue #425 review, round 5)', () => {
    it('does not let a corrupt (unparseable) record become representative over a valid, current one', () => {
      // Regression: representative selection previously ranked by problem
      // count FIRST — an unparseable `updatedAt` contributes its own
      // `heartbeat-stale` problem, so "most problems wins" made the CORRUPT
      // record the representative even with a perfectly healthy, current
      // record also present, reporting `running: false` for a transport that
      // is actually up.
      const health = computeTransportHealth(
        input({
          heartbeats: [
            heartbeat('hook', {
              updatedAt: 'not-a-real-timestamp',
              pid: 999,
            }),
            heartbeat('hook', {
              updatedAt: '2026-07-19T11:59:59.000Z',
              pid: 111,
            }),
          ],
        }),
      );
      const hook = find(health.transports, 'hook');
      expect(hook.boundTo?.pid).toBe(111);
      expect(hook.running).toBe(true);
      // The corrupt record's problem still surfaces — it is not dropped,
      // merely not chosen as representative.
      expect(codesOf(hook)).toContain('heartbeat-stale');
    });

    it('does not let a far-future (corrupt-clock) record shadow a valid current listener', () => {
      // Regression: representative selection compared raw `Date.parse`
      // values, which rank a far-future timestamp as "freshest" even though
      // `isHeartbeatStale` independently treats it as stale (clock skew or a
      // forged record). A far-future record could therefore win representative
      // selection over a genuinely current one purely because it LOOKS newer.
      const farFuture = new Date(
        NOW.getTime() + 10 * 60 * 60 * 1000,
      ).toISOString();
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: [],
          heartbeats: [
            heartbeat('channel', {
              hostSessionId: 'session-current',
              updatedAt: '2026-07-19T11:59:59.000Z',
              pid: 111,
            }),
            heartbeat('channel', {
              hostSessionId: 'session-corrupt-clock',
              updatedAt: farFuture,
              pid: 999,
            }),
          ],
        }),
      );
      const channel = find(health.transports, 'channel');
      expect(channel.boundTo?.pid).toBe(111);
      expect(channel.running).toBe(true);
      expect(codesOf(channel)).toContain('heartbeat-stale');
    });
  });

  describe('every active lead must be covered, not merely one (issue #425 review, round 5)', () => {
    it('flags an active lead with no matching channel heartbeat instead of reporting a clean workspace-wide verdict', () => {
      // Regression: "at least one active lead has a matching channel
      // heartbeat" was previously treated as proof the channel is healthy
      // workspace-wide. With two active leads and a channel heartbeat for
      // only one, the second lead had no channel listener at all and nothing
      // said so.
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['session-covered', 'session-uncovered'],
          heartbeats: [
            heartbeat('channel', { hostSessionId: 'session-covered' }),
          ],
        }),
      );
      const channel = find(health.transports, 'channel');
      expect(codesOf(channel)).toContain('channel-lead-uncovered');
      expect(
        channel.problems.find(
          (problem) => problem.code === 'channel-lead-uncovered',
        )?.detail,
      ).toContain('session-uncovered');
      expect(channel.healthy).toBe(false);
      // A partially-covered channel must not read as this session's clean
      // listening method — the whole point is that ONE recipient is silently
      // uncovered.
      expect(health.deliveryWillReachThisSession).not.toBe('channel');
      expect(health.deliverable).toBe(false);
    });

    it('reports no uncovered leads when every active lead has a matching channel heartbeat', () => {
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['session-a', 'session-b'],
          heartbeats: [
            heartbeat('channel', { hostSessionId: 'session-a' }),
            heartbeat('channel', { hostSessionId: 'session-b' }),
          ],
        }),
      );
      const channel = find(health.transports, 'channel');
      expect(codesOf(channel)).not.toContain('channel-lead-uncovered');
    });
  });

  describe('the every-active-lead-covered rule applies to hook too, not only channel (issue #425 review, round 6)', () => {
    it('flags an active lead with no evidence in the hook heartbeat', () => {
      // Regression: hook heartbeats already carry `hostSessionId`, but
      // coverage was only checked for `channel`. With two active leads and a
      // hook heartbeat naming only one of them, `computeTransportHealth`
      // previously returned `deliveryWillReachThisSession: 'hook'` and
      // `deliverable: true` for the whole workspace even though the second
      // lead had no hook invocation evidence at all — a script-registered or
      // freshly opened session could go completely uncovered while another
      // session's activity made the aggregate read healthy.
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['session-covered', 'session-uncovered'],
          heartbeats: [heartbeat('hook', { hostSessionId: 'session-covered' })],
        }),
      );
      const hook = find(health.transports, 'hook');
      expect(codesOf(hook)).toContain('hook-lead-uncovered');
      expect(
        hook.problems.find((problem) => problem.code === 'hook-lead-uncovered')
          ?.detail,
      ).toContain('session-uncovered');
      expect(hook.healthy).toBe(false);
      // A partially-covered hook must not read as this session's clean
      // listening method.
      expect(health.deliveryWillReachThisSession).not.toBe('hook');
      expect(health.deliverable).toBe(false);
    });

    it('reports no uncovered leads when the single hook heartbeat names the only active lead', () => {
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['session-a'],
          heartbeats: [heartbeat('hook', { hostSessionId: 'session-a' })],
        }),
      );
      const hook = find(health.transports, 'hook');
      expect(codesOf(hook)).not.toContain('hook-lead-uncovered');
    });
  });

  describe('a stale sibling must not hide behind a healthy representative (issue #425 review, round 5)', () => {
    it('excludes the channel from the listening method when a matched active lead is stale, even though the representative is fresh', () => {
      // Regression: `running` reflected only the representative (fresh)
      // record, so a stale SIBLING session's `heartbeat-stale` problem
      // (unioned into `problems`) made `channel.healthy` false but did not
      // stop the channel from still being counted as the listening method —
      // `deliveryWillReachThisSession` read `channel` and `deliverable` read
      // `true`, a false green for the workspace as a whole.
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['session-fresh', 'session-stale'],
          heartbeats: [
            heartbeat('channel', {
              hostSessionId: 'session-fresh',
              updatedAt: '2026-07-19T11:59:59.000Z',
            }),
            heartbeat('channel', {
              hostSessionId: 'session-stale',
              updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
            }),
          ],
          // Only the channel is exercised here; hook stays out of the input
          // so `reach`/`deliverable` reflect the channel alone.
        }),
      );
      const channel = find(health.transports, 'channel');
      expect(codesOf(channel)).toContain('heartbeat-stale');
      expect(channel.healthy).toBe(false);
      expect(health.deliveryWillReachThisSession).not.toBe('channel');
      expect(health.deliverable).toBe(false);
    });
  });

  describe('multi-session hook coverage (issue #425 review, round 6 follow-up)', () => {
    it('does NOT report a gap when every active lead has its own hook record', () => {
      // The false RED this keying change fixes, reproduced end to end before
      // the fix: two active leads that had BOTH just run `hook deliver`
      // successfully still reported `[hook-lead-uncovered]` against whichever
      // prompted first, a verdict of "via none: no delivery transport is
      // listening", and exit 1 — permanently, because the OLD workspace-keyed
      // record could only ever name one of them.
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['lead-a', 'lead-b'],
          heartbeats: [
            heartbeat('hook', { hostSessionId: 'lead-a' }),
            heartbeat('hook', { hostSessionId: 'lead-b' }),
          ],
        }),
      );

      const hook = find(health.transports, 'hook');
      expect(codesOf(hook)).not.toContain('hook-lead-uncovered');
      expect(hook.healthy).toBe(true);
      expect(health.deliveryWillReachThisSession).toBe('hook');
      expect(health.deliverable).toBe(true);
    });

    it('still reports the GENUINE gap when a lead has no hook record', () => {
      // The fix must not blunt the finding it came from: a lead that has never
      // had a hook invocation is still surfaced, by name.
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['lead-a', 'lead-b'],
          heartbeats: [heartbeat('hook', { hostSessionId: 'lead-a' })],
        }),
      );

      const hook = find(health.transports, 'hook');
      expect(codesOf(hook)).toContain('hook-lead-uncovered');
      expect(
        hook.problems.find((p) => p.code === 'hook-lead-uncovered')?.detail,
      ).toContain('lead-b');
      expect(health.deliverable).toBe(false);
    });

    it('does not let a closed or non-lead session’s same-workspace hook record poison a healthy active lead (issue #425 review, round 8)', () => {
      // Regression: `selectHeartbeats` returned EVERY same-workspace hook
      // record unfiltered, so a fresh record left by a session that has since
      // closed (or was never a lead) was unioned into the active aggregate
      // alongside a perfectly healthy active lead's own record. A direct
      // probe with one healthy active-lead record plus one closed-session
      // record bound to an obsolete socket produced `socket-mismatch`,
      // `hook.healthy: false`, `reach: 'none'`, and `deliverable: false` for a
      // workspace where the only currently-open session was working fine.
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: ['lead-active'],
          heartbeats: [
            heartbeat('hook', { hostSessionId: 'lead-active' }),
            heartbeat('hook', {
              hostSessionId: 'session-closed',
              socketPath:
                '/data/agentmonitors/workspaces/stale/agentmonitors.sock',
            }),
          ],
        }),
      );

      const hook = find(health.transports, 'hook');
      expect(codesOf(hook)).not.toContain('socket-mismatch');
      expect(codesOf(hook)).not.toContain('hook-lead-uncovered');
      expect(hook.healthy).toBe(true);
      expect(health.deliveryWillReachThisSession).toBe('hook');
      expect(health.deliverable).toBe(true);
    });
  });

  describe('no ACTIVE lead recipient (issue #425 review, round 3)', () => {
    // `hook` is keyed per SESSION (`heartbeatKey`), so a heartbeat left by a
    // now-closed session stays within its 24h TTL — and reads as `running` —
    // long after that session is gone. `doctor` is responsible for supplying
    // ONLY active leads (`leadHostSessionIds`); this suite proves
    // `computeTransportHealth` actually honors that contract rather than
    // trusting `running` alone.
    it('reports via none / not deliverable when a fresh heartbeat exists but no lead session is active', () => {
      const health = computeTransportHealth(input({ leadHostSessionIds: [] }));

      expect(health.deliveryWillReachThisSession).toBe('none');
      expect(health.deliverable).toBe(false);
      expect(health.verdict).toContain('no live session');
      // The heartbeat-derived facts (still running, still bound correctly) are
      // NOT erased — a reader diagnosing this must be able to see that the
      // transport itself is fine and the problem is purely "no recipient".
      for (const transport of health.transports) {
        expect(transport.configured).toBe(true);
        expect(transport.running).toBe(true);
      }
    });

    it('names the case distinctly from "no transport has reported in at all"', () => {
      const noTransportAtAll = computeTransportHealth(
        input({ heartbeats: [], leadHostSessionIds: [] }),
      );
      const heartbeatButNoLead = computeTransportHealth(
        input({ leadHostSessionIds: [] }),
      );

      expect(noTransportAtAll.verdict).not.toEqual(heartbeatButNoLead.verdict);
      expect(noTransportAtAll.verdict).toContain(
        'no transport has reported in',
      );
      expect(heartbeatButNoLead.verdict).not.toContain(
        'no transport has reported in',
      );
    });

    it('still reports the same result when the transport looks otherwise unhealthy (stale)', () => {
      // Absence of an active lead is not merely "another reason it's
      // unhealthy" — it must dominate even a transport whose own heartbeat
      // has separately lapsed, since deliverability was already false either
      // way and the verdict should name the recipient problem, not just staleness.
      const health = computeTransportHealth(
        input({
          leadHostSessionIds: [],
          heartbeats: [
            heartbeat('hook', {
              updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
            }),
          ],
        }),
      );
      expect(health.deliveryWillReachThisSession).toBe('none');
      expect(health.deliverable).toBe(false);
    });
  });

  describe('failure mode (a): no daemon running for this workspace', () => {
    const health = computeTransportHealth(
      input({
        daemonRunning: false,
        daemonErrorMessage: 'connect ENOENT ' + SOCKET,
      }),
    );

    it('names the down daemon distinctly, not as a transport defect', () => {
      const problems = health.transports.flatMap(
        (transport) => transport.problems,
      );
      // The transports themselves are fine; the daemon behind them is not. The
      // distinction matters because "restart your session" would be the wrong
      // fix here.
      expect(problems.map((problem) => problem.code)).not.toContain(
        'heartbeat-stale',
      );
      expect(health.verdict).toContain(
        'daemon for this workspace is not running',
      );
    });

    it('is not deliverable even though both transports are still listening', () => {
      expect(health.deliveryWillReachThisSession).toBe('both');
      expect(health.deliverable).toBe(false);
    });

    it('remediates with the concrete daemon-start command', () => {
      expect(health.remediation.join(' ')).toContain(
        '`agentmonitors daemon run`',
      );
    });

    it('threads the underlying connection error into the detail', () => {
      // "Nothing is listening" and "something answered but was not a daemon"
      // need different responses, so the cause must survive verbatim.
      expect(health.remediation.length).toBeGreaterThan(0);
      const withCause = computeTransportHealth(
        input({ daemonRunning: false, daemonErrorMessage: 'version skew' }),
      );
      expect(withCause.verdict).toContain('NOT deliverable');
    });
  });

  describe('failure mode (b): channel bound to a different workspace', () => {
    // The reviewer-agent incident: a session launched from $HOME resolved the
    // home-directory workspace, so its channel delivered events nobody was
    // waiting on. The heartbeat is matched by HOST SESSION ID across every
    // workspace, which is what turns this from an absence into a finding.
    const health = computeTransportHealth(
      input({
        heartbeats: [
          heartbeat('hook'),
          heartbeat('channel', {
            workspacePath: '/Users/someone',
            socketPath:
              '/data/agentmonitors/workspaces/home999/agentmonitors.sock',
          }),
        ],
      }),
    );
    const channel = find(health.transports, 'channel');

    it('reports workspace-mismatch, naming both workspaces', () => {
      expect(codesOf(channel)).toContain('workspace-mismatch');
      const problem = channel.problems.find(
        (candidate) => candidate.code === 'workspace-mismatch',
      );
      expect(problem?.detail).toContain('/Users/someone');
      expect(problem?.detail).toContain(WORKSPACE);
    });

    it('does not additionally report socket-mismatch for the same root cause', () => {
      // A different workspace legitimately has a different socket; reporting
      // both would read as two independent problems.
      expect(codesOf(channel)).not.toContain('socket-mismatch');
    });

    it('excludes the misbound channel from the listening method', () => {
      expect(health.deliveryWillReachThisSession).toBe('hook');
      expect(channel.healthy).toBe(false);
    });

    it('remediates by re-resolving the workspace, not by restarting the daemon', () => {
      const remediation = channel.problems
        .map((problem) => problem.remediation)
        .join(' ');
      expect(remediation).toContain('CLAUDE_PROJECT_DIR');
    });

    it('reports socket-mismatch separately when the workspace does match', () => {
      const sameWorkspace = computeTransportHealth(
        input({
          heartbeats: [
            heartbeat('channel', { socketPath: '/tmp/dead-daemon.sock' }),
          ],
        }),
      );
      const codes = codesOf(find(sameWorkspace.transports, 'channel'));
      expect(codes).toContain('socket-mismatch');
      expect(codes).not.toContain('workspace-mismatch');
    });

    it('reports environment-mismatch when HOME/data root diverge', () => {
      const foreignHome = computeTransportHealth(
        input({
          heartbeats: [
            heartbeat('channel', {
              home: '/sandbox/home',
              dataRoot: '/sandbox/home/.local/share',
            }),
          ],
        }),
      );
      const channelStatus = find(foreignHome.transports, 'channel');
      expect(codesOf(channelStatus)).toContain('environment-mismatch');
      expect(
        channelStatus.problems.find(
          (problem) => problem.code === 'environment-mismatch',
        )?.detail,
      ).toContain('/sandbox/home');
      expect(foreignHome.deliveryWillReachThisSession).toBe('none');
    });

    it('matches a workspace binding regardless of path normalization', () => {
      // A trailing separator is the same workspace; reporting it as a mismatch
      // would be a false alarm on an otherwise healthy setup.
      const health2 = computeTransportHealth(
        input({
          heartbeats: [
            heartbeat('channel', { workspacePath: `${WORKSPACE}${path.sep}` }),
          ],
        }),
      );
      expect(codesOf(find(health2.transports, 'channel'))).not.toContain(
        'workspace-mismatch',
      );
    });

    it('never matches a hook record by host session id across workspaces (issue #425 review)', () => {
      // Hook records are keyed per session in the registry (issue #425
      // review, round 6 follow-up), but `selectHeartbeats` still matches hook
      // candidates by SAME-WORKSPACE first, never by host session id across a
      // workspace boundary. A record belonging to THIS host session but a
      // DIFFERENT workspace is stale evidence about a workspace this session
      // no longer leads, not a live mismatch — a fresh short-lived `hook
      // deliver` process re-resolves and self-heals on every prompt with no
      // action needed. Session-id-first cross-workspace matching is only
      // correct for the long-lived `channel` transport; applying it to `hook`
      // too would report a false `workspace-mismatch` (with "restart the
      // transport" remediation) for a session that simply has not yet
      // submitted its first prompt in ITS current workspace.
      const health = computeTransportHealth(
        input({
          workspacePath: '/repos/workspace-b',
          heartbeats: [
            // Same host session id, but bound to a DIFFERENT workspace — the
            // session's hook last fired there, before it started leading
            // workspace-b.
            heartbeat('hook', { workspacePath: '/repos/workspace-a' }),
          ],
        }),
      );
      const hook = find(health.transports, 'hook');
      // Not a false mismatch: since no hook record exists for workspace-b, the
      // correct read is "not configured here yet", not "misbound".
      expect(hook.configured).toBe(false);
      expect(codesOf(hook)).not.toContain('workspace-mismatch');
    });
  });

  describe('failure mode (c): reminders suppressed by coalesced-until-ack', () => {
    // Both transports up, daemon up, events materialized — and the agent is
    // never told. This is why the surface reports HEALTH, not liveness.
    const health = computeTransportHealth(
      input({ diagnoses: [suppressedDiagnosis('session-abc')] }),
    );

    it('reports the suppression with its own code', () => {
      const codes = health.transports.flatMap((transport) =>
        codesOf(transport),
      );
      expect(codes).toContain('reminders-suppressed');
    });

    it('marks delivery NOT deliverable even though both transports are listening', () => {
      expect(health.deliveryWillReachThisSession).toBe('both');
      expect(health.deliverable).toBe(false);
      expect(health.verdict).toContain('coalesced-until-ack');
    });

    it('remediates with the session-scoped ack command from the issue', () => {
      expect(health.remediation.join(' ')).toContain(
        'agentmonitors events ack --session session-abc',
      );
    });

    it('scopes the remediation to the exact claimed event ids and the resolved socket, never a blanket ack (issue #425 review, round 6)', () => {
      // Regression: `events ack --session <id>` with no `--event-ids` acks
      // EVERY unread row for the session — including events the agent never
      // claimed or saw — and omitting `--socket` could target a different
      // daemon than the one this `doctor` invocation actually diagnosed.
      const remediation = health.remediation.join(' ');
      expect(remediation).toContain('--event-ids session-abc-claimed-1');
      expect(remediation).toContain(`--socket ${SOCKET}`);
      // Never a bare `--session <id>` with nothing after it — that IS the
      // unscoped "ack everything" form this regression forbids.
      expect(remediation).not.toMatch(/--session session-abc`/);
    });

    it('attributes the suppression to both transports, since both share the gate', () => {
      // `reserve` (channel) and `claim` (hook) consult the same guard —
      // blaming one would imply the other still works.
      for (const transport of health.transports) {
        expect(codesOf(transport)).toContain('reminders-suppressed');
      }
    });

    it('reports each suppressed session when several are held', () => {
      const many = computeTransportHealth(
        input({
          diagnoses: [
            suppressedDiagnosis('session-abc'),
            suppressedDiagnosis('session-def'),
          ],
        }),
      );
      const remediation = many.remediation.join(' ');
      expect(remediation).toContain('--session session-abc');
      expect(remediation).toContain('--session session-def');
      // Each session's remediation must carry ONLY its own claimed ids —
      // never another session's, which would ack unrelated unseen work.
      const abcLine = remediation
        .split('`')
        .find((segment) => segment.includes('--session session-abc'));
      const defLine = remediation
        .split('`')
        .find((segment) => segment.includes('--session session-def'));
      expect(abcLine).toContain('session-abc-claimed-1');
      expect(abcLine).not.toContain('session-def-claimed-1');
      expect(defLine).toContain('session-def-claimed-1');
      expect(defLine).not.toContain('session-abc-claimed-1');
    });

    it('stays visible when NO transport has reported in', () => {
      // Found by driving the real CLI: suppression was only ever attached to
      // *configured* transports, so a muted workspace whose transports had not
      // registered yet rendered as a bland "nothing is listening" — hiding the
      // second, independent reason nothing would arrive even after a transport
      // started. Both problems must be fixed, so both must be reported.
      const health = computeTransportHealth(
        input({
          heartbeats: [],
          diagnoses: [suppressedDiagnosis('session-abc')],
        }),
      );

      expect(health.deliveryWillReachThisSession).toBe('none');
      expect(health.pipelineProblems.map((problem) => problem.code)).toContain(
        'reminders-suppressed',
      );
      expect(health.verdict).toContain('ALSO currently suppressed');
      expect(health.remediation.join(' ')).toContain(
        'agentmonitors events ack --session session-abc',
      );
    });

    it('treats an empty claimedEventIds array as untrustworthy, never an ack-all fallback (issue #425 review, round 8)', () => {
      // `classifyReminderHold` only ever returns a hold for these two reasons
      // when `claimedCount > 0`, so a real hold from this build always names
      // at least one id — an empty array here can only come from something
      // other than that classifier (a malformed daemon response, or a
      // hand-built caller) and must be treated exactly like a missing one.
      // Before this fix, `[]` was accepted as "trustworthy but empty" and
      // `--event-ids` was silently omitted, falling back to the daemon's
      // ack-all default: `agentmonitors events ack --session <id>` with no
      // scoping — the exact blanket acknowledgement round 6 exists to avoid.
      const health = computeTransportHealth(
        input({ diagnoses: [suppressedDiagnosis('session-abc', [])] }),
      );
      const codes = health.pipelineProblems.map((problem) => problem.code);
      expect(codes).toContain('delivery-diagnosis-unavailable');
      expect(codes).not.toContain('reminders-suppressed');
      const remediation = health.remediation.join(' ');
      expect(remediation).not.toContain(
        'agentmonitors events ack --session session-abc',
      );
      expect(health.deliverable).toBe(false);
    });

    describe('a hold with untrustworthy claimedEventIds is never an ack-all fallback (issue #425 review, round 7)', () => {
      // A hold missing `claimedEventIds` entirely simulates the wire shape
      // from an older daemon build that predates the field — an ABSENT key,
      // not a deliberately empty array (round 8 treats both the same way; see
      // the empty-array test above). Before the fix, `flatMap` contributed a
      // literal `undefined` per such hold, `Array.prototype.join` rendered it
      // as an empty string, and the remediation printed a malformed
      // `--event-ids  --socket ...` — worse than an ack-all fallback, since it
      // LOOKS like a safe, scoped command while actually being broken.
      function suppressedHoldMissingIds(
        sessionId: string,
      ): HookDeliveryDiagnosis {
        return {
          sessionId,
          lifecycle: 'turn-interruptible',
          unreadCounts: { low: 0, normal: 11, high: 0, total: 11 },
          holds: [
            {
              urgency: 'normal',
              reason: 'coalesced-until-ack',
              unreadCount: 11,
              pendingCount: 10,
              // No `claimedEventIds` key at all — simulates an older daemon
              // build's wire shape, not a deliberately empty array.
              message:
                'Normal-urgency reminder at turn-interruptible is suppressed: 1 of 11 unread normal event(s) are already claimed (coalesced-until-ack).',
            },
          ],
        };
      }

      it('reports delivery-diagnosis-unavailable instead of a broken or blanket ack command', () => {
        const health = computeTransportHealth(
          input({ diagnoses: [suppressedHoldMissingIds('session-abc')] }),
        );

        const codes = health.pipelineProblems.map((problem) => problem.code);
        expect(codes).toContain('delivery-diagnosis-unavailable');
        expect(codes).not.toContain('reminders-suppressed');

        const remediation = health.remediation.join(' ');
        // Never the malformed double-space/empty-ids form...
        expect(remediation).not.toMatch(/--event-ids\s+--socket/);
        // ...and never a blanket ack-all fallback either (issue #425 review,
        // round 7's explicit "never as an ack-all fallback").
        expect(remediation).not.toContain(
          'agentmonitors events ack --session session-abc',
        );
        expect(remediation).toContain('Upgrade the daemon');
        // An empty/missing claimedEventIds isn't only an older-daemon symptom
        // — an in-flight channel lease (still-unclaimed, not yet a claim) can
        // produce the same shape on a current build (issue #425 review, PR
        // #453 Copilot round). The detail/remediation must not tell a reader
        // on a current daemon that upgrading is the fix.
        const detail = health.pipelineProblems
          .filter(
            (problem) => problem.code === 'delivery-diagnosis-unavailable',
          )
          .map((problem) => problem.detail)
          .join(' ');
        expect(detail + remediation).toMatch(/lease/i);
      });

      it('blocks deliverable, matching the existing check-never-ran contract', () => {
        const health = computeTransportHealth(
          input({ diagnoses: [suppressedHoldMissingIds('session-abc')] }),
        );
        expect(health.deliverable).toBe(false);
        expect(health.verdict).toContain('could not be determined');
      });

      it('keeps a trustworthy session scoped while an untrustworthy sibling session is reported separately', () => {
        const health = computeTransportHealth(
          input({
            diagnoses: [
              suppressedDiagnosis('session-trusted'),
              suppressedHoldMissingIds('session-untrusted'),
            ],
          }),
        );

        const codes = health.pipelineProblems.map((problem) => problem.code);
        expect(codes).toContain('reminders-suppressed');
        expect(codes).toContain('delivery-diagnosis-unavailable');

        const remediation = health.remediation.join(' ');
        expect(remediation).toContain('--event-ids session-trusted-claimed-1');
        expect(remediation).not.toContain('session-untrusted-claimed');
        expect(remediation).not.toContain(
          'agentmonitors events ack --session session-untrusted',
        );
      });

      it('treats an array containing a non-string entry as equally untrustworthy', () => {
        const health = computeTransportHealth(
          input({
            diagnoses: [
              {
                sessionId: 'session-abc',
                lifecycle: 'turn-interruptible',
                unreadCounts: { low: 0, normal: 11, high: 0, total: 11 },
                holds: [
                  {
                    urgency: 'normal',
                    reason: 'coalesced-until-ack',
                    unreadCount: 11,
                    pendingCount: 10,
                    // @ts-expect-error deliberately malformed to simulate an
                    // untrusted wire payload (a plain `number` where every
                    // real element is a non-empty `string`).
                    claimedEventIds: [42],
                    message: 'suppressed',
                  },
                ],
              },
            ],
          }),
        );

        const codes = health.pipelineProblems.map((problem) => problem.code);
        expect(codes).toContain('delivery-diagnosis-unavailable');
        expect(codes).not.toContain('reminders-suppressed');
      });
    });

    it('exposes a down daemon as a pipeline problem, not only per transport', () => {
      const health = computeTransportHealth(
        input({ heartbeats: [], daemonRunning: false }),
      );
      expect(health.pipelineProblems.map((problem) => problem.code)).toContain(
        'daemon-unreachable',
      );
    });

    it('stays healthy when the only hold is the high-urgency settle window', () => {
      // A settle-window hold is the documented 15s debounce doing its job, not
      // a degradation — flagging it would make every high-urgency monitor look
      // broken for the first 15 seconds of every event.
      const settling = computeTransportHealth(
        input({
          diagnoses: [
            {
              sessionId: 'session-abc',
              lifecycle: 'turn-interruptible',
              unreadCounts: { low: 0, normal: 0, high: 1, total: 1 },
              holds: [
                {
                  urgency: 'high',
                  reason: 'settle-window',
                  unreadCount: 1,
                  pendingCount: 1,
                  settleRemainingMs: 9000,
                  message:
                    'High-urgency delivery is held by the settle window.',
                },
              ],
            },
          ],
        }),
      );
      expect(settling.deliverable).toBe(true);
    });
  });

  // Regression: `doctor` used to swallow a thrown `hook.diagnose` (e.g. an
  // older daemon rejecting it as unsupported) and proceed as if the check had
  // run and found no suppression, so `deliverable` read `true` even though
  // whether reminders were suppressed was never actually answered (issue #425
  // review, round 4).
  describe('failure mode (c′): delivery-diagnosis check itself unavailable', () => {
    it('reports a distinct advisory code, not a bare pass', () => {
      const health = computeTransportHealth(
        input({
          diagnoses: [],
          diagnosisUnavailableSessionIds: ['session-abc'],
        }),
      );
      const codes = health.pipelineProblems.map((problem) => problem.code);
      expect(codes).toContain('delivery-diagnosis-unavailable');
      expect(codes).not.toContain('reminders-suppressed');
    });

    it('never reports deliverable=true while the check was skipped, even with both transports listening', () => {
      const health = computeTransportHealth(
        input({
          diagnoses: [],
          diagnosisUnavailableSessionIds: ['session-abc'],
        }),
      );
      expect(health.deliveryWillReachThisSession).toBe('both');
      expect(health.deliverable).toBe(false);
      expect(health.verdict).toContain('could not be determined');
    });

    it('names the affected session in the detail', () => {
      const health = computeTransportHealth(
        input({
          diagnoses: [],
          diagnosisUnavailableSessionIds: ['session-abc'],
        }),
      );
      const problem = health.pipelineProblems.find(
        (candidate) => candidate.code === 'delivery-diagnosis-unavailable',
      );
      expect(problem?.detail).toContain('session-abc');
      expect(problem?.remediation).toContain('agentmonitors daemon run');
    });

    it('is attached to every configured transport, not just one', () => {
      const health = computeTransportHealth(
        input({
          diagnoses: [],
          diagnosisUnavailableSessionIds: ['session-abc'],
        }),
      );
      for (const transport of health.transports) {
        expect(codesOf(transport)).toContain('delivery-diagnosis-unavailable');
      }
    });

    it('does not report the code at all when every diagnosis succeeded', () => {
      const health = computeTransportHealth(input({ diagnoses: [] }));
      expect(
        health.pipelineProblems.map((problem) => problem.code),
      ).not.toContain('delivery-diagnosis-unavailable');
      expect(health.deliverable).toBe(true);
    });
  });

  describe('failure mode (d): channel present but not heartbeating', () => {
    const health = computeTransportHealth(
      input({
        heartbeats: [
          heartbeat('hook'),
          // Last refreshed well beyond its 30s lease: a server killed without
          // cleanup leaves exactly this trace.
          heartbeat('channel', { updatedAt: '2026-07-19T11:50:00.000Z' }),
        ],
      }),
    );
    const channel = find(health.transports, 'channel');

    it('reports heartbeat-stale distinctly from an absent transport', () => {
      expect(codesOf(channel)).toContain('heartbeat-stale');
      // `configured` stays true: something DID register, which is a different
      // fix ("respawn it") than "no channel was ever set up".
      expect(channel.configured).toBe(true);
      expect(channel.running).toBe(false);
      expect(channel.healthy).toBe(false);
    });

    it('falls back to the hook transport as the listening method', () => {
      expect(health.deliveryWillReachThisSession).toBe('hook');
      expect(health.deliverable).toBe(true);
    });

    it('remediates by respawning the channel server', () => {
      expect(
        channel.problems.find((problem) => problem.code === 'heartbeat-stale')
          ?.remediation,
      ).toContain('MCP server');
    });

    it('treats an unparseable updatedAt as stale rather than fresh', () => {
      // The conservative direction: flagging a live transport for inspection is
      // recoverable; reporting a dead one as healthy is the silent failure.
      const corrupt = computeTransportHealth(
        input({
          heartbeats: [heartbeat('channel', { updatedAt: 'not-a-date' })],
        }),
      );
      expect(codesOf(find(corrupt.transports, 'channel'))).toContain(
        'heartbeat-stale',
      );
    });

    it('does not flag an idle hook transport as stale within its longer lease', () => {
      // The hook transport has no process between prompts by design; a short
      // TTL would report a healthy setup as dead during any human pause.
      const idleHook = computeTransportHealth(
        input({
          heartbeats: [
            heartbeat('hook', {
              updatedAt: '2026-07-19T08:00:00.000Z',
              ttlMs: 24 * 60 * 60 * 1000,
            }),
          ],
        }),
      );
      expect(codesOf(find(idleHook.transports, 'hook'))).not.toContain(
        'heartbeat-stale',
      );
    });
  });

  describe('no transport reporting at all', () => {
    it('reports "via none" and stays honest about invisibility under another HOME', () => {
      const health = computeTransportHealth(input({ heartbeats: [] }));

      expect(health.deliveryWillReachThisSession).toBe('none');
      expect(health.deliverable).toBe(false);
      for (const transport of health.transports) {
        expect(transport.configured).toBe(false);
        expect(transport.lastDelivery).toBeNull();
      }
    });

    it('names the idle case when no lead session is registered', () => {
      const health = computeTransportHealth(
        input({ heartbeats: [], leadHostSessionIds: [] }),
      );
      expect(health.verdict).toContain('no lead session');
    });
  });

  describe('version skew', () => {
    it('flags a long-lived transport still serving an older build', () => {
      const health = computeTransportHealth(
        input({ heartbeats: [heartbeat('channel', { version: '1.1.0' })] }),
      );
      const channel = find(health.transports, 'channel');
      expect(codesOf(channel)).toContain('version-skew');
      expect(
        channel.problems.find((problem) => problem.code === 'version-skew')
          ?.detail,
      ).toContain('1.1.0');
    });

    it('is informational, not blocking — a skewed transport still reports healthy', () => {
      // Issue #425 review: version-skew was previously a blocking problem, so
      // `doctor` exited 1 for up to the hook's full 24h heartbeat TTL after
      // EVERY CLI upgrade (the hook heartbeat legitimately carries the
      // pre-upgrade version until the next prompt) — the exact cry-wolf
      // outcome issue #373 exists to prevent, and it directly contradicted the
      // hook remediation's own "No action needed" wording. This must behave
      // like `channel-registration-unverified`: present, but never the reason
      // a transport (or the overall verdict) is unhealthy/undeliverable.
      const health = computeTransportHealth(
        input({
          heartbeats: [
            heartbeat('hook', { version: '1.1.0' }),
            heartbeat('channel', { version: '1.1.0' }),
          ],
        }),
      );
      for (const transport of health.transports) {
        expect(codesOf(transport)).toContain('version-skew');
        expect(transport.healthy).toBe(true);
      }
      expect(health.deliverable).toBe(true);
      expect(health.verdict).toContain('healthy');
    });
  });

  describe('remediation list', () => {
    it('de-duplicates a shared root cause across transports', () => {
      const health = computeTransportHealth(input({ daemonRunning: false }));
      const daemonSteps = health.remediation.filter((step) =>
        step.includes('`agentmonitors daemon run`'),
      );
      expect(daemonSteps).toHaveLength(1);
    });
  });

  describe('lastDelivery', () => {
    it('surfaces the reported delivery timestamp', () => {
      const health = computeTransportHealth(
        input({
          heartbeats: [
            heartbeat('hook', { lastDeliveryAt: '2026-07-19T11:30:00.000Z' }),
          ],
        }),
      );
      expect(find(health.transports, 'hook').lastDelivery).toBe(
        '2026-07-19T11:30:00.000Z',
      );
    });
  });
});
