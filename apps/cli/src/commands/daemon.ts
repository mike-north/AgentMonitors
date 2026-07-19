import path from 'node:path';
import { Command, Option } from 'commander';
import type {
  RuntimeStatus,
  RuntimeTickResult,
  WatchHandle,
} from '@agentmonitors/core';
import { createRuntime } from '../runtime.js';
import { reportError } from '../output.js';
import {
  callDaemon,
  createDaemonServer,
  daemonAvailable,
  resolveSocketPath,
  waitForDaemonAvailable,
  type DaemonStatusResult,
} from '../daemon-ipc.js';
import { daemonStatusClient, daemonTickClient } from '../runtime-client.js';
import { shouldReap, BOOT_GRACE_MS } from '../reap-decision.js';
import { resolveManualDaemonSocketPath } from '../manual-daemon.js';
import { resolveWorkspaceDbPath } from '../workspace-db-path.js';
import { workspacePaths } from '../workspace-paths.js';
import { spawnDetachedDaemon, type SpawnedDaemon } from '../detached-spawn.js';

const DEFAULT_REAP_AFTER_MS = 5 * 60 * 1000;

/**
 * `daemon status` reads either the live daemon's own `status` response
 * (which carries `pid`/`reapAfterMs` — issue #389 review findings 1/4) or,
 * when nothing is running, an in-process `RuntimeStatus` read straight from
 * the store, which has no OS process or reap window to report. A real type
 * guard (rather than an inline `'pid' in status` check) is needed here
 * because `RuntimeStatus` is a non-sealed interface — TS otherwise narrows
 * the property's type to `unknown` instead of eliminating the branch.
 */
function isLiveDaemonStatus(
  status: RuntimeStatus | DaemonStatusResult,
): status is DaemonStatusResult {
  return 'pid' in status;
}

/**
 * How long `daemon run --detach` waits for the backgrounded daemon to bind its
 * socket before giving up and pointing the user at the log (issue #389 P1).
 * Generous enough for a cold Node start on a loaded machine; a genuine bind
 * failure (stale socket, permissions) surfaces in the log either way.
 */
const DETACH_READY_TIMEOUT_MS = 15_000;
const DETACH_READY_POLL_MS = 150;

/** Outcome of {@link waitForDetachedDaemonReady}. */
export type DetachReadyOutcome =
  | { ready: true }
  | { ready: false; spawnError?: Error };

/**
 * Wait for the just-spawned detached daemon to answer on its socket, racing
 * the readiness poll against the child's own `error` event (issue #389
 * review finding 2). Without the race, a synchronous spawn failure (bad
 * `execPath`, `ENOENT`) would only surface after the FULL readiness timeout
 * elapsed, and the resulting message would point at a log file the daemon
 * never got the chance to write — `spawnError` lets the caller fail fast and
 * report the real cause instead.
 *
 * Exported for unit testing: a fake {@link SpawnedDaemon} whose `spawnError`
 * resolves immediately proves the fail-fast race deterministically, without
 * waiting out a real readiness timeout or needing an actual OS-level spawn
 * failure.
 */
export async function waitForDetachedDaemonReady(
  socketPath: string,
  timeoutMs: number,
  pollMs: number,
  spawned: SpawnedDaemon,
): Promise<DetachReadyOutcome> {
  let sawError: Error | undefined;
  const errorSignal = spawned.spawnError.then((error) => {
    sawError = error;
    return false as const;
  });
  const ready = await Promise.race([
    waitForDaemonAvailable(socketPath, timeoutMs, pollMs),
    errorSignal,
  ]);
  if (ready) return { ready: true };
  return sawError ? { ready: false, spawnError: sawError } : { ready: false };
}

/**
 * Pure decision for issue #389 review finding 1: given the pid our own
 * `--detach` child was spawned with and the pid `status` reports for whoever
 * is actually answering the socket now, decide whether a concurrent lazy-boot
 * elsewhere (`session start`'s check-then-spawn has no cross-process
 * pre-spawn lock; only the bind-time lock serializes) won the startup race —
 * our own child lost the bind and already exited, and a DIFFERENT daemon is
 * the one actually serving this socket. Returns the honest error message to
 * report, or `undefined` when the daemon we spawned is confirmed to be the
 * one answering (the ordinary case) — including when identity can't be
 * checked at all (either pid is unavailable), in which case the caller falls
 * back to reporting success on reachability alone, as before this finding.
 *
 * Extracted as a pure function so the race-detection logic itself has
 * deterministic unit coverage — reproducing the actual OS-level startup race
 * on demand in an integration test is inherently timing-dependent.
 */
export function describeDetachRaceLoss(input: {
  spawnedPid: number | undefined;
  servingPid: number | undefined;
  servingReapAfterMs: number | undefined;
  requestedReapAfterMs: number;
  socketPath: string;
}): string | undefined {
  if (
    input.spawnedPid === undefined ||
    input.servingPid === undefined ||
    input.servingPid === input.spawnedPid
  ) {
    return undefined;
  }
  const reapDescription =
    input.servingReapAfterMs === undefined
      ? 'unknown'
      : input.servingReapAfterMs === 0
        ? 'disabled'
        : `stops after ${String(Math.round(input.servingReapAfterMs / 1000))}s idle`;
  return (
    `Another daemon is already serving ${input.socketPath} (pid ${String(input.servingPid)}) — ` +
    `the --detach child we spawned (pid ${String(input.spawnedPid)}) lost the startup race and exited. ` +
    `That daemon's own reap setting applies (${reapDescription}), not the ` +
    `--reap-after-ms ${String(input.requestedReapAfterMs)} this command requested. Run ` +
    '`agentmonitors daemon stop` and retry if you need the settings you requested.'
  );
}

/**
 * Append per-monitor errored lines to a tick summary so a non-zero errored
 * count is visible without a verbose flag (issue #117). Returns the summary
 * unchanged when nothing errored, so the genuine no-change case stays clean.
 */
function appendErroredLines(
  summary: string,
  errored: RuntimeTickResult['erroredObservations'],
): string {
  if (errored.length === 0) return summary;
  const lines = errored.map((e) => `  ${e.monitorId}: ${e.message}`);
  return [summary, ...lines].join('\n');
}

/**
 * Append a skipped-monitors suffix to a tick summary so a second `daemon once`
 * run within a monitor's next-due window is never mistaken for "no monitors
 * found" (issue #152). Returns the summary unchanged when nothing was skipped.
 *
 * The suffix reports the total skipped count and the soonest next-due time so
 * an author immediately knows how long to wait, e.g.:
 *   `(2 not yet due — next due in 28s)`
 *
 * The wording is intentionally generic: "not yet due" is accurate for both
 * interval-based monitors (file-fingerprint, api-poll) and schedule monitors
 * whose cron window has not opened, avoiding "interval not elapsed" language
 * that would be misleading for cron-driven sources.
 */
function appendSkippedSuffix(
  summary: string,
  skipped: RuntimeTickResult['skippedMonitors'],
  now: Date,
): string {
  if (skipped.length === 0) return summary;
  const soonestMs = Math.min(
    ...skipped.map((s) => s.nextDueAt.getTime() - now.getTime()),
  );
  const soonestSec = Math.max(0, Math.ceil(soonestMs / 1000));
  return `${summary} (${String(skipped.length)} not yet due — next due in ${String(soonestSec)}s)`;
}

/**
 * Exported for unit testing (issue #398): a test spies on
 * `AgentMonitorRuntime.prototype.listSessions` to force a transient error out
 * of the idle-reaping block and asserts the loop survives it, mirroring the
 * existing tick-error-continues behavior. Not part of the CLI's public API.
 */
export async function runLoop(
  monitorsDir: string,
  workspacePath: string,
  pollMs: number,
  socketPath: string,
  reapAfterMs: number,
  dbPath: string,
): Promise<void> {
  const runtime = createRuntime(dbPath);
  let stopping = false;
  let wakeLoop: (() => void) | undefined;
  const server = createDaemonServer({
    runtime,
    socketPath,
    reapAfterMs,
    onStop: () => {
      stopping = true;
      wakeLoop?.();
    },
  });
  const stop = () => {
    stopping = true;
    wakeLoop?.();
  };
  const isStoppingRequested = () => stopping;

  let idleSince: number | null = null;
  let hasSeenSession = false;

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await server.listen();
  console.log(`AgentMon daemon listening on ${socketPath}`);

  // Start continuous watchers for any watch-capable sources (G5). Watched
  // monitors are driven by their watcher; the tick loop below skips them. New
  // monitors added after startup are picked up on the next daemon restart.
  let watchHandle: WatchHandle | undefined;
  try {
    watchHandle = await runtime.watchMonitors(monitorsDir, workspacePath, {
      onError: (monitorId, error) => {
        console.error(
          `AgentMon watcher for "${monitorId}" failed: ${error.message}`,
        );
      },
    });
    if (watchHandle.monitorIds.length > 0) {
      console.log(
        `Watching ${String(watchHandle.monitorIds.length)} monitor(s) continuously: ${watchHandle.monitorIds.join(', ')}.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`AgentMon watch setup failed: ${message}`);
  }

  try {
    while (!isStoppingRequested()) {
      try {
        const result = await runtime.tick(monitorsDir, workspacePath);
        // Log when the tick emitted events OR when one or more monitors
        // errored — a silent `emitted 0` must not hide a broken source
        // (issue #117). A clean no-change tick still logs nothing.
        if (
          result.emittedEventIds.length > 0 ||
          result.erroredObservations.length > 0
        ) {
          const summary = appendErroredLines(
            `Emitted ${String(result.emittedEventIds.length)} event(s) from ${String(result.evaluatedMonitors.length)} monitor(s)${
              result.erroredObservations.length > 0
                ? `, ${String(result.erroredObservations.length)} errored:`
                : '.'
            }`,
            result.erroredObservations,
          );
          console.log(summary);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`AgentMon runtime tick failed: ${message}`);
      }

      // Idle reaping: stop the daemon when no active sessions have been open
      // for this workspace continuously for the required idle window.
      // Uses shouldReap() which applies a boot-grace period to prevent the
      // reaper from firing before `session start` finishes registration.
      //
      // hasSeenSession is also set if any dormant session exists — this handles
      // the case where a session is registered and closed between tick intervals
      // (tick only observes the closed/dormant state but must not apply the
      // boot-grace period as if no session was ever registered).
      //
      // Wrapped in its own try/catch (issue #398): a transient error here
      // (e.g. a brief schema-visibility gap on `listSessions()`) must be
      // logged and skipped, not left to escape the loop and kill the daemon
      // the way the protected tick above already handles its own errors.
      try {
        const workspaceSessions = runtime
          .listSessions()
          .filter((s) => s.workspacePath === workspacePath);
        const openCount = workspaceSessions.filter(
          (s) => s.status === 'active',
        ).length;
        const anySession = workspaceSessions.length > 0;
        const decision = shouldReap({
          openCount,
          hasSeenSession: hasSeenSession || anySession,
          idleSince,
          now: Date.now(),
          reapAfterMs,
          bootGraceMs: BOOT_GRACE_MS,
        });
        idleSince = decision.nextIdleSince;
        hasSeenSession = decision.nextHasSeenSession;
        if (decision.reap) {
          stop();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`AgentMon reaping check failed: ${message}`);
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          wakeLoop = undefined;
          resolve();
        }, pollMs);
        wakeLoop = () => {
          clearTimeout(timeout);
          wakeLoop = undefined;
          resolve();
        };
      });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (watchHandle) await watchHandle.stop();
    await server.close();
  }
}

export const daemonCommand = new Command('daemon').description(
  'Run or inspect the AgentMon runtime loop',
);

daemonCommand
  .command('once')
  .description('Run one runtime observation cycle')
  .argument(
    '[monitorsDir]',
    'Directory containing MONITOR.md files',
    '.claude/monitors',
  )
  .option(
    '--workspace <path>',
    'Workspace path for session projection (defaults to the current working directory)',
    process.cwd(),
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (
      monitorsDir: string,
      options: { workspace: string; format: string },
    ) => {
      try {
        const now = new Date();
        // Resolve to an absolute, normalized path the SAME way `doctor` and
        // `session open` do (issue #335), so an unresolved relative value
        // cannot silently diverge from what those commands compute.
        const workspace = path.resolve(options.workspace);
        // Resolve the SAME per-workspace db `doctor`/`session open` assume
        // (issue #335): an enabled workspace gets its isolated db, not the
        // bare global default, so a directly-invoked `daemon once` agrees
        // with every other workspace-aware command.
        const dbPath = resolveWorkspaceDbPath(workspace);
        const result = await daemonTickClient(monitorsDir, workspace, dbPath);
        if (options.format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        // Surface a non-zero errored count without a verbose flag so an author
        // can tell a broken source from a genuine no-change (issue #117). The
        // clean case ends with a period and no extra lines (don't cry wolf).
        const erroredCount = result.erroredObservations.length;
        const base = `Evaluated ${String(result.evaluatedMonitors.length)} monitor(s), emitted ${String(result.emittedEventIds.length)} event(s)${
          erroredCount > 0 ? `, ${String(erroredCount)} errored:` : '.'
        }`;
        // Append skipped-monitors context to the summary line first (issue #152),
        // then append per-monitor errored lines. This ensures the skipped suffix
        // stays on the summary rather than the last errored line.
        const withSkipped = appendSkippedSuffix(
          base,
          result.skippedMonitors,
          now,
        );
        console.log(
          appendErroredLines(withSkipped, result.erroredObservations),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, options.format === 'json');
      }
    },
  );

daemonCommand
  .command('run')
  .description('Run the runtime loop continuously')
  .argument(
    '[monitorsDir]',
    'Directory containing MONITOR.md files',
    '.claude/monitors',
  )
  .option(
    '--workspace <path>',
    'Workspace path for session projection (defaults to the current working directory)',
    process.cwd(),
  )
  .option('--poll-ms <ms>', 'Polling interval in milliseconds', '30000')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option(
    '--reap-after-ms <ms>',
    'Stop the daemon after this many ms of idle (no active sessions). Set 0 to disable.',
    String(DEFAULT_REAP_AFTER_MS),
  )
  .option(
    '--detach',
    'Run the daemon in the background and return, printing its pid, socket, and log path. ' +
      'Combine with --reap-after-ms 0 for a daemon that outlives every session.',
  )
  .option(
    '--log <path>',
    'With --detach, append the daemon output here (default: daemon.log in the workspace data dir)',
  )
  .addHelpText(
    'after',
    `
Foreground vs background:
  Without --detach the daemon runs in the foreground and occupies the terminal
  until Ctrl-C or \`agentmonitors daemon stop\`.
  With --detach it is backgrounded, survives the terminal that started it, and
  the command returns once the daemon answers on its socket.

  A daemon that must stay up while no agent session is open (e.g. so a monitor
  can alert an idle agent) needs the reaper disabled as well:
      agentmonitors daemon run --detach --reap-after-ms 0
`,
  )
  .action(
    async (
      monitorsDir: string,
      options: {
        workspace: string;
        pollMs: string;
        socket?: string;
        reapAfterMs: string;
        detach?: boolean;
        log?: string;
      },
    ) => {
      const pollMs = Number(options.pollMs);
      if (!Number.isFinite(pollMs) || pollMs <= 0) {
        reportError('--poll-ms must be a positive number.', false);
        return;
      }
      const reapAfterMs = Number(options.reapAfterMs);
      if (!Number.isFinite(reapAfterMs) || reapAfterMs < 0) {
        reportError(
          '--reap-after-ms must be a non-negative number (0 disables).',
          false,
        );
        return;
      }
      // Resolve to an absolute, normalized path the SAME way `doctor` and
      // `session open` do (issue #335), so an unresolved relative value
      // cannot silently diverge from what those commands compute.
      const workspace = path.resolve(options.workspace);
      // Resolve db + socket the SAME per-workspace-aware way manual daemon
      // commands (`session open`, `doctor`, ...) already do (issue #335): an
      // enabled workspace with no persisted socket yet (e.g. the very first
      // `daemon run` for this project, exactly as the Getting Started guide
      // instructs) binds to its derived per-workspace socket/db rather than
      // the bare global default, so every command diagnosing "this
      // workspace's daemon" — including a directly-invoked one — agrees.
      // `resolveManualDaemonSocketPath` already threads the explicit-socket
      // over-limit warning (issue #337) through its own `explicitSocket`
      // branch, so no separate `{ explicit }` option is needed here.
      const socketPath = resolveSocketPath(
        resolveManualDaemonSocketPath(options.socket, workspace) ??
          options.socket,
      );
      const dbPath = resolveWorkspaceDbPath(workspace);
      if (await daemonAvailable(socketPath)) {
        reportError(
          `AgentMon daemon is already running at ${socketPath}.`,
          false,
        );
        return;
      }
      // Background mode (issue #389 P1): `init` tells manual users to "start
      // the daemon yourself: agentmonitors daemon run", which then occupies
      // their terminal — leaving them to discover `& disown` plus their own
      // log redirection. `--detach` re-invokes this same command WITHOUT
      // `--detach` in a detached child (reusing the exact spawn path a
      // hook-driven boot takes), waits until that child actually answers on
      // the socket, and reports where to find it. Every resolved value —
      // monitors dir, workspace, socket, db, poll interval, and the reap
      // window (including `--reap-after-ms 0`, the persistent-daemon
      // combination) — is passed through explicitly, so the backgrounded
      // daemon is the same daemon the foreground run would have been.
      if (options.detach === true) {
        const logPath =
          options.log === undefined
            ? path.join(workspacePaths(workspace).dir, 'daemon.log')
            : path.resolve(options.log);
        // Opening the log touches the filesystem (mkdir/chmod/open), so a
        // permission error or an unwritable `--log` path must surface as the
        // CLI's normal one-line error + non-zero exit, never a raw stack
        // trace. The daemon's own `--workspace`/db failures already do.
        let spawned: SpawnedDaemon;
        try {
          spawned = spawnDetachedDaemon({
            monitorsDir,
            workspacePath: workspace,
            socket: socketPath,
            db: dbPath,
            pollMs,
            reapAfterMs,
            logPath,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          reportError(
            `Could not start the detached daemon (log: ${logPath}): ${message}`,
            false,
          );
          return;
        }
        const pid = spawned.pid;
        const pidNote = pid !== undefined ? ` (pid ${String(pid)})` : '';
        const outcome = await waitForDetachedDaemonReady(
          socketPath,
          DETACH_READY_TIMEOUT_MS,
          DETACH_READY_POLL_MS,
          spawned,
        );
        if (!outcome.ready) {
          // The child never became reachable — it must not be left running
          // unmanaged (issue #389 review finding 2): a slow bind past the
          // timeout would otherwise leave a live background daemon the user
          // was told failed, and a subsequent retry would then hit "already
          // running" against it.
          if (pid !== undefined) {
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              /* already gone */
            }
          }
          if (outcome.spawnError) {
            // The OS never actually started the process (e.g. ENOENT/EACCES) —
            // pointing at the log here would be pointing at nothing; it was
            // never written. Report the real cause instead.
            reportError(
              `Failed to spawn the detached daemon${pidNote}: ${outcome.spawnError.message}`,
              false,
            );
          } else {
            reportError(
              `Detached daemon${pidNote} did not answer on ${socketPath} within ${String(
                Math.round(DETACH_READY_TIMEOUT_MS / 1000),
              )}s; it has been sent SIGTERM. See ${logPath} for why.`,
              false,
            );
          }
          return;
        }
        // Something now answers on the socket — but concurrent lazy-boot
        // (`session start`'s check-then-spawn has no cross-process pre-spawn
        // lock; only the bind-time lock serializes) means our spawned child
        // may have LOST the bind race and already exited, while a DIFFERENT
        // daemon (e.g. one the SessionStart hook just booted) is the one
        // actually answering. Verify identity via the pid `status` reports
        // (issue #389 review finding 1) rather than assuming success.
        let servingPid: number | undefined;
        let servingReapAfterMs: number | undefined;
        try {
          const status = await daemonStatusClient(socketPath);
          servingPid = status.pid;
          servingReapAfterMs = status.reapAfterMs;
        } catch {
          // Best-effort identity check only — if `status` itself is
          // unreachable right after a successful `daemonAvailable` probe,
          // fall through and report success as before rather than failing a
          // command whose actual property (daemon reachable) held.
        }
        const raceMessage = describeDetachRaceLoss({
          spawnedPid: pid,
          servingPid,
          servingReapAfterMs,
          requestedReapAfterMs: reapAfterMs,
          socketPath,
        });
        if (raceMessage !== undefined) {
          reportError(raceMessage, false);
          return;
        }
        console.log('AgentMon daemon started in the background.');
        if (pid !== undefined) console.log(`  pid:    ${String(pid)}`);
        console.log(`  socket: ${socketPath}`);
        console.log(`  log:    ${logPath}`);
        console.log(
          reapAfterMs === 0
            ? '  reaping disabled — it runs until `agentmonitors daemon stop`.'
            : `  stops after ${String(Math.round(reapAfterMs / 1000))}s with no active session; use --reap-after-ms 0 to keep it up.`,
        );
        return;
      }
      if (options.log !== undefined) {
        // `--log` only makes sense with `--detach` — the foreground path
        // already inherits the terminal's own stdout/stderr, so Commander
        // silently accepting `--log` here would leave a user who typed it
        // (expecting a diagnostic file during an incident) with an empty log
        // and no idea why (issue #389 review finding 3 — the same
        // "silently ignored flag" papercut class this PR exists to close).
        reportError(
          '--log only applies with --detach (the foreground daemon already writes to this terminal).',
          false,
        );
        return;
      }
      // Mirror the `status`/`stop`/`once` siblings: a failure inside the loop
      // (bind error, watch setup, tick crash that escapes) must print a clean
      // error and set a non-zero exit code, not surface as an unhandled
      // rejection now that the CLI drives actions with `parseAsync`.
      try {
        await runLoop(
          monitorsDir,
          workspace,
          pollMs,
          socketPath,
          reapAfterMs,
          dbPath,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, false);
      }
    },
  );

daemonCommand
  .command('status')
  .description('Show runtime status from the local database')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(async (options: { socket?: string; format: string }) => {
    try {
      // Resolve the SAME per-workspace-aware socket (and, for the in-process
      // fallback, db) that `doctor`/`session open`/`session list` already do
      // (issue #335) — otherwise `daemon status` silently pings the bare
      // global default and reports "not running" for a daemon every other
      // workspace-aware command can already see. Resolved once and reused for
      // every downstream call (`daemonAvailable`, `daemonStatusClient`, the
      // payload) so an over-limit explicit `--socket` (issue #337, threaded
      // through `resolveManualDaemonSocketPath`'s own `explicitSocket`
      // branch) is only substituted/warned about a single time.
      const socketPath = resolveSocketPath(
        resolveManualDaemonSocketPath(options.socket) ?? options.socket,
      );
      const running = await daemonAvailable(socketPath);
      const status = running
        ? await daemonStatusClient(socketPath)
        : createRuntime(
            resolveWorkspaceDbPath(
              process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd(),
            ),
          ).status();
      const payload = {
        running,
        socketPath,
        ...status,
      };
      if (options.format === 'json') {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Daemon running: ${running ? 'yes' : 'no'}`);
      console.log(`Socket: ${payload.socketPath}`);
      // pid/reapAfterMs only exist on the live-daemon response (issue #389
      // review findings 1/4) — the in-process fallback used when nothing is
      // running has no OS process or reap window of its own to report.
      if (isLiveDaemonStatus(status)) {
        console.log(`Pid: ${String(status.pid)}`);
        console.log(`Sessions: ${String(status.sessions)}`);
        console.log(`Active sessions: ${String(status.activeSessions)}`);
        console.log(`Dormant sessions: ${String(status.dormantSessions)}`);
        console.log(`Events: ${String(status.events)}`);
        console.log(
          status.reapAfterMs === 0
            ? 'Reaping: disabled'
            : `Reaping: stops after ${String(Math.round(status.reapAfterMs / 1000))}s idle`,
        );
      } else {
        console.log(`Sessions: ${String(status.sessions)}`);
        console.log(`Active sessions: ${String(status.activeSessions)}`);
        console.log(`Dormant sessions: ${String(status.dormantSessions)}`);
        console.log(`Events: ${String(status.events)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportError(message, options.format === 'json');
    }
  });

daemonCommand
  .command('stop')
  .description('Ask the local AgentMon daemon to stop')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .action(async (options: { socket?: string }) => {
    try {
      // Same per-workspace-aware socket resolution as `daemon status`/`doctor`
      // (issue #335), so `daemon stop` reaches the daemon those commands see.
      // An explicit over-limit `--socket` still warns exactly once (issue
      // #337), via `resolveManualDaemonSocketPath`'s own `explicitSocket`
      // branch.
      const socketPath = resolveManualDaemonSocketPath(options.socket);
      await callDaemon('stop', {}, socketPath ? { socketPath } : {});
      console.log('AgentMon daemon stopping.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportError(message, false);
    }
  });
