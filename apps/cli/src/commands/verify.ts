import path from 'node:path';
import os from 'node:os';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Command, Option } from 'commander';
import {
  claudeCodeAdapter,
  scanMonitors,
  SourceRegistry,
  type AgentSessionRecord,
  type MonitorDefinition,
  type MonitorEventRecord,
  type Urgency,
} from '@agentmonitors/core';
import { reportError } from '../output.js';
import { registerCoreSources } from '../sources.js';
import { cliEntry } from '../detached-spawn.js';
import { spawnDetachedDaemon } from '../detached-spawn.js';
import {
  daemonAvailable,
  DaemonUnsupportedRequestError,
  resolveSocketPath,
} from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import { resolveManualDaemonSocketPath } from '../manual-daemon.js';
import { resolveWorkspaceDbPath } from '../workspace-db-path.js';
import {
  closeSessionClient,
  listEventsClient,
  listObservationHistoryClient,
  openSessionClient,
  retractObjectEventsClient,
  suppressObjectEventsClient,
} from '../runtime-client.js';
import { reserveRenderAndCommitHookDelivery } from './hook.js';
import {
  computeVerifyBudget,
  deliveryLifecycleForUrgency,
  deriveScratchTriggerPath,
  isLiteralGlob,
  type VerifyBudget,
} from '../verify-budget.js';
import {
  renderVerifyJson,
  renderVerifyText,
  type Stage,
  type StageName,
  type VerifyResult,
} from '../verify-report.js';

/**
 * Append the failure stage for a mid-run daemon crash. It names the stage that
 * was actually *in flight* when the daemon died — not the last COMPLETED stage.
 * Reading the last completed stage (a prior `stages[stages.length - 1]`) blamed
 * the wrong phase and duplicated that phase's name in the report; this takes the
 * tracked in-flight stage instead.
 */
export function appendDaemonCrashStage(
  stages: Stage[],
  inFlightStage: StageName,
): void {
  stages.push({ name: inFlightStage, status: 'fail', detail: 'daemon exited' });
}

/**
 * How verify erases the events a trigger produced against a PERSISTENT
 * (`--use-workspace-daemon`) daemon after proving delivery — the two mechanisms
 * have deliberately non-overlapping safe domains (issue #418):
 *
 * - `'tombstone'`: the `objectKey` is a synthetic scratch path
 *   (`…/agentmonitors-verify-<token><ext>`) that no real monitored file ever
 *   shares. A durable, self-expiring by-KEY suppression retracts the create now
 *   and lets the daemon sweep the pending deletion on the tick it materializes —
 *   WITHOUT verify blocking a poll interval (issue #414). Safe precisely because
 *   the key is synthetic: a by-key sweep can never eat a real event.
 * - `'retract-by-id'`: the `objectKey` is a REAL watched path verify created (a
 *   literal single-file glob whose file was absent). A by-key sweep here WOULD
 *   eat a later genuine event at that same path, so verify instead waits for its
 *   own create+delete to materialize and retracts ONLY those exact event ids
 *   (issue #407). Costs a poll interval, but only for this rare literal case.
 * - `'none'`: verify edited pre-existing user content (restored on revert) or the
 *   run is manual — the events reference real content and are never erased.
 */
type TriggerCleanup = 'tombstone' | 'retract-by-id' | 'none';

/** A trigger verify performs (and reverts) to produce a real observable change. */
interface Trigger {
  /** Human description shown on the `trigger` stage. */
  describe: string;
  /** Perform the change (synchronous). */
  fire: () => void;
  /** Restore/clean up. Idempotent — safe to call from `finally` and signals. */
  revert: () => void;
  /**
   * The file-fingerprint `objectKey` (an absolute path) this trigger acts on —
   * the key its create/delete events carry. Used by the `--use-workspace-daemon`
   * cleanup to erase those events after the run (issues #407/#414).
   */
  objectKey: string;
  /** Which post-delivery cleanup mechanism this trigger's events require. */
  cleanup: TriggerCleanup;
}

const PROGRESS_INTERVAL_MS = 2_500;
const POLL_INTERVAL_MS = 300;
const BOOT_TIMEOUT_MS = 15_000;
/**
 * How long the crash-safety teardown (and the tombstone→retract version-skew
 * fallback) waits for a literal-created file's deletion event to materialize
 * before retracting whatever exists (issue #407/#418). Short: the delete follows
 * verify's own `revert` within a poll interval, and teardown must not hang exit.
 */
const TEARDOWN_RETRACT_WAIT_MS = 3_000;

/** Emit a progress line to stderr so `--format json` stdout stays a single clean doc. */
function progress(message: string): void {
  process.stderr.write(`[verify] ${message}\n`);
}

/** Normalise a monitor's `watch.globs` to a string[] (accepts string | string[]). */
function watchGlobs(monitor: MonitorDefinition): string[] {
  const raw = (monitor.frontmatter.watch as Record<string, unknown>)['globs'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw))
    return raw.filter((g): g is string => typeof g === 'string');
  return [];
}

/** Resolve the base directory globs are relative to (`watch.cwd` or the workspace). */
function watchBaseDir(monitor: MonitorDefinition, workspace: string): string {
  const raw = (monitor.frontmatter.watch as Record<string, unknown>)['cwd'];
  if (typeof raw === 'string' && raw.length > 0)
    return path.resolve(workspace, raw);
  return workspace;
}

/**
 * Coerce a record timestamp to epoch ms. Over the daemon socket, `Date` fields
 * are JSON-serialized to ISO strings (the `ObservationHistoryRecord.createdAt:
 * Date` type describes the in-process shape, not the deserialized wire shape),
 * so a bare `.getTime()` would throw. Accept `Date | string | number`.
 */
function toMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

const TRIGGER_CONTENT = (token: string): string =>
  `AgentMon verify trigger ${token}\ngenerated to prove end-to-end delivery\n`;

/**
 * Build the auto-trigger for a file-fingerprint monitor. Preference order:
 * 1. A **scratch sibling** for the first non-literal glob (zero mutation of any
 *    existing file — safest). Created on `fire`, deleted on `revert`.
 * 2. For a literal single-file glob, the watched file itself: created if absent
 *    (deleted on revert), or briefly edited and **restored to its original
 *    bytes** on revert if it already exists — the issue's explicit fallback
 *    ("a real content edit … and reverts it"). Original bytes are captured up
 *    front so a crash mid-run restores cleanly via the signal handlers.
 *
 * Returns `null` when there is no glob to trigger against (caller falls back to
 * `--manual`).
 */
function buildAutoTrigger(
  monitor: MonitorDefinition,
  workspace: string,
  token: string,
): Trigger | null {
  const globs = watchGlobs(monitor);
  if (globs.length === 0) return null;
  const baseDir = watchBaseDir(monitor, workspace);

  const patternGlob = globs.find((g) => !isLiteralGlob(g));
  if (patternGlob) {
    const target = deriveScratchTriggerPath(patternGlob, baseDir, token);
    let created = false;
    return {
      objectKey: target,
      // A synthetic scratch sibling — `agentmonitors-verify-<token><ext>`, a path
      // no real monitored file shares — so its events are erased with the durable
      // by-key tombstone (issue #414).
      cleanup: 'tombstone',
      describe: `wrote scratch file ${path.relative(workspace, target) || target}`,
      fire: () => {
        // The glob's static directory prefix normally already exists; create it
        // defensively so a pattern like `logs/*.txt` in a fresh tree doesn't
        // ENOENT. Any dir created this way is left in place on revert (rare,
        // negligible) — only the scratch file itself is removed.
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, TRIGGER_CONTENT(token), 'utf-8');
        created = true;
      },
      revert: () => {
        if (created && existsSync(target)) rmSync(target, { force: true });
        created = false;
      },
    };
  }

  // Only literal globs remain: use the watched file itself.
  const literal = globs[0];
  if (literal === undefined) return null;
  const target = path.resolve(baseDir, literal);
  const existed = existsSync(target);
  const original = existed ? readFileSync(target) : null;
  let mutated = false;
  return {
    objectKey: target,
    // The `objectKey` here is the REAL watched path (a literal single-file glob).
    // If verify created it (absent before), its create+delete are pure artifacts —
    // but a durable by-key tombstone at a real path would eat a later genuine event
    // there, so we retract by the exact observed ids instead (issue #418). If the
    // file pre-existed, verify only edits and restores it: real user content, never
    // erased.
    cleanup: existed ? 'none' : 'retract-by-id',
    describe: existed
      ? `edited watched file ${path.relative(workspace, target) || target} (restored on exit)`
      : `created watched file ${path.relative(workspace, target) || target}`,
    fire: () => {
      const next =
        original !== null
          ? Buffer.concat([
              original,
              Buffer.from(`\n<!-- agentmonitors verify ${token} -->\n`),
            ])
          : Buffer.from(TRIGGER_CONTENT(token));
      writeFileSync(target, next);
      mutated = true;
    },
    revert: () => {
      if (!mutated) return;
      if (original !== null) {
        writeFileSync(target, original);
      } else if (existsSync(target)) {
        rmSync(target, { force: true });
      }
      mutated = false;
    },
  };
}

/**
 * Raised when a `--trigger-cmd` shell command fails to run to completion —
 * a non-zero exit, a spawn failure, or a timeout. Distinct from `no-change`
 * (the command ran but nothing the monitor watches changed) — this is a
 * broken trigger command, reported as a `setup` failure so the operator
 * fixes the command, not the monitor.
 */
class TriggerCommandFailed extends Error {
  constructor(
    readonly command: string,
    readonly cause: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'TriggerCommandFailed';
  }

  /** A `--trigger-cmd` that exited non-zero or otherwise failed to spawn. */
  static forError(command: string, cause: unknown): TriggerCommandFailed {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new TriggerCommandFailed(
      command,
      cause,
      `--trigger-cmd failed: ${detail}`,
    );
  }

  /** A `--trigger-cmd` that was killed for exceeding its `timeoutMs` budget. */
  static forTimeout(
    command: string,
    cause: unknown,
    timeoutMs: number,
  ): TriggerCommandFailed {
    return new TriggerCommandFailed(
      command,
      cause,
      `--trigger-cmd timed out after ${String(timeoutMs)}ms`,
    );
  }
}

/** `true` when `error` is a Node `execSync` error raised because the child was killed for exceeding its `timeout` option (`error.code === 'ETIMEDOUT'`). */
function isExecTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ETIMEDOUT'
  );
}

/**
 * Build the **decoupled trigger** for `--trigger-cmd`: `verify` itself runs the
 * given shell command (after baseline) to cause the change the monitor should
 * observe. This makes a non-auto-triggerable source (`command-poll`, `api-poll`,
 * `schedule`, `incoming-changes`) verifiable in ONE self-contained,
 * non-interactive invocation — the call-and-return agent harness that can't
 * interleave a second command during a blocking `--manual` wait (issue #413).
 *
 * The command runs through a shell (`execSync`, so the OS default shell —
 * `/bin/sh -c` on POSIX) with `cwd` = the workspace, so a pattern like
 * `touch new-file.txt` lands where the monitor watches. Its effects are **not
 * reverted**: unlike the fabricated file-fingerprint scratch file, an
 * arbitrary shell command has no known inverse, so cleanup (if any) is the
 * operator's own — pick a command whose residue is acceptable. A non-zero
 * exit throws `TriggerCommandFailed`. `timeoutMs` bounds how long the command
 * may run: without it, a never-exiting command (e.g. a stuck server, a typo'd
 * `sleep` with no end) would hang `verify` forever, before any of its other
 * budgets ever get a chance to apply — the command is killed with `SIGKILL`
 * and the timeout is reported as a `TriggerCommandFailed`, not left to hang.
 */
function buildCommandTrigger(
  command: string,
  workspace: string,
  timeoutMs: number,
): Trigger {
  return {
    // A `--trigger-cmd` run's effects are real changes the operator's own
    // command caused — not a verify-fabricated scratch object. `cleanup: 'none'`
    // keeps it out of the `--use-workspace-daemon` cleanup path entirely (issues
    // #407/#414): its events reference genuine changes and must never be erased,
    // and it never trips the scratch-events teardown. Because it is never
    // cleaned up, `objectKey` is unused for this mode (the command may touch
    // anything, so there is no single file-fingerprint key to record).
    objectKey: '',
    cleanup: 'none',
    describe: `ran trigger command: ${command}`,
    fire: () => {
      try {
        execSync(command, {
          cwd: workspace,
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
        });
      } catch (error) {
        if (isExecTimeout(error)) {
          throw TriggerCommandFailed.forTimeout(command, error, timeoutMs);
        }
        throw TriggerCommandFailed.forError(command, error);
      }
    },
    // No-op: an arbitrary shell command's effects are the operator's to undo.
    revert: () => {
      /* intentionally empty */
    },
  };
}

/**
 * The trailing guidance appended to a `budget-exceeded` observe FAIL, tailored
 * to how the change was (or wasn't) triggered. The `manual` variant is the
 * important one (issue #413): it names the decoupled `--trigger-cmd` mode and
 * the background-and-interleave workaround, because a call-and-return agent
 * harness (one shell command per tool call) can't make the change during the
 * blocking, stdin-less `--manual` wait, and a bare "did you make a change?"
 * gives it nowhere to go.
 */
function budgetExceededHint(mode: TriggerMode): string {
  switch (mode) {
    case 'manual':
      return (
        '`--manual` blocks and does NOT read stdin, so a call-and-return agent ' +
        "(one shell command per step) can't make the change while it waits. " +
        "Re-run with `--trigger-cmd '<shell>'` to have verify make the change " +
        'itself in one self-contained command, or background the `--manual` run ' +
        'and make the change in a separate step (see the getting-started docs).'
      );
    case 'command':
      return (
        'The --trigger-cmd ran but the change was not observed in time — ' +
        'increase --timeout-ms if the interval is long, or check the monitor ' +
        'with `agentmonitors monitor explain`.'
      );
    case 'auto':
      return (
        'Increase --timeout-ms if the interval is long, or check the monitor ' +
        'with `agentmonitors monitor explain`.'
      );
  }
}

interface IsolatedDaemon {
  socketPath: string;
  /** Isolated-mode child; undefined for a reused/detached workspace daemon. */
  child?: ChildProcess;
  tempDir?: string;
  /** True once the supervised child has exited. */
  exited: () => boolean;
  /** Captured stderr from the supervised child (empty for reused daemons). */
  capturedStderr: () => string;
  /** Tear down anything this run created (kills an isolated child, removes tempdir). */
  teardown: () => Promise<void>;
}

/**
 * Boot an **isolated** daemon (temp db + socket) as a supervised child process
 * so verify can (a) fully tear it down and (b) observe a crash with the
 * daemon's own stderr (issue #398). Reaping is disabled (`--reap-after-ms 0`)
 * so it cannot self-reap mid-run.
 */
async function bootIsolatedDaemon(
  monitorsDir: string,
  workspace: string,
): Promise<IsolatedDaemon> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentmon-verify-'));
  const db = path.join(tempDir, 'verify.db');
  const socketPath = resolveSocketPath(path.join(tempDir, 'd.sock'));

  const child = spawn(
    process.execPath,
    [
      cliEntry(),
      'daemon',
      'run',
      monitorsDir,
      '--workspace',
      workspace,
      '--socket',
      socketPath,
      '--poll-ms',
      '250',
      '--reap-after-ms',
      '0',
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        AGENTMONITORS_DB: db,
        AGENTMONITORS_SOCKET: socketPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('exit', () => {
    exited = true;
  });

  const teardown = async (): Promise<void> => {
    if (!exited && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
        // Backstop: don't hang teardown if the child ignores SIGTERM.
        void delay(3_000).then(() => {
          child.kill('SIGKILL');
          resolve();
        });
      });
    }
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A crash during boot sets a non-null exit code (an uncaught error exits
    // 1); we never signal-kill the child here, so `exitCode !== null` is a
    // reliable "the daemon died" check the flow analyzer can also see.
    if (child.exitCode !== null) {
      await teardown();
      throw new DaemonDied(child.exitCode, stderr || stdout, 'boot');
    }
    if (
      existsSync(socketPath) &&
      stdout.includes('AgentMon daemon listening')
    ) {
      return {
        socketPath,
        child,
        tempDir,
        exited: () => exited,
        capturedStderr: () => stderr,
        teardown,
      };
    }
    await delay(POLL_INTERVAL_MS);
  }
  await teardown();
  throw new DaemonDied(
    child.exitCode,
    stderr ||
      `daemon did not report listening within ${String(BOOT_TIMEOUT_MS)}ms`,
    'boot',
  );
}

/**
 * Reuse the workspace daemon (booting a detached one that outlives verify if
 * needed) so a subsequent `agentmonitors doctor` reflects the real delivery
 * (`--use-workspace-daemon`). Crash detection here is availability-based only —
 * verify does not own the process, so it has no captured stderr.
 */
async function useWorkspaceDaemon(
  monitorsDir: string,
  workspace: string,
): Promise<IsolatedDaemon> {
  const state = readLocalState(workspace);
  if (!state.enabled) {
    throw new VerifySetupError(
      'This workspace is not enabled, so --use-workspace-daemon cannot target its daemon. Run `agentmonitors init --enable-only` first, or drop the flag to verify against an isolated daemon.',
    );
  }
  const socketPath = resolveSocketPath(
    resolveManualDaemonSocketPath(undefined, workspace) ?? undefined,
  );
  const db = resolveWorkspaceDbPath(workspace, state);
  if (!(await daemonAvailable(socketPath))) {
    spawnDetachedDaemon({
      monitorsDir,
      workspacePath: workspace,
      socket: socketPath,
      db,
      pollMs: 1_000,
    });
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline && !(await daemonAvailable(socketPath))) {
      await delay(POLL_INTERVAL_MS);
    }
    if (!(await daemonAvailable(socketPath))) {
      throw new DaemonDied(null, 'workspace daemon failed to start', 'boot');
    }
  }
  return {
    socketPath,
    exited: () => false,
    capturedStderr: () => '',
    teardown: async () => {
      /* leave the workspace daemon running so `doctor` stays green */
    },
  };
}

class DaemonDied extends Error {
  constructor(
    readonly code: number | null,
    readonly daemonStderr: string,
    readonly phase: 'boot' | 'run',
  ) {
    super(
      `Daemon exited (code ${code === null ? 'null' : String(code)}) during ${phase}`,
    );
    this.name = 'DaemonDied';
  }
}

class VerifySetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifySetupError';
  }
}

/** Poll until `predicate` returns a non-null value or the deadline passes; abort on daemon exit. */
async function pollUntil<T>(
  deadline: number,
  daemon: IsolatedDaemon,
  predicate: () => Promise<T | null>,
  onProgress?: () => void,
): Promise<T | null> {
  let lastProgress = 0;
  while (Date.now() < deadline) {
    if (daemon.exited()) {
      throw new DaemonDied(
        daemon.child?.exitCode ?? null,
        daemon.capturedStderr(),
        'run',
      );
    }
    const value = await predicate();
    if (value !== null) return value;
    if (onProgress && Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
      onProgress();
      lastProgress = Date.now();
    }
    await delay(POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Resolve the target monitor: an explicit id, or the sole monitor when the
 * workspace has exactly one. Ambiguity (0 or >1 with no id) is a setup error
 * naming the choices.
 */
async function resolveMonitor(
  monitorsDir: string,
  monitorId: string | undefined,
): Promise<MonitorDefinition> {
  const scan = await scanMonitors(monitorsDir);
  const monitors = scan.monitors.map((m) => m.monitor);
  if (monitors.length === 0) {
    throw new VerifySetupError(
      `No monitors found under ${monitorsDir}. Scaffold one with \`agentmonitors init <name>\`.`,
    );
  }
  if (monitorId) {
    const match = monitors.find((m) => m.id === monitorId);
    if (!match) {
      throw new VerifySetupError(
        `Monitor "${monitorId}" not found under ${monitorsDir}. Available: ${monitors.map((m) => m.id).join(', ')}.`,
      );
    }
    return match;
  }
  const [firstMonitor] = monitors;
  if (monitors.length === 1 && firstMonitor) return firstMonitor;
  throw new VerifySetupError(
    `Multiple monitors found; specify which to verify: ${monitors.map((m) => m.id).join(', ')}.`,
  );
}

/**
 * How `verify` produces the observable change:
 * - `auto` — fabricate one (file-fingerprint scratch file / edit).
 * - `command` — run the operator's `--trigger-cmd` shell command.
 * - `manual` — block and wait for the operator to make the change out-of-band.
 */
type TriggerMode = 'auto' | 'command' | 'manual';

interface RunOptions {
  monitor: MonitorDefinition;
  workspace: string;
  daemon: IsolatedDaemon;
  budget: VerifyBudget;
  detectCapMs: number;
  manual: boolean;
  /**
   * When true the run targets the persistent workspace daemon (which outlives
   * verify), so verify must retract the events its own scratch file generated —
   * otherwise its teardown deletion surfaces to a later session (issue #407). In
   * the default isolated mode the daemon + db are torn down, so no retraction is
   * needed.
   */
  useWorkspaceDaemon: boolean;
  /** The `--trigger-cmd` shell command, when the decoupled mode is used. */
  triggerCmd?: string | undefined;
}

/** The core orchestration once a monitor is resolved and a daemon is reachable. */
async function runVerification(opts: RunOptions): Promise<VerifyResult> {
  const { monitor, workspace, daemon, budget, detectCapMs, manual } = opts;
  const { useWorkspaceDaemon, triggerCmd } = opts;
  const mode: TriggerMode = manual
    ? 'manual'
    : triggerCmd !== undefined
      ? 'command'
      : 'auto';
  const startedAt = Date.now();
  const stages: Stage[] = [];
  const token = randomBytes(6).toString('hex');
  let session: AgentSessionRecord | undefined;
  let trigger: Trigger | null = null;
  // #407: set once the scratch object's events have been retracted/suppressed, so
  // the crash-safety pass in `finally` (and the signal handler) skips the work on
  // the happy path and only runs when an interruption hit before cleanup.
  let scratchEventsRetracted = false;
  // #414: TTL for the scratch tombstone — long enough for the file's deletion to
  // re-materialize and be swept by the daemon AFTER verify has exited, short
  // enough that an interrupted run leaves nothing lingering. Derived from the
  // monitor's own detect budget so a long-interval monitor gets a proportionally
  // longer window.
  const suppressTtlMs = Math.max(
    detectCapMs + budget.intervalMs + budget.settleMs,
    60_000,
  );
  // The stage currently being polled, so a mid-flight daemon crash blames the
  // stage that was actually in progress — not the last COMPLETED stage (an
  // off-by-one that also duplicated that stage's name). Advanced before each
  // poll phase below and read by the `DaemonDied` catch.
  let inFlightStage: StageName = 'daemon';

  const finalize = (
    partial: Omit<VerifyResult, 'elapsedMs' | 'monitorId'>,
  ): VerifyResult => ({
    ...partial,
    monitorId: monitor.id,
    elapsedMs: Date.now() - startedAt,
  });

  // The single teardown for the workspace-daemon artifacts (issue #414), shared
  // by the normal `finally` AND the signal handler so an interrupted run cleans
  // up identically: erase verify's scratch events (retract the create + tombstone
  // the pending deletion) and end the throwaway verify session. Reads `trigger`,
  // `session`, and `scratchEventsRetracted` LIVE so it does the right thing at
  // whatever point it fires. Idempotent and best-effort — safe to call twice, and
  // never throws (the daemon may already be gone).
  const teardownWorkspaceArtifacts = async (): Promise<void> => {
    if (
      useWorkspaceDaemon &&
      trigger &&
      trigger.cleanup !== 'none' &&
      !scratchEventsRetracted
    ) {
      try {
        await cleanupScratchEvents(trigger, monitor.id, workspace, daemon, {
          ttlMs: suppressTtlMs,
          retractWaitMs: TEARDOWN_RETRACT_WAIT_MS,
        });
        scratchEventsRetracted = true;
      } catch {
        /* best-effort: daemon may already be gone */
      }
    }
    if (session) {
      try {
        await closeSessionClient(session.id, daemon.socketPath);
      } catch {
        /* daemon may already be gone; best-effort cleanup */
      }
    }
  };
  // Arm the async signal cleanup as soon as this run owns a session, so a
  // SIGINT/SIGTERM mid-run (e.g. a command/CI timeout) still tombstones the
  // scratch events and closes the session before exit — no permanent stray state.
  registerSignalCleanup(teardownWorkspaceArtifacts);

  try {
    stages.push({
      name: 'daemon',
      status: 'pass',
      detail: `booted on ${daemon.socketPath}`,
    });

    // Register a throwaway lead session.
    session = await openSessionClient(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: `agentmonitors-verify-${token}`,
        workspacePath: workspace,
      }),
      daemon.socketPath,
    );
    stages.push({
      name: 'session',
      status: 'pass',
      detail: `registered lead session ${session.id}`,
    });

    // Baseline: wait for the monitor's first observation to land.
    inFlightStage = 'baseline';
    const baselineDeadline = Date.now() + budget.baselineMs;
    const baseline = await pollUntil(
      baselineDeadline,
      daemon,
      async () => {
        const rows = await listObservationHistoryClient(
          { monitorId: monitor.id, workspacePath: workspace, limit: 5 },
          daemon.socketPath,
        );
        return rows.length > 0 ? rows[0] : null;
      },
      () => {
        progress(
          `establishing baseline… ${String(Math.round((Date.now() - startedAt) / 1000))}s (interval ${String(Math.round(budget.intervalMs / 1000))}s)`,
        );
      },
    );
    if (!baseline) {
      stages.push({
        name: 'baseline',
        status: 'fail',
        detail: `no observation within ${String(Math.round(budget.baselineMs / 1000))}s`,
      });
      return finalize({
        ok: false,
        stages,
        failure: {
          kind: 'budget-exceeded',
          message: `the monitor produced no observation within the baseline budget (${String(Math.round(budget.baselineMs / 1000))}s) — the daemon may not be evaluating it (check \`agentmonitors monitor test\`).`,
        },
      });
    }
    stages.push({
      name: 'baseline',
      status: 'pass',
      detail: 'first observation recorded',
    });

    // Trigger the change. `observeFrom` marks the start of the observe window
    // and is captured AFTER `fire()` returns for non-manual modes: in
    // `--trigger-cmd` mode, `fire()` is a blocking `execSync` that can run for
    // seconds, and a timestamp taken before it returns would (a) wrongly
    // exclude a same-window daemon observation whose `createdAt` falls between
    // the two timestamps from the post-trigger filter below, and (b) shorten
    // the detect deadline by however long the command itself took to run.
    // Manual mode has no `fire()` to wait on, so its semantics are unchanged.
    let observeFrom: number;
    if (mode === 'manual') {
      observeFrom = Date.now();
      progress(
        `make a REAL change now to something this monitor watches — waiting up to ${String(Math.round(detectCapMs / 1000))}s… ` +
          `(this blocks and does NOT read stdin; a call-and-return agent should use --trigger-cmd '<shell>' instead)`,
      );
      trigger = null;
      stages.push({
        name: 'trigger',
        status: 'skip',
        detail: 'manual — waiting for your change',
      });
    } else if (mode === 'command') {
      // triggerCmd is defined whenever mode === 'command'.
      trigger = buildCommandTrigger(triggerCmd ?? '', workspace, detectCapMs);
      try {
        trigger.fire();
      } catch (error) {
        if (error instanceof TriggerCommandFailed) {
          stages.push({
            name: 'trigger',
            status: 'fail',
            detail: 'trigger command failed',
          });
          return finalize({
            ok: false,
            stages,
            failure: { kind: 'setup', message: error.message },
          });
        }
        throw error;
      }
      observeFrom = Date.now();
      stages.push({
        name: 'trigger',
        status: 'pass',
        detail: trigger.describe,
      });
    } else {
      trigger = buildAutoTrigger(monitor, workspace, token);
      if (!trigger) {
        stages.push({
          name: 'trigger',
          status: 'fail',
          detail: 'no watch.globs to auto-trigger',
        });
        return finalize({
          ok: false,
          stages,
          failure: {
            kind: 'setup',
            message: `cannot auto-trigger this monitor (no usable watch.globs). Re-run with --manual and make the change yourself.`,
          },
        });
      }
      registerRevert(trigger);
      trigger.fire();
      observeFrom = Date.now();
      stages.push({
        name: 'trigger',
        status: 'pass',
        detail: trigger.describe,
      });
    }

    // Observe: wait for a post-trigger outcome. The predicate RETURNS the
    // decisive outcome (rather than setting a side-effect variable) so the
    // branch below reads a plain value — 'triggered' (success) or a definitive
    // fail-fast 'no-change'/'no-files-matched' (the trigger did nothing).
    inFlightStage = 'observe';
    const detectDeadline = observeFrom + detectCapMs;
    const observed = await pollUntil<
      'triggered' | 'no-change' | 'no-files-matched'
    >(
      detectDeadline,
      daemon,
      async () => {
        const rows = await listObservationHistoryClient(
          { monitorId: monitor.id, workspacePath: workspace, limit: 10 },
          daemon.socketPath,
        );
        const post = rows.filter((r) => toMs(r.createdAt) > observeFrom);
        if (post.some((r) => r.result === 'triggered')) return 'triggered';
        // A post-trigger `no-files-matched` is always definitive: the glob
        // scope resolved to zero files, so nothing could ever be observed.
        if (
          mode !== 'manual' &&
          post.some((r) => r.result === 'no-files-matched')
        ) {
          return 'no-files-matched';
        }
        // A post-trigger `no-change` normally means the change wasn't
        // observable — but NOT while a debounce/throttle notify window is
        // settling. There the change WAS observed (recorded as a `suppressed`
        // row that holds the batch) and the emitting `triggered` row only
        // appears at flush; the intervening `no-change` ticks are settling
        // noise, not a verdict. So only fail-fast on `no-change` when no
        // post-trigger `suppressed` row is present; otherwise keep polling
        // until the flush (or the budget) — 002 §9.2/§9.3.
        if (
          mode !== 'manual' &&
          post.some((r) => r.result === 'no-change') &&
          !post.some((r) => r.result === 'suppressed')
        ) {
          return 'no-change';
        }
        return null;
      },
      () => {
        progress(
          `waiting for the change to be observed… ${String(Math.round((Date.now() - observeFrom) / 1000))}s / ~${String(Math.round(detectCapMs / 1000))}s`,
        );
      },
    );

    if (observed === 'no-change' || observed === 'no-files-matched') {
      stages.push({
        name: 'observe',
        status: 'fail',
        detail:
          observed === 'no-files-matched'
            ? 'no files matched the glob'
            : 'no change detected',
      });
      const noChangeGuidance =
        mode === 'command'
          ? `the --trigger-cmd ran but did not change what this monitor observes. Make sure the command causes a change the monitor detects (e.g. for a command-poll watching \`git status --porcelain\`, a \`--trigger-cmd\` that actually creates or edits a file).`
          : `the trigger did not change what this monitor observes (the scratch file may not match watch.globs). Re-run with --manual and edit a matching file yourself, or pass --trigger-cmd '<shell>' to have verify make the change itself.`;
      const guidance =
        observed === 'no-files-matched'
          ? `the monitor's globs matched no files. Check watch.globs / watch.cwd, or re-run with --manual.`
          : noChangeGuidance;
      return finalize({
        ok: false,
        stages,
        failure: { kind: observed, message: guidance },
      });
    }
    if (observed !== 'triggered') {
      stages.push({
        name: 'observe',
        status: 'fail',
        detail: `no change observed within ${String(Math.round(detectCapMs / 1000))}s`,
      });
      return finalize({
        ok: false,
        stages,
        failure: {
          kind: 'budget-exceeded',
          message: `no change was observed within the budget (${String(Math.round(detectCapMs / 1000))}s). ${budgetExceededHint(mode)}`,
        },
      });
    }
    stages.push({
      name: 'observe',
      status: 'pass',
      detail: 'change detected (triggered)',
    });

    // Materialize: confirm an unread event exists for the session.
    inFlightStage = 'materialize';
    const event = await pollUntil(detectDeadline, daemon, async () => {
      const events = await listEventsClient(
        {
          sessionId: session?.id ?? '',
          unreadOnly: true,
          workspacePath: workspace,
        },
        daemon.socketPath,
      );
      return events.length > 0 ? events.length : null;
    });
    if (!event) {
      stages.push({
        name: 'materialize',
        status: 'fail',
        detail: 'no event materialized',
      });
      return finalize({
        ok: false,
        stages,
        failure: {
          kind: 'budget-exceeded',
          message: `the change was detected but no event materialized for the session within the budget (a notify settle window may still be holding it).`,
        },
      });
    }
    stages.push({
      name: 'materialize',
      status: 'pass',
      detail: `${String(event)} unread event(s)`,
    });

    // Deliver via the real hook-deliver claim path.
    const lifecycle = deliveryLifecycleForUrgency(
      monitor.frontmatter.urgency as Urgency,
    );
    const hookEventName =
      lifecycle === 'turn-interruptible' ? 'UserPromptSubmit' : 'SessionStart';
    inFlightStage = 'deliver';
    const additionalContext = await pollUntil(
      detectDeadline,
      daemon,
      async () => {
        const rendered = await claimAndRender(
          session?.id ?? '',
          lifecycle,
          daemon.socketPath,
          hookEventName,
        );
        return rendered ?? null;
      },
      () => {
        progress(
          lifecycle === 'turn-interruptible'
            ? `awaiting high-urgency claim-settle window…`
            : `claiming delivery…`,
        );
      },
    );
    if (!additionalContext) {
      stages.push({
        name: 'deliver',
        status: 'fail',
        detail: 'claim surfaced nothing',
      });
      return finalize({
        ok: false,
        stages,
        failure: {
          kind: 'delivery-empty',
          message: `the event materialized but the real hook-deliver claim (${lifecycle}) surfaced nothing within the budget.`,
        },
      });
    }
    stages.push({
      name: 'deliver',
      status: 'pass',
      detail: `claimed at ${lifecycle}`,
    });

    // #407/#414: the workspace daemon outlives this run, so verify's own trigger
    // file's create/delete events would otherwise reach a later session — its
    // teardown deletion is observed as a real change and delivered first, ahead of
    // the user's actual change. Erase them NOW, scoped to verify's OWN object, via
    // whichever mechanism is safe for that object (see {@link TriggerCleanup}): the
    // synthetic scratch sibling uses the non-blocking durable tombstone (#414); a
    // real watched file verify created uses the id-scoped retract (#407). Isolated
    // mode needs none of this (its daemon + db are torn down); a pre-existing file
    // verify merely edits is `cleanup: 'none'` and never touched.
    if (useWorkspaceDaemon && trigger && trigger.cleanup !== 'none') {
      await cleanupScratchEvents(trigger, monitor.id, workspace, daemon, {
        ttlMs: suppressTtlMs,
        retractWaitMs: detectCapMs,
      });
      scratchEventsRetracted = true;
    }
    return finalize({ ok: true, stages, additionalContext });
  } catch (error) {
    if (error instanceof DaemonDied) {
      // Mark the stage that was actually in flight when the daemon died (not the
      // last completed one), then report the daemon's own error.
      appendDaemonCrashStage(stages, inFlightStage);
      return finalize({
        ok: false,
        stages,
        failure: {
          kind: 'daemon-died',
          message: `the daemon exited (code ${error.code === null ? 'null' : String(error.code)}) before delivery completed.`,
        },
        daemonStderr: error.daemonStderr,
      });
    }
    throw error;
  } finally {
    if (trigger) trigger.revert();
    // #407/#414 crash-safety: on the happy path the cleanup above already ran
    // (scratchEventsRetracted); if an error interrupted the run AFTER the scratch
    // events materialized on the PERSISTENT daemon but before that, teardown runs
    // the same object-appropriate cleanup now (tombstone for the synthetic scratch
    // key; id-scoped retract for a real created file) so they never linger for a
    // later session. The one residual is a daemon death after materialization (the
    // socket call fails); the daemon's own reap backstop then cleans it up on the
    // next tick — documented in 005 §16.
    await teardownWorkspaceArtifacts();
    // Disarm the module-level signal cleanup so a later run (or a stray signal
    // after this run returns) never acts on this run's now-closed session.
    clearSignalCleanup();
  }
}

/**
 * Claim + render exactly as `hook deliver` does after resolving a session
 * (issue #442, PR #442 round-9 review): reuses the SAME shared
 * reserve → validate-fit → render → commit flow
 * (`reserveRenderAndCommitHookDelivery`, `hook.ts`) `hook deliver` itself
 * calls — including the post-reservation candidate-growth check
 * (`reserveSizedHookDelivery`'s `settledWorkRemainsBeyondClaim`) — rather than
 * a bespoke preview → direct `claimDeliveryClient` → render sequence of its
 * own. Before this fix, `verify` could pass even when the production
 * claimed-set-equals-rendered-set contract (§5.5) was violated: a
 * substitution race between `verify`'s own preview and its direct claim could
 * replace the previewed events with larger blocks under the same count,
 * durably claim all the replacements, and let the renderer silently omit
 * already-claimed blocks — exactly the bug `reserveSizedHookDelivery` exists
 * to close on the real hook path. Returns the rendered `additionalContext`,
 * or null when nothing surfaces. The commit happens only after this function
 * has captured the rendered output (never before), mirroring `hook deliver`'s
 * own render-before-commit ordering.
 */
async function claimAndRender(
  sessionId: string,
  lifecycle: 'turn-interruptible' | 'post-compact',
  socketPath: string,
  hookEventName: string,
): Promise<string | null> {
  const flow = await reserveRenderAndCommitHookDelivery(
    sessionId,
    lifecycle,
    socketPath,
    hookEventName,
  );
  if (!flow) return null;
  const additionalContext =
    flow.output?.hookSpecificOutput.additionalContext ?? null;
  await flow.commit();
  return additionalContext;
}

/**
 * Route verify's trigger to the cleanup mechanism that is SAFE for its object
 * (issue #418), the single seam that keeps the two mechanisms' domains from
 * overlapping (see {@link TriggerCleanup}):
 *
 * - `'tombstone'` → {@link suppressScratchEvents} (synthetic scratch key,
 *   non-blocking). If the daemon predates the `events.suppressObject` verb (a
 *   version-skewed `--use-workspace-daemon` target), it answers "unsupported"; we
 *   degrade to the id-scoped retract rather than failing an otherwise-successful
 *   run — cheap now that the daemon stays alive (issue #418). Any OTHER error
 *   propagates.
 * - `'retract-by-id'` → {@link retractScratchEventsById} (real watched path verify
 *   created; retract only the exact observed ids).
 */
async function cleanupScratchEvents(
  trigger: Trigger,
  monitorId: string,
  workspace: string,
  daemon: IsolatedDaemon,
  opts: { ttlMs: number; retractWaitMs: number },
): Promise<void> {
  if (trigger.cleanup === 'tombstone') {
    try {
      await suppressScratchEvents(
        trigger,
        monitorId,
        workspace,
        daemon,
        opts.ttlMs,
      );
      return;
    } catch (error) {
      if (!(error instanceof DaemonUnsupportedRequestError)) throw error;
      progress(
        'daemon predates suppressObject; retracting scratch events by id…',
      );
      // Fall through to the id-scoped retract below (the file is already deleted).
    }
  }
  await retractScratchEventsById(
    trigger,
    monitorId,
    workspace,
    daemon,
    Date.now() + opts.retractWaitMs,
  );
}

/**
 * Erase the events verify's own SYNTHETIC scratch file produced against a
 * PERSISTENT workspace daemon (issue #407/#414). Deletes the scratch file, then in
 * ONE non-blocking IPC call retracts the (already-delivered) create event AND
 * installs a durable, self-expiring tombstone so the daemon auto-retracts the
 * file's pending `File deleted: agentmonitors-verify-…` on the very tick it
 * materializes — before any later session can observe it.
 *
 * This deliberately does NOT wait for the deletion to re-materialize (the #407
 * approach, which cost a whole extra poll interval + settle and doubled verify's
 * `--use-workspace-daemon` runtime — issue #414). The tombstone is scoped to
 * verify's OWN synthetic scratch key (`…/agentmonitors-verify-<token><ext>`),
 * which no real monitored object ever shares, so the daemon-side by-key sweep can
 * only ever erase verify's artifacts, never a real event at a genuine path. It is
 * therefore used ONLY for a `cleanup: 'tombstone'` trigger — a literal watched
 * file verify created goes through {@link retractScratchEventsById} instead.
 */
async function suppressScratchEvents(
  trigger: Trigger,
  monitorId: string,
  workspace: string,
  daemon: IsolatedDaemon,
  ttlMs: number,
): Promise<void> {
  const { objectKey } = trigger;
  // Delete the scratch file (idempotent — the `finally` revert becomes a no-op).
  trigger.revert();
  progress('cleaning up the verify artifact and suppressing its events…');
  await suppressObjectEventsClient(
    { monitorId, objectKey, ttlMs, workspacePath: workspace },
    daemon.socketPath,
  );
}

/**
 * Erase the events verify's own trigger produced when its `objectKey` is a REAL
 * watched path (a literal single-file glob whose file verify created — issue
 * #407/#418). Deletes the file, WAITS for the daemon to materialize the deletion
 * event (so this monitor's rows for the object now number both a create and a
 * delete), then retracts by those exact observed ids.
 *
 * The wait costs a poll interval — the very cost #414's tombstone avoids — but it
 * is unavoidable here: a by-key sweep at a real path would eat a LATER genuine
 * event at that same path within the tombstone window, so a durable tombstone is
 * unsafe. Deleting only the observed ids bounds the blast radius to verify's own
 * two events and can never touch a real event that merely shares the path. This
 * rare case (verify creating a literal watched file that didn't exist) is the only
 * one that pays the wait; the common scratch-sibling case stays non-blocking.
 *
 * Best-effort on the wait: if the deletion is not observed within the budget the
 * create event is still retracted, so at minimum the create never lingers.
 */
async function retractScratchEventsById(
  trigger: Trigger,
  monitorId: string,
  workspace: string,
  daemon: IsolatedDaemon,
  deadline: number,
): Promise<void> {
  const { objectKey } = trigger;
  // Delete the file (idempotent — the `finally` revert becomes a no-op).
  trigger.revert();
  progress('cleaning up the verify artifact and retracting its events…');
  const settled = await pollUntil<MonitorEventRecord[]>(
    deadline,
    daemon,
    async () => {
      const events = await listEventsClient(
        { monitorId, objectKey, workspacePath: workspace },
        daemon.socketPath,
      );
      return events.length >= 2 ? events : null;
    },
  );
  const observed =
    settled ??
    (await listEventsClient(
      { monitorId, objectKey, workspacePath: workspace },
      daemon.socketPath,
    ));
  const eventIds = observed.map((event) => event.id);
  if (eventIds.length === 0) return;
  await retractObjectEventsClient(
    { monitorId, objectKey, eventIds, workspacePath: workspace },
    daemon.socketPath,
  );
}

/** Reverts registered for crash-safe cleanup (SIGINT/SIGTERM). */
const pendingReverts = new Set<Trigger>();
// The current run's async teardown (retract+tombstone scratch events, close the
// verify session), run best-effort on a caught signal before exit (issue #414).
let asyncSignalCleanup: (() => Promise<void>) | null = null;
let signalsInstalled = false;
// Cap how long a caught signal waits on the async daemon cleanup, so a wedged
// daemon can never hang process exit.
const SIGNAL_CLEANUP_TIMEOUT_MS = 4_000;

function installSignalHandlers(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const handler = (): void => {
    // Sync file reverts first — guaranteed fast, so the scratch file is gone even
    // if the daemon IPC below hangs or the process is force-killed next.
    for (const t of pendingReverts) {
      try {
        t.revert();
      } catch {
        /* best-effort */
      }
    }
    const cleanup = asyncSignalCleanup;
    if (!cleanup) {
      process.exit(130);
      return;
    }
    // Best-effort async cleanup (tombstone scratch events, close the verify
    // session) so a signal-killed --use-workspace-daemon run leaves no permanent
    // stray state (issue #414), bounded so it can never hang exit.
    void Promise.race([
      cleanup().catch(() => undefined),
      delay(SIGNAL_CLEANUP_TIMEOUT_MS),
    ]).finally(() => {
      process.exit(130);
    });
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

function registerRevert(trigger: Trigger): void {
  pendingReverts.add(trigger);
  installSignalHandlers();
}

/** Arm the run's async signal teardown (issue #414). */
function registerSignalCleanup(cleanup: () => Promise<void>): void {
  asyncSignalCleanup = cleanup;
  installSignalHandlers();
}

/** Disarm the async signal teardown once a run has cleaned up (issue #414). */
function clearSignalCleanup(): void {
  asyncSignalCleanup = null;
  pendingReverts.clear();
}

export const verifyCommand = new Command('verify')
  .description(
    'Prove a monitor delivers end-to-end: boot, trigger a real change, confirm delivery',
  )
  .argument(
    '[monitor]',
    'Monitor id to verify (defaults to the sole monitor in the workspace)',
  )
  .option(
    '--dir <path>',
    'Directory containing monitor definitions (defaults to <workspace>/.claude/monitors)',
  )
  .option(
    '--workspace <path>',
    'Workspace path (defaults to the current working directory)',
    process.cwd(),
  )
  .option(
    '--manual',
    'Skip auto-trigger; prompt you to make the change and watch for it (blocks; does not read stdin)',
  )
  .option(
    '--trigger-cmd <shell>',
    "Decoupled trigger: after baseline, verify runs this shell command itself to cause the watched change, then observes/materializes/delivers — a single self-contained run for a source it can't auto-trigger (command-poll, api-poll, schedule, incoming-changes)",
  )
  .option(
    '--use-workspace-daemon',
    "Run against the workspace's real daemon/db (leaves it running so a follow-up `doctor` is green) instead of an isolated one",
  )
  .option(
    '--timeout-ms <ms>',
    'Override the post-trigger detection budget in milliseconds; default is derived from the monitor interval + settle',
  )
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (
      monitorArg: string | undefined,
      options: {
        dir?: string;
        workspace: string;
        manual?: boolean;
        triggerCmd?: string;
        useWorkspaceDaemon?: boolean;
        timeoutMs?: string;
        format: string;
      },
    ) => {
      const json = options.format === 'json';
      const workspace = path.resolve(options.workspace);
      const monitorsDir = options.dir
        ? path.resolve(options.dir)
        : path.join(workspace, '.claude', 'monitors');

      // --manual and --trigger-cmd are mutually exclusive: one waits for an
      // out-of-band change, the other makes the change itself. An empty
      // --trigger-cmd is a mistake, not a no-op trigger.
      if (options.manual === true && options.triggerCmd !== undefined) {
        reportError(
          'Pass either --manual or --trigger-cmd, not both: --manual waits for you to make the change, --trigger-cmd makes it for you.',
          json,
        );
        return;
      }
      if (options.triggerCmd?.trim().length === 0) {
        reportError('--trigger-cmd requires a non-empty shell command.', json);
        return;
      }

      let daemon: IsolatedDaemon | undefined;
      try {
        const monitor = await resolveMonitor(monitorsDir, monitorArg);

        // The source must be registered (else the daemon can never observe it).
        const registry = new SourceRegistry();
        registerCoreSources(registry);
        if (!registry.get(monitor.frontmatter.watch.type)) {
          throw new VerifySetupError(
            `Unknown source "${monitor.frontmatter.watch.type}" for monitor "${monitor.id}". Available: ${registry.names().join(', ')}.`,
          );
        }

        const budget = computeVerifyBudget(monitor);
        const overrideMs = options.timeoutMs
          ? Number(options.timeoutMs)
          : undefined;
        const detectCapMs =
          overrideMs !== undefined &&
          Number.isFinite(overrideMs) &&
          overrideMs > 0
            ? overrideMs
            : budget.detectMs;

        daemon = options.useWorkspaceDaemon
          ? await useWorkspaceDaemon(monitorsDir, workspace)
          : await bootIsolatedDaemon(monitorsDir, workspace);

        const result = await runVerification({
          monitor,
          workspace,
          daemon,
          budget,
          detectCapMs,
          manual: options.manual === true,
          useWorkspaceDaemon: options.useWorkspaceDaemon === true,
          triggerCmd: options.triggerCmd,
        });

        console.log(json ? renderVerifyJson(result) : renderVerifyText(result));
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        if (error instanceof DaemonDied) {
          // Boot-time crash: surface the daemon's own error (issue #398).
          const result: VerifyResult = {
            ok: false,
            monitorId: monitorArg ?? '(unresolved)',
            stages: [
              { name: 'daemon', status: 'fail', detail: 'failed to boot' },
            ],
            failure: {
              kind: 'daemon-died',
              message: `the daemon exited (code ${error.code === null ? 'null' : String(error.code)}) during boot.`,
            },
            daemonStderr: error.daemonStderr,
            elapsedMs: 0,
          };
          console.log(
            json ? renderVerifyJson(result) : renderVerifyText(result),
          );
          process.exitCode = 1;
        } else {
          const message =
            error instanceof Error ? error.message : String(error);
          reportError(message, json);
        }
      } finally {
        if (daemon) await daemon.teardown();
      }
    },
  );
