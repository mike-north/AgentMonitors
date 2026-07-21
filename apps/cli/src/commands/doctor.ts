import os from 'node:os';
import path from 'node:path';
import { Command, Option } from 'commander';
import type {
  AgentSessionRecord,
  DoctorMonitorRollup,
  HookDeliveryDiagnosis,
  MonitorDoctorReport,
} from '@agentmonitors/core';
import { reportError } from '../output.js';
import { readLocalState } from '../local-state.js';
import {
  DaemonConnectionError,
  DaemonUnsupportedRequestError,
  resolveSocketPath,
} from '../daemon-ipc.js';
import { resolveManualDaemonSocketPath } from '../manual-daemon.js';
import {
  diagnoseHookDeliveryClient,
  doctorReportClient,
  doctorReportInProcess,
} from '../runtime-client.js';
import { resolveWorkspaceDbPath } from '../workspace-db-path.js';
import { resolveDataRoot } from '../workspace-paths.js';
import { getCliVersion } from '../cli-version.js';
import {
  readTransportHeartbeats,
  type TransportName,
} from '../transport-heartbeat.js';
import {
  computeTransportHealth,
  isSharedProblem,
  type DeliveryTransportHealth,
  type TransportStatus,
} from '../transport-health.js';

/**
 * A single named health check with an actionable remediation on failure.
 *
 * `idle` (issue #373) is distinct from `fail`: it names a check that legitimately
 * does not apply right now (no agent session currently open for this workspace)
 * rather than a genuine problem. Only `fail` drives a non-zero exit code — an
 * idle-only report exits 0, same as an all-`pass` one.
 */
type DoctorCheckStatus = 'pass' | 'fail' | 'skip' | 'idle';

interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  /** Present only on `fail`; the concrete next step the author should take. */
  remediation?: string;
}

// Remediation strings. Each names a concrete command or edit — never a bare
// "something is wrong". The project-enabled step names the same enable
// action as the `session start` monitors-found-but-disabled advisory (issue
// #269) — creating `.claude/agentmonitors.local.md` with `enabled: true` —
// but leads with the one-shot bootstrap command (issue #310) that now does
// that for you.
//
// `daemon-reachable` and `lead-session`'s `detail` strings (below, in
// buildChecks) each carry an extra context clause (issue #331): both checks
// legitimately fail whenever no agent session is currently open (e.g. right
// after the setup-monitors skill's manual-test recipe tears down its
// throwaway daemon/session) — that is expected, not evidence of a broken
// setup, so the fail line says so instead of just looking alarming.
const ENABLE_REMEDIATION =
  'Run `agentmonitors init --enable-only`, or create `.claude/agentmonitors.local.md` in this project with `enabled: true` yourself.';
const DAEMON_REMEDIATION =
  'Start it with `agentmonitors daemon run`, or it starts automatically when a Claude Code session opens.';
// The lead-session remediation points at `session start` — the flagless
// lazy-boot path that matches real usage (the SessionStart hook runs exactly
// this command): it boots the project daemon if needed and registers a lead
// session in one shot. It deliberately does NOT recommend `session open`, whose
// `--host-session-id` is a required option with no meaningful value for a
// manual, no-plugin CLI user (issue #387) — copy-pasting a `session open`
// invocation hits `error: required option '--host-session-id' not specified`,
// a reproducible dead end reached by following doctor's own advice. For the
// manual case we print the exact stdin payload `session start` reads
// (`session_id` + `cwd`, delivered as JSON on stdin like a real hook), using an
// explicit `manual-cli-session` placeholder so the printed command runs verbatim.
//
// It also names the exact workspace path doctor searched (issue #335) so a
// future db/socket-derivation mismatch between doctor and `session start`/
// `session list` is self-diagnosing: compare this value against
// `agentmonitors session list`'s workspace column directly, rather than
// guessing whether the two commands agree.
//
// The printed command wraps the JSON payload in shell single-quotes for
// `echo`. `JSON.stringify` never emits an unescaped `'`, but the workspace
// path it embeds can legitimately contain one (e.g. a macOS "Mike's Mac"
// home directory) — so the payload itself can. `shellSingleQuote` closes the
// quote, escapes the embedded `'`, and reopens it (the standard POSIX idiom)
// so the printed command stays runnable verbatim regardless of the path.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function leadSessionRemediation(workspacePath: string): string {
  // Build the manual stdin payload with JSON.stringify so the embedded path is
  // correctly quoted as JSON; shellSingleQuote then makes the whole payload
  // safe to embed in the single-quoted shell string below.
  const manualPayload = JSON.stringify({
    session_id: 'manual-cli-session',
    cwd: workspacePath,
  });
  return `Open a Claude Code session in this workspace — the SessionStart hook runs \`agentmonitors session start\`, which lazy-boots the daemon and registers a lead session automatically. To register one by hand (no plugin), pipe a hook payload to that same command: \`echo ${shellSingleQuote(manualPayload)} | agentmonitors session start\`. Doctor searched for a lead session registered to workspace "${workspacePath}" — compare against \`agentmonitors session list\`.`;
}
const NEVER_OBSERVED_REMEDIATION =
  'The daemon has not observed this monitor yet. Start it with `agentmonitors daemon run` (or wait for the next tick), then check `agentmonitors monitor history <id>`; `agentmonitors monitor test <path>` dry-runs it now.';

const STATUS_GLYPH: Record<DoctorCheckStatus, string> = {
  pass: '✓',
  fail: '✗',
  skip: '○',
  // Distinct from both `fail` (✗) and `skip` (○): the check ran and found the
  // expected-when-idle state described in its `detail`, not a genuine problem
  // (issue #373).
  idle: '◇',
};

/**
 * One-line rollup for a monitor (criterion 2): id/source/urgency plus
 * last-observed, next-due, cadence, last-event, and per-lead-session delivery
 * counts — or the explicit "no lead session" marker when the workspace has none.
 */
function rollupLine(
  monitor: DoctorMonitorRollup,
  hasLeadSession: boolean,
): string {
  return [
    `source=${monitor.sourceName}`,
    `urgency=${monitor.urgency}`,
    `cadence=${monitor.cadence}`,
    `last-observed=${monitor.lastObservedAt ? monitor.lastObservedAt.toISOString() : 'never'}`,
    `next-due=${monitor.nextDueAt ? monitor.nextDueAt.toISOString() : 'unknown'}`,
    `last-event=${monitor.lastEventAt ? monitor.lastEventAt.toISOString() : 'none'}`,
    hasLeadSession
      ? `unread/claimed/acked=${String(monitor.delivery.unread)}/${String(monitor.delivery.claimed)}/${String(monitor.delivery.acknowledged)}`
      : 'lead-session=none',
  ].join('  ');
}

/**
 * Build the ordered check sequence (criterion 1). The report supplies every
 * durable-state fact; `enabled` and `daemonRunning` are CLI-only inputs. Each
 * check drives the exit code: any `fail` makes doctor exit non-zero.
 *
 * `activeLeadSessions` is the workspace's lead sessions filtered to
 * `status === 'active'` (issue #425 review, round 5) — `report.leadSessions`
 * includes sessions a prior `session close` already marked `dormant`, and a
 * dormant session is not a live recipient. Every check below that gates on
 * "is an agent session currently open" must agree on that same active set, or
 * a closed session reads as `pass`/`fail` on one check and `idle` on the
 * sibling check that already accounts for it (`daemon-reachable` previously
 * did; `lead-session`, the per-monitor rollup, and the JSON `leadSession`
 * field did not, which is what let a closed session's dormant record cross
 * the CLI boundary as if it were still live).
 */
function buildChecks(
  report: MonitorDoctorReport,
  activeLeadSessions: readonly AgentSessionRecord[],
  enabled: boolean,
  daemonRunning: boolean,
  socketPath: string,
  daemonErrorMessage?: string,
): DoctorCheck[] {
  const hasActiveLeadSession = activeLeadSessions.length > 0;
  const checks: DoctorCheck[] = [];

  // 1. project enabled
  checks.push(
    enabled
      ? {
          name: 'project-enabled',
          status: 'pass',
          detail: 'Monitoring is enabled for this workspace.',
        }
      : {
          name: 'project-enabled',
          status: 'fail',
          detail: 'Monitoring is not enabled for this workspace.',
          remediation: ENABLE_REMEDIATION,
        },
  );

  // 2. monitors directory found
  checks.push(
    report.monitorsDirExists
      ? {
          name: 'monitors-directory',
          status: 'pass',
          detail: `Found ${String(report.monitors.length)} monitor(s) in ${report.monitorsDir}.`,
        }
      : {
          name: 'monitors-directory',
          status: 'fail',
          detail: `Monitors directory not found: ${report.monitorsDir}.`,
          remediation: `Create the monitors directory and scaffold a monitor with \`agentmonitors init <name> --dir ${report.monitorsDir}\`.`,
        },
  );

  // 3. every monitor validates
  if (!report.monitorsDirExists || report.monitors.length === 0) {
    checks.push({
      name: 'monitors-valid',
      status: 'skip',
      detail: 'No monitors to validate.',
    });
  } else {
    const invalidIds = report.monitors
      .filter((monitor) => !monitor.valid)
      .map((monitor) => monitor.id);
    const parseIds = report.parseErrors.map((error) => error.id);
    const dupeIds = report.duplicateIds.map((dupe) => dupe.id);
    // One monitor can fail several ways at once (invalid scope + duplicate id,
    // parse error + duplicate); count and list each failing id exactly once.
    const problemIds = [...new Set([...invalidIds, ...parseIds, ...dupeIds])];
    checks.push(
      problemIds.length === 0
        ? {
            name: 'monitors-valid',
            status: 'pass',
            detail: `All ${String(report.monitors.length)} monitor(s) validate.`,
          }
        : {
            name: 'monitors-valid',
            status: 'fail',
            detail: `${String(problemIds.length)} monitor(s) failed validation: ${problemIds.join(', ')}.`,
            remediation: `Run \`agentmonitors validate ${report.monitorsDir}\` and fix the reported errors.`,
          },
    );
  }

  // 4. daemon reachable (with socket path). A down daemon is `idle`, not
  // `fail` (issue #373): the doc comment on DAEMON_REMEDIATION's detail text
  // already calls this "expected when no agent session is currently open" —
  // that framing means it must not force a non-zero exit on its own.
  //
  // But that framing is only true when no agent session is actually open
  // (issue #382): a *registered* lead session for this workspace means an
  // agent session IS (or very recently was) open, so an unreachable daemon
  // then is not "expected" — it means the daemon most likely crashed or was
  // killed out from under a live session. That must be a genuine `fail` (and
  // drive a non-zero exit), not the idle wording, which would be actively
  // misleading here.
  // The underlying connection failure's own message (timeout vs. ECONNREFUSED
  // vs. a version-skewed daemon's rejection — see `DaemonConnectionError` and
  // `DaemonUnsupportedRequestError`) is threaded through verbatim so a reader
  // can tell "nothing is listening yet" apart from "something answered but
  // wasn't a compatible daemon" instead of collapsing both to one generic
  // sentence.
  const daemonErrorClause = daemonErrorMessage
    ? ` (${daemonErrorMessage})`
    : '';
  checks.push(
    daemonRunning
      ? {
          name: 'daemon-reachable',
          status: 'pass',
          detail: `Daemon is running (socket: ${socketPath}).`,
        }
      : hasActiveLeadSession
        ? {
            name: 'daemon-reachable',
            status: 'fail',
            detail: `No daemon reachable at ${socketPath}${daemonErrorClause}, but a lead session is registered for workspace "${report.workspacePath}" — an agent session is open with no daemon serving it (it may have crashed or been killed).`,
            remediation: DAEMON_REMEDIATION,
          }
        : {
            name: 'daemon-reachable',
            status: 'idle',
            detail: `No daemon reachable at ${socketPath}${daemonErrorClause} — showing persisted state from the last tick (expected when no agent session is currently open; the daemon starts automatically once one is).`,
            remediation: DAEMON_REMEDIATION,
          },
  );

  // 5. lead session present for this workspace. Same `idle` treatment as
  // `daemon-reachable` above and for the same reason (issue #373).
  checks.push(
    hasActiveLeadSession
      ? {
          name: 'lead-session',
          status: 'pass',
          detail: `${String(activeLeadSessions.length)} active lead session(s) registered for this workspace.`,
        }
      : {
          name: 'lead-session',
          status: 'idle',
          detail: `No lead session is currently open for workspace "${report.workspacePath}" (expected when no agent session is currently open).`,
          remediation: leadSessionRemediation(report.workspacePath),
        },
  );

  // 6. per-monitor health (criterion 2 rollup embedded in each check line)
  for (const monitor of report.monitors) {
    const name = `monitor:${monitor.id}`;
    const rollup = rollupLine(monitor, hasActiveLeadSession);
    if (!monitor.valid) {
      checks.push({
        name,
        status: 'skip',
        detail: `invalid definition (see monitors-valid)  ${rollup}`,
      });
    } else if (monitor.neverObserved) {
      checks.push({
        name,
        status: 'fail',
        detail: `never observed  ${rollup}`,
        remediation: NEVER_OBSERVED_REMEDIATION,
      });
    } else {
      checks.push({ name, status: 'pass', detail: rollup });
    }
  }

  return checks;
}

/**
 * The five-field transport summary line (`pid`/`version`/`workspace`/
 * `socket`/`last-delivery`), shared by both places that render it: the
 * `transport:<name>` check detail below and the human-readable
 * `Delivery transports:` block's `transportLine`. Extracted so the two never
 * silently drift apart field-by-field.
 */
function transportSummary(transport: TransportStatus): string {
  const bound = transport.boundTo;
  return [
    `pid=${String(bound?.pid ?? 0)}`,
    `version=${transport.version ?? 'unknown'}`,
    `workspace=${bound?.workspacePath ?? 'unknown'}`,
    `socket=${bound?.socketPath ?? 'unknown'}`,
    `last-delivery=${transport.lastDelivery ?? 'never'}`,
  ].join('  ');
}

/** Remediation for a transport that has never reported in for this workspace. */
function notConfiguredRemediation(transport: TransportName): string {
  return transport === 'hook'
    ? "Submit a prompt in a Claude Code session in this workspace — the `UserPromptSubmit` hook runs `agentmonitors hook deliver` and writes this transport's first heartbeat. If a prompt has already been submitted and this still shows, the plugin hooks are not installed."
    : 'Start (or reconnect) a Claude Code session in this workspace so `agentmonitors channel serve` boots and writes its heartbeat. The channel is optional — the hook transport keeps delivering meanwhile.';
}

/**
 * Append the delivery-transport checks (issue #425) — "what is the listening
 * method for this session, and is it healthy?".
 *
 * Exit-code discipline mirrors the existing `daemon-reachable`/`lead-session`
 * treatment: a `fail` here must mean something is genuinely broken, never
 * merely "not in use right now". Two states are therefore deliberately NOT
 * failures:
 *
 * - **No lead session.** Nothing is listening because no agent session is open.
 *   That is the expected idle state, not a degradation — including for a
 *   transport that DID report in during some past session: a heartbeat left
 *   behind by an uncleanly-killed process (SIGKILL, host crash) is stale or
 *   misbound evidence about a session that is no longer open, not a live
 *   failure of anything happening now (005 §15). Gating on `hasLeadSession`
 *   here, the same way the `!configured` branch already does, is what keeps a
 *   single dead heartbeat from failing every future `doctor` run in this
 *   workspace forever. `readTransportHeartbeats` itself never reaps — GC is a
 *   write-path-only responsibility (issue #425 review, round 6) — so a lapsed
 *   record is durable across every `doctor` run until some transport
 *   actually writes again; this gate is what keeps every one of those reads
 *   honest in the meantime.
 * - **A lead session, but no transport has ever reported in.** Reached by every
 *   flow that registers a session without running a delivery transport (a
 *   `session start` in a script, a freshly-opened session that has not yet had
 *   its first `UserPromptSubmit`). Failing here would cry wolf on a setup that
 *   is about to be fine on the very next prompt.
 *
 * Everything else — a transport bound to another workspace, a lapsed
 * heartbeat, muted reminders — involves a transport that DID report in AND a
 * lead session that IS currently open, so it is reported as a genuine `fail`
 * with its own remediation. The pre-existing `daemon-reachable` check already
 * fails the "daemon died under a live session" case, so this section never
 * needs to double-report it to be loud.
 */
function transportChecks(
  health: DeliveryTransportHealth,
  hasLeadSession: boolean,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const anyConfigured = health.transports.some(
    (transport) => transport.configured,
  );

  for (const transport of health.transports) {
    const name = `transport:${transport.name}`;
    if (!transport.configured) {
      checks.push({
        name,
        status: hasLeadSession ? 'idle' : 'skip',
        detail: hasLeadSession
          ? `No ${transport.name} transport has reported in for this workspace. Either it has not run yet (the hook transport records itself on the first prompt of a session; the channel is optional), or it is running under a different HOME/data root and is invisible from here.`
          : `No ${transport.name} transport has reported in (expected when no agent session is currently open).`,
        // Idle is not the same as "nothing to do" — the reader who hits this
        // first (every fresh setup) still needs a concrete next step, not a
        // bare status glyph (005 §15).
        remediation: notConfiguredRemediation(transport.name),
      });
      continue;
    }

    const summary = transportSummary(transport);

    if (!hasLeadSession) {
      checks.push({
        name,
        status: 'idle',
        detail: `${summary}  (no lead session is currently open for this workspace, so its health is not being evaluated right now)`,
        remediation:
          'Open a Claude Code session in this workspace — the SessionStart hook registers a lead session automatically. Re-run `agentmonitors doctor` once one is open to get a live verdict for this transport.',
      });
      continue;
    }

    // A transport row reports only the problems that transport OWNS. Three
    // categories are excluded: the unprovable channel-registration caveat and
    // version-skew (both advisories, never defects — see `transport-health.ts`
    // for why crying wolf on either would make a working transport read as
    // broken on every run/upgrade), and pipeline-wide problems like a down
    // daemon or muted reminders, which the `delivery-verdict` check below
    // reports once instead of repeating them on every row as if they were
    // independent failures.
    const blocking = transport.problems.filter(
      (problem) =>
        problem.code !== 'channel-registration-unverified' &&
        problem.code !== 'version-skew' &&
        !isSharedProblem(problem.code),
    );

    if (blocking.length === 0) {
      checks.push({ name, status: 'pass', detail: summary });
      continue;
    }
    checks.push({
      name,
      status: 'fail',
      // Every problem is named with its own code so two simultaneous
      // degradations never read as one generic failure.
      detail: `${summary}\n    ${blocking.map((problem) => `[${problem.code}] ${problem.detail}`).join('\n    ')}`,
      remediation: blocking.map((problem) => problem.remediation).join(' '),
    });
  }

  const suppression = health.pipelineProblems.find(
    (problem) => problem.code === 'reminders-suppressed',
  );

  // `idle` only when there is genuinely nothing to judge: no session open, or
  // a session whose transports have not reported in AND no pipeline-level
  // problem. A pipeline problem (muted reminders, a down daemon) is a real,
  // live degradation that must fail even before a transport registers —
  // otherwise the worst case, suppression on a workspace with no heartbeat yet,
  // would exit 0 while nothing can ever arrive.
  const idleVerdict =
    !hasLeadSession || (!anyConfigured && health.pipelineProblems.length === 0);
  checks.push({
    name: 'delivery-verdict',
    status: idleVerdict ? 'idle' : health.deliverable ? 'pass' : 'fail',
    detail: health.verdict,
    ...(health.deliverable
      ? {}
      : {
          remediation:
            suppression?.remediation ??
            (health.remediation.length > 0
              ? health.remediation.join(' ')
              : 'Open a Claude Code session in this workspace so a delivery transport registers itself.'),
        }),
  });

  return checks;
}

/**
 * The human-readable "Delivery transports" block (issue #425 §2). Rendered
 * above the check list because it answers the question a reader arrived with —
 * "will I be told?" — before the per-monitor detail.
 */
function renderTransportSection(health: DeliveryTransportHealth): string[] {
  const lines: string[] = ['Delivery transports:'];
  for (const transport of health.transports) {
    lines.push(`  ${transportLine(transport)}`);
    for (const problem of transport.problems) {
      // Pipeline-wide problems are printed once below the rows (from
      // `pipelineProblems`), so a single down daemon does not read as one
      // problem per transport.
      if (isSharedProblem(problem.code)) continue;
      lines.push(`      ! [${problem.code}] ${problem.detail}`);
      lines.push(`        ↳ ${problem.remediation}`);
    }
  }
  // Read from `pipelineProblems`, NOT from the transports: these must stay
  // visible when no transport has reported in at all, which is exactly when
  // muted reminders would otherwise vanish behind "nothing is listening".
  for (const problem of health.pipelineProblems) {
    lines.push(`  ! [${problem.code}] ${problem.detail}`);
    lines.push(`    ↳ ${problem.remediation}`);
  }
  lines.push(`  verdict: ${health.verdict}`);
  return lines;
}

function transportLine(transport: TransportStatus): string {
  if (!transport.configured) {
    return `${transport.name}: not reporting`;
  }
  const state = transport.running ? 'running' : 'stale';
  return `${transport.name}: ${state}  ${transportSummary(transport)}`;
}

function renderText(
  report: MonitorDoctorReport,
  checks: DoctorCheck[],
  workspace: string,
  daemonRunning: boolean,
  socketPath: string,
  health: DeliveryTransportHealth,
): string {
  const lines: string[] = [];
  // The banner names the real invocation ("agentmonitors doctor"), not the
  // "AgentMon" product short-name, so it never reads as a command a user
  // could type but that would actually fail (issue #338, item 5: the binary
  // is `agentmonitors`; "AgentMon" is prose-only).
  lines.push('agentmonitors doctor');
  lines.push(`Workspace: ${workspace}`);
  lines.push(`Monitors:  ${report.monitorsDir}`);
  lines.push(
    `Daemon:    ${daemonRunning ? 'running' : 'not running'} (${socketPath})`,
  );
  lines.push('');
  lines.push(...renderTransportSection(health));
  lines.push('');
  for (const check of checks) {
    lines.push(`${STATUS_GLYPH[check.status]} ${check.name}: ${check.detail}`);
    if (check.remediation) lines.push(`    ↳ ${check.remediation}`);
  }
  const passed = checks.filter((check) => check.status === 'pass').length;
  const failed = checks.filter((check) => check.status === 'fail').length;
  const skipped = checks.filter((check) => check.status === 'skip').length;
  const idle = checks.filter((check) => check.status === 'idle').length;
  lines.push('');
  lines.push(
    `Summary: ${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped, ${String(idle)} idle.`,
  );
  return lines.join('\n');
}

/**
 * Stable, documented machine shape (criterion 4; spec 005 §"doctor"). Dates are
 * ISO strings or `null`; `ok` is `true` iff no check failed.
 */
function toJson(
  report: MonitorDoctorReport,
  hasActiveLeadSession: boolean,
  checks: DoctorCheck[],
  workspace: string,
  daemonRunning: boolean,
  socketPath: string,
  health: DeliveryTransportHealth,
): string {
  const passed = checks.filter((check) => check.status === 'pass').length;
  const failed = checks.filter((check) => check.status === 'fail').length;
  const skipped = checks.filter((check) => check.status === 'skip').length;
  const idle = checks.filter((check) => check.status === 'idle').length;
  const payload = {
    ok: failed === 0,
    generatedAt: report.generatedAt.toISOString(),
    workspace,
    monitorsDir: report.monitorsDir,
    daemon: { running: daemonRunning, socketPath },
    // ACTIVE lead sessions only (issue #425 review, round 5): `report.leadSessions`
    // includes sessions a prior `session close` already marked `dormant`, which
    // is not a live recipient — see `buildChecks`'s doc comment for why every
    // gate in this command must agree on the same active set.
    leadSession: hasActiveLeadSession,
    // Delivery-transport health (issue #425). `deliveryWillReachThisSession`
    // names the listening METHOD; `deliverable` answers "will anything actually
    // arrive right now" — they differ precisely in the suppression case, which
    // is the one that hid a broken CI signal in the field.
    transports: health.transports.map((transport) => ({
      name: transport.name,
      configured: transport.configured,
      running: transport.running,
      healthy: transport.healthy,
      boundTo: transport.boundTo ?? null,
      version: transport.version ?? null,
      lastDelivery: transport.lastDelivery,
      problems: transport.problems.map((problem) => ({
        code: problem.code,
        detail: problem.detail,
        remediation: problem.remediation,
      })),
    })),
    pipelineProblems: health.pipelineProblems.map((problem) => ({
      code: problem.code,
      detail: problem.detail,
      remediation: problem.remediation,
    })),
    deliveryWillReachThisSession: health.deliveryWillReachThisSession,
    deliverable: health.deliverable,
    verdict: health.verdict,
    remediation: health.remediation,
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      detail: check.detail,
      remediation: check.remediation ?? null,
    })),
    monitors: report.monitors.map((monitor) => ({
      id: monitor.id,
      sourceType: monitor.sourceName,
      urgency: monitor.urgency,
      valid: monitor.valid,
      validationError: monitor.validationError ?? null,
      lastObservedAt: monitor.lastObservedAt
        ? monitor.lastObservedAt.toISOString()
        : null,
      neverObserved: monitor.neverObserved,
      nextDueAt: monitor.nextDueAt ? monitor.nextDueAt.toISOString() : null,
      cadence: monitor.cadence,
      lastEventAt: monitor.lastEventAt
        ? monitor.lastEventAt.toISOString()
        : null,
      delivery: monitor.delivery,
    })),
    summary: { passed, failed, skipped, idle },
  };
  return JSON.stringify(payload, null, 2);
}

/** The result of asking the daemon for every lead session's delivery diagnosis. */
interface DeliveryDiagnosisResult {
  diagnoses: HookDeliveryDiagnosis[];
  /**
   * Ids of lead sessions for which at least one lifecycle's diagnosis could
   * not be obtained (e.g. an older daemon that rejects `hook.diagnose` as
   * unsupported — `DaemonUnsupportedRequestError`, issue #382 — or a
   * transient connection failure mid-report).
   */
  unavailableSessionIds: string[];
}

/**
 * Ask the daemon why delivery would be withheld for each lead session, at both
 * reminder lifecycles.
 *
 * Both are queried because the two bands are held at different lifecycles
 * (normal at `turn-interruptible`, low at `turn-idle`, 002 §9.2/§9.3) — asking
 * only one would silently miss the other band's suppression, which is the exact
 * class of blind spot this surface exists to close.
 *
 * A per-call diagnosis failure does not abort the whole report — `doctor` is a
 * read-only diagnostic, and one unavailable sub-answer must not take down
 * every other check — but it is NOT silently swallowed either: before this fix,
 * a thrown `hook.diagnose` (e.g. `DaemonUnsupportedRequestError` from an older
 * daemon build) left `diagnoses` looking identical to "no suppression is
 * active", so `computeTransportHealth` reported `deliverable: true` even
 * though whether reminders were suppressed was never actually answered — a
 * false green (issue #425 review, round 4). Every failed lifecycle now records
 * its session id in `unavailableSessionIds`, which the caller threads into
 * {@link computeTransportHealth} as an explicit, named advisory so `deliverable`
 * can never read `true` while the check was skipped.
 *
 * Takes the caller's ACTIVE lead sessions, not the whole report (issue #425
 * review, round 5): `MonitorDoctorReport.leadSessions` includes sessions a
 * prior `session close` already marked `dormant`, which have no live host
 * process to answer for. Diagnosing a dormant session's suppression state
 * either hangs the RPC on a session that will never respond or, worse,
 * spuriously flags it `unavailable` and forces `deliverable: false` for a
 * session nobody is asking about anymore — every caller must pass the same
 * active set `buildChecks`/`computeTransportHealth` use.
 */
// Exported for unit testing (doctor.test.ts) — not part of the CLI's public
// surface, which is `doctorCommand` alone.
export async function gatherDeliveryDiagnoses(
  leadSessions: readonly AgentSessionRecord[],
  socketPath: string,
): Promise<DeliveryDiagnosisResult> {
  const diagnoses: HookDeliveryDiagnosis[] = [];
  const unavailableSessionIds = new Set<string>();
  for (const session of leadSessions) {
    for (const lifecycle of ['turn-interruptible', 'turn-idle'] as const) {
      try {
        diagnoses.push(
          await diagnoseHookDeliveryClient(session.id, lifecycle, socketPath),
        );
      } catch {
        unavailableSessionIds.add(session.id);
      }
    }
  }
  return { diagnoses, unavailableSessionIds: [...unavailableSessionIds] };
}

export const doctorCommand = new Command('doctor')
  .description(
    'Diagnose workspace monitoring health: run named checks and a per-monitor rollup',
  )
  .option(
    '--dir <path>',
    'Directory containing monitor definitions (defaults to <workspace>/.claude/monitors)',
  )
  .option(
    '--workspace <path>',
    'Workspace path to diagnose (defaults to the current working directory)',
    process.cwd(),
  )
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (options: {
      dir?: string;
      workspace: string;
      socket?: string;
      format: string;
    }) => {
      const json = options.format === 'json';
      const workspace = path.resolve(options.workspace);
      const monitorsDir = options.dir
        ? path.resolve(options.dir)
        : path.join(workspace, '.claude', 'monitors');

      try {
        const state = readLocalState(workspace);
        const dbPath = resolveWorkspaceDbPath(workspace, state);
        // Resolve the socket the same way manual daemon commands do — an enabled
        // workspace's persisted socket reaches the same daemon the plugin uses —
        // then a concrete path used both for the report call and for display.
        const socketPath = resolveSocketPath(
          resolveManualDaemonSocketPath(options.socket, workspace) ??
            options.socket,
        );

        // Prefer the LIVE daemon's own connection when one is reachable
        // (issue #373): a separate reader connection opened fresh against the
        // same SQLite file can lag behind a live writer connection's commits
        // (WAL visibility across processes is not instantaneous the way
        // same-connection reads are), which under-reported `last-observed`/
        // `last-event`/delivery counts after a real delivery. Only fall back
        // to the in-process read — mirroring `monitor explain`/`monitor
        // history` — when the daemon is genuinely unreachable; a daemon-side
        // application error must still surface verbatim, not be masked as
        // "daemon not running".
        let daemonRunning: boolean;
        // Captured only on the fallback path, so it can be threaded into the
        // `daemon-reachable` detail (issue #382) — undefined on the happy
        // path where there is nothing to report.
        let daemonErrorMessage: string | undefined;
        let report: MonitorDoctorReport;
        try {
          report = await doctorReportClient(
            { monitorsDir, workspacePath: workspace },
            socketPath,
          );
          daemonRunning = true;
        } catch (error) {
          // A `DaemonUnsupportedRequestError` (issue #382) means a daemon
          // answered but is an older build that predates `doctor.report` —
          // version skew, not a genuine "daemon is down" — but the fallback
          // path is identical either way: neither call produced a usable
          // report, so read the same persisted state `monitor
          // explain`/`history` fall back to.
          if (
            !(error instanceof DaemonConnectionError) &&
            !(error instanceof DaemonUnsupportedRequestError)
          ) {
            throw error;
          }
          daemonRunning = false;
          daemonErrorMessage = error.message;
          report = await doctorReportInProcess(
            { monitorsDir, workspacePath: workspace },
            dbPath,
          );
        }

        // ACTIVE leads only (issue #425 review, round 3, tightened round 5):
        // `report.leadSessions` is every lead session ever registered for this
        // workspace, including ones a prior `session.close` already marked
        // `dormant`. A dormant session has no live host process to deliver
        // to, so counting it let a merely-fresh heartbeat (its TTL had not
        // yet lapsed, or a NEW session's hook already left its own record)
        // report `deliverable: true` for a
        // recipient nothing can actually reach. Derived ONCE here and threaded
        // through every check/diagnosis/JSON field that gates on "is a
        // session currently open" — see `buildChecks`'s doc comment for why a
        // second, independently-filtered copy is exactly the bug this fixes.
        const activeLeadSessions = report.leadSessions.filter(
          (session) => session.status === 'active',
        );

        const checks = buildChecks(
          report,
          activeLeadSessions,
          state.enabled,
          daemonRunning,
          socketPath,
          daemonErrorMessage,
        );

        // Delivery-transport health (issue #425). The suppression verdict is a
        // LIVE question — it depends on which unread events are currently
        // claimed — so it is only asked when the daemon answered; the persisted
        // fallback state cannot compute it. When it is unavailable the surface
        // reports the down daemon instead, which is the dominant problem anyway.
        const { diagnoses, unavailableSessionIds } = daemonRunning
          ? await gatherDeliveryDiagnoses(activeLeadSessions, socketPath)
          : { diagnoses: [], unavailableSessionIds: [] };
        const health = computeTransportHealth({
          workspacePath: workspace,
          socketPath,
          daemonRunning,
          ...(daemonErrorMessage ? { daemonErrorMessage } : {}),
          leadHostSessionIds: activeLeadSessions.map(
            (session) => session.hostSessionId,
          ),
          // A PURE read (issue #425 review): `doctor` never reaps. Reaping
          // here let the diagnostic erase its own evidence — a second run
          // found no record and exited 0 with nothing actually recovered —
          // and contradicted 005 §15's "diagnoses only, never mutates".
          heartbeats: readTransportHeartbeats(),
          diagnoses,
          diagnosisUnavailableSessionIds: unavailableSessionIds,
          cliVersion: getCliVersion(),
          // Supplied by the caller, not read inside `computeTransportHealth`
          // (issue #425 review): the function's own doc claims purity ("every
          // value is passed in"), but reading `os.homedir()`/`resolveDataRoot()`
          // live inside `bindingProblems` broke that claim — `doctor` is the
          // one place that should resolve "what do WE expect", exactly like
          // `socketPath` above.
          expectedHome: os.homedir(),
          expectedDataRoot: resolveDataRoot(),
          now: report.generatedAt,
        });
        const hasActiveLeadSession = activeLeadSessions.length > 0;
        checks.push(...transportChecks(health, hasActiveLeadSession));

        console.log(
          json
            ? toJson(
                report,
                hasActiveLeadSession,
                checks,
                workspace,
                daemonRunning,
                socketPath,
                health,
              )
            : renderText(
                report,
                checks,
                workspace,
                daemonRunning,
                socketPath,
                health,
              ),
        );

        if (checks.some((check) => check.status === 'fail')) {
          process.exitCode = 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, json);
      }
    },
  );
