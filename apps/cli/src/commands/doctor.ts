import path from 'node:path';
import { Command, Option } from 'commander';
import type {
  DoctorMonitorRollup,
  MonitorDoctorReport,
} from '@agentmonitors/core';
import { reportError } from '../output.js';
import { readLocalState, type LocalState } from '../local-state.js';
import { workspacePaths } from '../workspace-paths.js';
import { resolveDbPath } from '../db-path.js';
import { daemonAvailable, resolveSocketPath } from '../daemon-ipc.js';
import { resolveManualDaemonSocketPath } from '../manual-daemon.js';
import { doctorReportInProcess } from '../runtime-client.js';

/** A single named health check with an actionable remediation on failure. */
type DoctorCheckStatus = 'pass' | 'fail' | 'skip';

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
const LEAD_SESSION_REMEDIATION =
  'Open a Claude Code session in this workspace (the SessionStart hook registers a lead session), or run `agentmonitors session open --role lead --workspace <path>`.';
const NEVER_OBSERVED_REMEDIATION =
  'The daemon has not observed this monitor yet. Start it with `agentmonitors daemon run` (or wait for the next tick), then check `agentmonitors monitor history <id>`; `agentmonitors monitor test <path>` dry-runs it now.';

/**
 * Resolve the SQLite database path the daemon uses for this workspace, so the
 * in-process report reads the SAME store the daemon writes. Priority mirrors the
 * daemon's own resolution: `AGENTMONITORS_DB` wins (tests/overrides); otherwise
 * an enabled workspace uses its persisted or derived per-workspace db; a
 * not-enabled workspace falls back to the global default.
 */
function resolveWorkspaceDbPath(workspace: string, state: LocalState): string {
  if (process.env['AGENTMONITORS_DB']) return process.env['AGENTMONITORS_DB'];
  if (state.enabled) return state.db ?? workspacePaths(workspace).db;
  return resolveDbPath();
}

const STATUS_GLYPH: Record<DoctorCheckStatus, string> = {
  pass: '✓',
  fail: '✗',
  skip: '○',
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

  // 4. daemon reachable (with socket path)
  checks.push(
    daemonRunning
      ? {
          name: 'daemon-reachable',
          status: 'pass',
          detail: `Daemon is running (socket: ${socketPath}).`,
        }
      : {
          name: 'daemon-reachable',
          status: 'fail',
          detail: `No daemon reachable at ${socketPath} — showing persisted state from the last tick (expected when no agent session is currently open; the daemon starts automatically once one is).`,
          remediation: DAEMON_REMEDIATION,
        },
  );

  // 5. lead session present for this workspace
  checks.push(
    report.hasLeadSession
      ? {
          name: 'lead-session',
          status: 'pass',
          detail: `${String(report.leadSessions.length)} lead session(s) registered for this workspace.`,
        }
      : {
          name: 'lead-session',
          status: 'fail',
          detail:
            'No lead session is registered for this workspace (expected when no agent session is currently open).',
          remediation: LEAD_SESSION_REMEDIATION,
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
  lines.push('AgentMon doctor');
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
  lines.push('');
  lines.push(
    `Summary: ${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped.`,
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
    summary: { passed, failed, skipped },
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
  .option('--workspace <path>', 'Workspace path to diagnose', process.cwd())
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
        // then a concrete path for the reachability ping and display.
        const socketPath = resolveSocketPath(
          resolveManualDaemonSocketPath(options.socket, workspace) ??
            options.socket,
        );
        const daemonRunning = await daemonAvailable(socketPath);

        const report = await doctorReportInProcess(
          { monitorsDir, workspacePath: workspace },
          dbPath,
        );

        const checks = buildChecks(
          report,
          state.enabled,
          daemonRunning,
          socketPath,
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
