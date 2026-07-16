import path from 'node:path';
import { Command, Option } from 'commander';
import type {
  DoctorMonitorRollup,
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
  doctorReportClient,
  doctorReportInProcess,
} from '../runtime-client.js';
import { resolveWorkspaceDbPath } from '../workspace-db-path.js';

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
 */
function buildChecks(
  report: MonitorDoctorReport,
  enabled: boolean,
  daemonRunning: boolean,
  socketPath: string,
  daemonErrorMessage?: string,
): DoctorCheck[] {
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
      : report.hasLeadSession
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
    report.hasLeadSession
      ? {
          name: 'lead-session',
          status: 'pass',
          detail: `${String(report.leadSessions.length)} lead session(s) registered for this workspace.`,
        }
      : {
          name: 'lead-session',
          status: 'idle',
          detail: `No lead session is registered for workspace "${report.workspacePath}" (expected when no agent session is currently open).`,
          remediation: leadSessionRemediation(report.workspacePath),
        },
  );

  // 6. per-monitor health (criterion 2 rollup embedded in each check line)
  for (const monitor of report.monitors) {
    const name = `monitor:${monitor.id}`;
    const rollup = rollupLine(monitor, report.hasLeadSession);
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

function renderText(
  report: MonitorDoctorReport,
  checks: DoctorCheck[],
  workspace: string,
  daemonRunning: boolean,
  socketPath: string,
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
  checks: DoctorCheck[],
  workspace: string,
  daemonRunning: boolean,
  socketPath: string,
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
    leadSession: report.hasLeadSession,
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

        const checks = buildChecks(
          report,
          state.enabled,
          daemonRunning,
          socketPath,
          daemonErrorMessage,
        );

        console.log(
          json
            ? toJson(report, checks, workspace, daemonRunning, socketPath)
            : renderText(report, checks, workspace, daemonRunning, socketPath),
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
