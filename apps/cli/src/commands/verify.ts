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
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Command, Option } from 'commander';
import {
  claudeCodeAdapter,
  scanMonitors,
  SourceRegistry,
  type AgentSessionRecord,
  type DeliveryClaim,
  type MonitorDefinition,
  type MonitorEventRecord,
  type Urgency,
} from '@agentmonitors/core';
import { reportError } from '../output.js';
import { registerCoreSources } from '../sources.js';
import { cliEntry } from '../detached-spawn.js';
import { spawnDetachedDaemon } from '../detached-spawn.js';
import { daemonAvailable, resolveSocketPath } from '../daemon-ipc.js';
import { readLocalState } from '../local-state.js';
import { resolveManualDaemonSocketPath } from '../manual-daemon.js';
import { resolveWorkspaceDbPath } from '../workspace-db-path.js';
import {
  claimDeliveryClient,
  closeSessionClient,
  listEventsClient,
  listObservationHistoryClient,
  openSessionClient,
  previewSettledHighDeliveryClient,
  retractObjectEventsClient,
} from '../runtime-client.js';
import {
  packEventsUnderCap,
  renderHookDelivery,
} from '../hook-deliver-render.js';
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
   * retraction to erase those events after the run (issue #407).
   */
  objectKey: string;
  /**
   * True when verify itself brought this file into existence (a scratch sibling,
   * or a literal watched file that did not exist) and removes it on revert — so
   * BOTH its create and its delete events are pure verify artifacts, safe to
   * retract wholesale. False when editing a pre-existing watched file, whose
   * events reference real user content and must never be retracted.
   */
  synthetic: boolean;
}

const PROGRESS_INTERVAL_MS = 2_500;
const POLL_INTERVAL_MS = 300;
const BOOT_TIMEOUT_MS = 15_000;
// Short budget for the crash-safety retraction in `finally` (#407): unlike the
// happy-path retraction (which waits the full detect cap to catch the delete
// event), the teardown pass only tries briefly to catch whatever materialized
// before retracting it, so a failed run's cleanup never blocks for long.
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
      synthetic: true,
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
    // A file verify *created* (did not exist before) is a pure artifact — safe
    // to retract. A pre-existing file that verify edits and restores is real
    // user content; its events must not be retracted.
    synthetic: !existed,
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
}

/** The core orchestration once a monitor is resolved and a daemon is reachable. */
async function runVerification(opts: RunOptions): Promise<VerifyResult> {
  const { monitor, workspace, daemon, budget, detectCapMs, manual } = opts;
  const { useWorkspaceDaemon } = opts;
  const startedAt = Date.now();
  const stages: Stage[] = [];
  const token = randomBytes(6).toString('hex');
  let session: AgentSessionRecord | undefined;
  let trigger: Trigger | null = null;
  // #407: set once the scratch object's events have been retracted, so the
  // crash-safety pass in `finally` skips the work (and its wait) on the happy
  // path and only runs when an error interrupted the run before retraction.
  let scratchEventsRetracted = false;
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

    // Trigger the change.
    const triggerAt = Date.now();
    if (manual) {
      progress(
        `make a REAL change now to something this monitor watches — waiting up to ${String(Math.round(detectCapMs / 1000))}s…`,
      );
      trigger = null;
      stages.push({
        name: 'trigger',
        status: 'skip',
        detail: 'manual — waiting for your change',
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
    const detectDeadline = triggerAt + detectCapMs;
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
        const post = rows.filter((r) => toMs(r.createdAt) > triggerAt);
        if (post.some((r) => r.result === 'triggered')) return 'triggered';
        // A post-trigger `no-files-matched` is always definitive: the glob
        // scope resolved to zero files, so nothing could ever be observed.
        if (!manual && post.some((r) => r.result === 'no-files-matched')) {
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
          !manual &&
          post.some((r) => r.result === 'no-change') &&
          !post.some((r) => r.result === 'suppressed')
        ) {
          return 'no-change';
        }
        return null;
      },
      () => {
        progress(
          `waiting for the change to be observed… ${String(Math.round((Date.now() - triggerAt) / 1000))}s / ~${String(Math.round(detectCapMs / 1000))}s`,
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
      const guidance =
        observed === 'no-files-matched'
          ? `the monitor's globs matched no files. Check watch.globs / watch.cwd, or re-run with --manual.`
          : `the trigger did not change what this monitor observes (the scratch file may not match watch.globs). Re-run with --manual and edit a matching file yourself.`;
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
          message: `no change was observed within the budget (${String(Math.round(detectCapMs / 1000))}s). ${manual ? 'Did you make a change the monitor watches?' : 'Increase --timeout-ms if the interval is long, or check the monitor with `agentmonitors monitor explain`.'}`,
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

    // #407: the workspace daemon outlives this run, so the scratch file's
    // create/delete events would otherwise reach a later session — its teardown
    // deletion is observed as a real change and delivered first, ahead of the
    // user's actual change. Retract both events now, scoped to verify's OWN
    // synthetic object. Isolated mode needs none of this: its daemon + db are
    // torn down. A non-synthetic trigger (verify editing a real watched file) is
    // never retracted — those events reference real user content.
    if (useWorkspaceDaemon && trigger?.synthetic) {
      await retractScratchEvents(
        trigger,
        monitor.id,
        workspace,
        daemon,
        Date.now() + detectCapMs,
      );
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
    // #407 crash-safety: the happy-path retraction above runs only once the run
    // reaches delivery. If an error interrupted the run AFTER the scratch object's
    // events materialized on the PERSISTENT daemon but before that retraction,
    // they would otherwise linger for a later session. Best-effort clean them up
    // here too, on a short budget. This closes the common interruption window but
    // NOT a daemon death after materialization: with the daemon gone the socket
    // call fails and the artifact persists until the next observation reconciles
    // it — a residual documented in 005 §16.
    if (useWorkspaceDaemon && trigger?.synthetic && !scratchEventsRetracted) {
      try {
        await retractScratchEvents(
          trigger,
          monitor.id,
          workspace,
          daemon,
          Date.now() + TEARDOWN_RETRACT_WAIT_MS,
        );
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
  }
}

/**
 * Claim + render exactly as `hook deliver` does after resolving a session
 * (hook.ts): for `turn-interruptible` preview the settled high events, pack how
 * many fit under the cap, and claim exactly that many; otherwise take the plain
 * claim. Returns the rendered `additionalContext`, or null when nothing surfaces.
 */
async function claimAndRender(
  sessionId: string,
  lifecycle: 'turn-interruptible' | 'post-compact',
  socketPath: string,
  hookEventName: string,
): Promise<string | null> {
  let claim: DeliveryClaim | null;
  let moreDeferred = false;
  if (lifecycle === 'turn-interruptible') {
    const highPreview = await previewSettledHighDeliveryClient(
      sessionId,
      socketPath,
    );
    if (highPreview.length > 0) {
      const fit = packEventsUnderCap(highPreview);
      claim = await claimDeliveryClient(sessionId, lifecycle, socketPath, fit);
      moreDeferred = fit < highPreview.length;
    } else {
      claim = await claimDeliveryClient(sessionId, lifecycle, socketPath);
    }
  } else {
    claim = await claimDeliveryClient(sessionId, lifecycle, socketPath);
  }
  const output = renderHookDelivery(claim, hookEventName, { moreDeferred });
  return output?.hookSpecificOutput.additionalContext ?? null;
}

/**
 * Retract the events verify's own scratch file produced against a PERSISTENT
 * workspace daemon (issue #407). Deletes the scratch file now, waits (bounded by
 * `deadline`) for the daemon to materialize the resulting deletion event — the
 * object's second event, after the create — then retracts the EXACT events it
 * observed for the scratch path (by their ids), across all sessions, so no later
 * session sees a spurious `File deleted: agentmonitors-verify-…` ahead of the
 * user's real change.
 *
 * Two scoping guards keep this from over-reaching (issue #407 review):
 *  - The wait query and the retraction are scoped to `monitorId`, so a second,
 *    broader monitor also watching this path can't satisfy the `>= 2` signal
 *    early (retracting before the target's own delete has landed), nor have its
 *    events swept.
 *  - The retraction deletes by the observed event IDS, never a `(monitor, path)`
 *    sweep, so a real, pre-existing event at the same watched path (e.g. an
 *    earlier unacked delete on a literal-glob monitor) is left intact.
 *
 * Best-effort on the wait: if the deletion is not observed within the budget the
 * create event is still retracted (so at minimum the create never lingers). The
 * count-based signal (a second event for this object) is decoupled from the
 * source's event title/payload shape and immune to timestamp granularity.
 */
async function retractScratchEvents(
  trigger: Trigger,
  monitorId: string,
  workspace: string,
  daemon: IsolatedDaemon,
  deadline: number,
): Promise<void> {
  const { objectKey } = trigger;
  // Delete the scratch file (idempotent — the `finally` revert becomes a no-op).
  trigger.revert();
  progress('cleaning up the verify artifact and retracting its events…');
  // Wait until the daemon has observed the deletion and materialized its event
  // (this monitor's rows for the object now number both a create and a delete),
  // so the retract erases both. Capture the observed events so we retract by
  // their exact ids. On timeout, fall through and retract whatever exists now.
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
let signalsInstalled = false;
function registerRevert(trigger: Trigger): void {
  pendingReverts.add(trigger);
  if (signalsInstalled) return;
  signalsInstalled = true;
  const handler = (): void => {
    for (const t of pendingReverts) {
      try {
        t.revert();
      } catch {
        /* best-effort */
      }
    }
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
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
    'Skip auto-trigger; prompt you to make the change and watch for it',
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
