/** Execute finite, self-bounding command observations with optional durable ownership and shutdown cancellation. */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import type {
  CommandProcessOwner,
  JsonSchema,
  KeyedCollectionConfig,
  KeyedSnapshot,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
  SignalTarget,
} from '@agentmonitors/core';
import {
  OPERATION_TIMEOUT_PATTERN,
  diffKeyedCollection,
  displayObjectKey,
  parseKeyedCollectionConfig,
  parseOperationTimeoutMs,
  sendVerifiedSignal,
  spawnedProcessGroup,
} from '@agentmonitors/core';

import {
  LAUNCHER_PROGRAM,
  WATCHDOG_PROGRAM,
  monotonicNowMs,
} from './self-bound.js';

// Re-exported so API Extractor can resolve the default export's type — and
// the core types its interface shape transitively references — from this
// package's own entry point, instead of flagging ae-forgotten-export
// warnings in the checked-in API report.
export type {
  ChangeKind,
  CommandProcessOwner,
  JsonSchema,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
  Urgency,
} from '@agentmonitors/core';

/**
 * Change-detection strategies (003 §11.3). `text-diff` is the default; `exit-code`
 * is first-class in v1.
 */
type ChangeStrategy = 'text-diff' | 'json-diff' | 'exit-code';

/** Grace period between SIGTERM and SIGKILL on timeout (003 §11.2). */
const SIGKILL_GRACE_MS = 5_000;

/** Maximum retained stdout, in bytes (003 §11.2). Excess is drained, not kept. */
const STDOUT_CAP_BYTES = 1024 * 1024;

/** Number of trailing stderr characters retained for failure diagnostics (003 §11.5). */
const STDERR_TAIL_CHARS = 2000;

/**
 * Maximum retained stderr, in bytes — bounded independently of `STDOUT_CAP_BYTES`
 * (003 §11.2, issue #302). Sized generously above `STDERR_TAIL_CHARS` (4 bytes/char
 * worst case for UTF-8) so the final tail slice is never short on multi-byte input,
 * while still being a small, fixed bound regardless of how much stderr the child
 * writes — a pathological volume of stderr can never grow this process's own memory
 * unbounded, and (like stdout) never causes the child to be killed.
 */
const STDERR_RETENTION_CAP_BYTES = STDERR_TAIL_CHARS * 4;

interface ScopeConfig {
  command: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  timeoutMs: number;
  objectKey: string;
  strategy: ChangeStrategy;
  /**
   * Top-level `change-detection.ignore-paths` entries for plain `json-diff`
   * output comparison. Collection-specific ignores remain inside `collection`.
   */
  ignorePaths: string[];
  /** Keyed-collection config (003 §12), present only under `strategy: json-diff`. */
  collection: KeyedCollectionConfig | undefined;
}

/**
 * Persisted per-monitor state (003 §11.4–§11.5).
 *
 * `stdout`/`exitCode` hold the last **successful** result baseline; they are kept
 * untouched across failing ticks so a recovery can diff against the pre-failure
 * baseline. `health` tracks the transition edge so health observations fire only
 * on `ok ↔ failing`. `baselined` records whether a successful baseline has ever been
 * established — a failing-first-run state is `baselined: false` (no output to diff),
 * per "a failing first run establishes no baseline". `env` is never stored here
 * (003 §11.1).
 */
interface CommandState {
  stdout: string;
  exitCode: number;
  truncated: boolean;
  health: 'ok' | 'failing';
  baselined: boolean;
  /**
   * The keyed-collection snapshot from the previous successful cycle (003 §12),
   * present only when the monitor uses `change-detection.collection`. Carried
   * forward untouched across failing ticks so a recovery diffs against the
   * pre-failure keyed baseline.
   */
  keyedSnapshot?: KeyedSnapshot;
}

interface ExecResult {
  stdout: string;
  exitCode: number;
  truncated: boolean;
}

/** Outcome of one spawn: either a result (003 §11.2) or an execution failure (003 §11.5). */
type ExecOutcome =
  | { kind: 'result'; result: ExecResult }
  | { kind: 'failure'; error: string; stderrTail: string };

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const command = config['command'];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((c): c is string => typeof c === 'string')
  ) {
    // `command` is argv-only by design — the child is spawned with `shell: false`,
    // so there is no word-splitting/quoting/injection surface (003 §11.1). The most
    // common mistake is writing a shell pipeline as a bare string; point authors at
    // the supported inline form rather than just rejecting it.
    const shellHint =
      typeof command === 'string'
        ? ` A bare string is not run as a shell. For a pipeline or other shell operators, wrap it in argv: ["sh", "-c", ${JSON.stringify(command)}].`
        : ' For a shell pipeline, use the argv form ["sh", "-c", "<pipeline>"].';
    throw new Error(
      `scope.command must be a non-empty array of strings (argv form, e.g. ["git", "status"]).${shellHint}`,
    );
  }

  const cd = config['change-detection'] as
    | { strategy?: string; 'ignore-paths'?: unknown }
    | undefined;
  const rawStrategy = cd?.strategy;
  const strategy: ChangeStrategy =
    rawStrategy === 'json-diff' || rawStrategy === 'exit-code'
      ? rawStrategy
      : 'text-diff';
  const ignorePaths = parseTopLevelIgnorePaths(cd);
  if (ignorePaths.length > 0 && strategy !== 'json-diff') {
    throw new Error(
      'change-detection.ignore-paths requires strategy: json-diff',
    );
  }

  // Keyed-collection mode (003 §12) is only valid under `json-diff`. The generated
  // schema rejects `collection` under other strategies at authoring time (BP3); this
  // is the defence-in-depth guard for the observe path.
  const collection = parseKeyedCollectionConfig(config['change-detection']);
  if (collection && strategy !== 'json-diff') {
    throw new Error('change-detection.collection requires strategy: json-diff');
  }

  const cwd = typeof config['cwd'] === 'string' ? config['cwd'] : undefined;

  const rawEnv = config['env'];
  const env =
    rawEnv !== null &&
    typeof rawEnv === 'object' &&
    !Array.isArray(rawEnv) &&
    Object.values(rawEnv).every((v) => typeof v === 'string')
      ? (rawEnv as Record<string, string>)
      : undefined;

  const timeoutMs = parseOperationTimeoutMs(config['timeout']);

  const key = config['key'];
  const objectKey =
    typeof key === 'string' && key.length > 0 ? key : command.join(' ');

  return {
    command,
    cwd,
    env,
    timeoutMs,
    objectKey,
    strategy,
    ignorePaths,
    collection,
  };
}

/**
 * Bounded wait, after the direct child's own `exit` event, for its stdio streams
 * to `close` before falling back to whatever stdout has been captured so far. A
 * descendant that inherited stdout/stderr (e.g. a backgrounded `sleep` under
 * `sh -c 'sleep 30 & wait'`) can hold those pipes open indefinitely even after the
 * direct child itself has exited — resolving on `close` alone would hang this call
 * forever in that case. This bound only matters when a descendant lingers; a normal
 * command's streams close within milliseconds of `exit`, so it never adds latency
 * in the common case (003 §11.7, issue #303).
 */
const CLOSE_FALLBACK_MS = 2_000;

/**
 * Identity-verified process-tree termination for one escalation step (SIGTERM or
 * SIGKILL). Never sends a signal to an id it cannot positively confirm is still
 * the tree this command started (008 §5): every step goes through core's
 * `sendVerifiedSignal`, and an unconfirmable target is left alone and reported
 * (an abstention, 008 §6.1) instead of signalled.
 *
 * On POSIX, `child` was spawned as the leader of its own process group/session
 * (`detached: true`); signaling the *negative* PID targets that whole group, so a
 * command's own background jobs (`sh -c 'sleep 30 & wait'`) die with it instead of
 * surviving as orphans (003 §11.7, issue #303). The SIGTERM step's read starts
 * while the leader is still unreaped (the timeout only fires for a running
 * command), so that reading's members are confirmed as ours even if the leader
 * exits before the read completes. The gate re-reads the group's membership the
 * moment the leader is reaped, which confirms work forked after the SIGTERM step
 * (a TERM trap that starts a worker and exits), and keeps re-reading it through
 * the grace period, which confirms work one member hands to a newly forked
 * process before exiting. The SIGKILL follow-up usually runs after the leader has
 * been reaped; it is sent if any confirmed member is still in the group, and an
 * emptied group needs no signal. A group none of whose current members was ever
 * confirmed is left alone with an abstention: its continuity is lost, either
 * because a member forked and exited between two readings with no other
 * confirmed member alive (the residual 008 §3.1 names) or because the id was
 * reused, and the two cannot be told apart.
 *
 * Windows has no process-group-signal equivalent, and no reliable graceful signal
 * for a non-console-attached spawned process — `taskkill` without `/F` frequently
 * fails silently for exactly this kind of child. The documented choice (issue #303
 * AC2) is to always use `taskkill /PID <pid> /T /F`: forceful and tree-wide, on both
 * the timeout expiry and the grace follow-up. There is no softer Windows phase to
 * escalate from, so both steps do the same thing — the follow-up is a defensive
 * retry, sent only while the direct child is still unreaped (its pid cannot have
 * been reused); once it has exited there is nothing left the pid can identify.
 *
 * Resolves once the step has finished; never rejects.
 */
async function killProcessTree(
  target: SignalTarget,
  signal: 'SIGTERM' | 'SIGKILL',
  isWindows: boolean,
  action: string,
): Promise<void> {
  const windowsPid =
    target.kind === 'spawned-process' ? target.handle.pid : undefined;
  try {
    await sendVerifiedSignal(target, signal, {
      action,
      // The SIGTERM step keeps confirming the group's membership through the
      // grace period. The SIGKILL step ends that tracking when it starts, which
      // is at most the grace period after the SIGTERM step finishes (its timer
      // is armed before the SIGTERM step's read, and it also waits for that
      // step), so `untilMs` is only a backstop.
      ...(signal === 'SIGTERM' && target.kind === 'spawned-process-group'
        ? { trackMembership: { untilMs: SIGKILL_GRACE_MS } }
        : {}),
      ...(isWindows && windowsPid !== undefined
        ? {
            deliver: () => {
              execFile(
                'taskkill',
                ['/PID', String(windowsPid), '/T', '/F'],
                () => {
                  // Best-effort: a "not found" failure just means the tree already exited.
                },
              );
            },
          }
        : {}),
    });
  } catch {
    // Verification reports its own outcomes; nothing here may break the timer chain.
  }
}

/**
 * The cleanup target for a spawned command: its whole process group on POSIX,
 * the direct child (tree-killed by `taskkill /T`) on Windows. `undefined` when
 * the OS never assigned a pid — nothing was started, so nothing can be signalled.
 */
function cleanupTargetFor(
  child: ChildProcess,
  isWindows: boolean,
): SignalTarget | undefined {
  if (child.pid === undefined) return undefined;
  return isWindows
    ? { kind: 'spawned-process', handle: child }
    : spawnedProcessGroup(child);
}

/**
 * Resolve the child process's effective working directory (003 §11.1).
 *
 * A **relative** `cwd` is resolved against `workspacePath` — the runtime
 * workspace/config root the daemon threads through {@link ObservationContext}
 * for a project monitor — the same base `file-fingerprint` already resolves a
 * relative `cwd` against (003 §3). An **absolute** `cwd` is honored as-is
 * (unchanged from before). When `cwd` is omitted entirely, a project monitor
 * now defaults to `workspacePath` rather than the daemon's own process
 * working directory: a scaffolded `MONITOR.md` that omits `cwd` therefore
 * targets the right directory regardless of where the daemon happens to be
 * launched from, or whether the project was relocated or shared after
 * scaffolding — the daemon always resolves `workspacePath` itself from where
 * `MONITOR.md` was found, never from a value baked into the file (issue #444
 * review, finding 826). A user-level monitor (no `workspacePath`) falls back
 * to the pre-existing default, the daemon's own process working directory —
 * unchanged, since there is no project root to resolve against.
 */
function resolveCwd(
  cwd: string | undefined,
  workspacePath: string | undefined,
): string | undefined {
  if (cwd === undefined) return workspacePath;
  if (path.isAbsolute(cwd)) return cwd;
  return workspacePath === undefined ? cwd : path.resolve(workspacePath, cwd);
}

/**
 * Execute authored argv literally, using an armed POSIX launcher or a direct
 * Windows spawn (`shell: false`), draining
 * stdout and stderr as they stream rather than buffering to completion, enforcing
 * `timeout` with a SIGTERM→SIGKILL escalation targeted at the command's **entire
 * process tree**, not just the direct child (003 §11.2/§11.7, issue #303). A nonzero
 * exit code with output is a **result**, not a failure (003 §11.2/§11.5); spawn
 * failure and timeout are failures. Crucially, neither stream exceeding its
 * retention cap ever kills the child (issue #302) — `data` listeners are attached
 * unconditionally, so the pipe keeps draining and the command always runs to its
 * real completion (side effects and all); the caps only bound what is *kept*, never
 * what is *drained*, so the reported exit code is always the command's actual one.
 */
async function runCommand(
  scope: ScopeConfig,
  effectiveCwd: string | undefined,
  owner?: CommandProcessOwner,
  shutdownSignal?: AbortSignal,
): Promise<ExecOutcome> {
  // Admission is durable before spawn; ordinary in-process execution retains
  // its original inherited-environment path and creates no ownership work.
  const ownershipEnv =
    owner === undefined ? undefined : await owner.environment();
  if (shutdownSignal?.aborted) {
    return {
      kind: 'failure',
      error: 'Command cancelled during shutdown',
      stderrTail: '',
    };
  }
  const inheritedEnv = scope.env
    ? { ...process.env, ...scope.env }
    : process.env;
  // Helpers cannot execute authored Node preloads. The full command environment
  // travels over a private pipe, avoiding argv limits and preserving even NODE_OPTIONS.
  const commandEnv = { ...inheritedEnv, ...ownershipEnv };
  const helperEnv = { ...commandEnv };
  delete helperEnv['NODE_OPTIONS'];
  return new Promise<ExecOutcome>((resolve) => {
    const [file, ...args] = scope.command;
    const isWindows = process.platform === 'win32';
    const deadline = monotonicNowMs() + scope.timeoutMs;
    // The POSIX launcher keeps its PID when it becomes the command. Its in-group
    // watchdog has acknowledged a referenced timer before that replacement.
    const launchArgs = isWindows
      ? args
      : [
          '--disable-warning=ExperimentalWarning',
          '--input-type=commonjs',
          '-e',
          LAUNCHER_PROGRAM,
        ];
    // Resolving the external native binding also works in packed ESM/CJS and
    // the bundled CLI; only the isolated launcher loads it, never observe().
    // ESM must prefer its own URL over globals exposed by CommonJS eval callers;
    // the CJS bundle replaces import.meta with an empty object and uses its filename.
    const native = isWindows
      ? undefined
      : createRequire(import.meta.url || __filename).resolve('koffi');
    // `file` is guaranteed defined: parseScopeConfig rejects an empty command.
    const child = spawn(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      isWindows ? file! : process.execPath,
      launchArgs,
      {
        cwd: effectiveCwd,
        // `env` is merged over the inherited daemon environment (003 §11.1).
        env: isWindows ? commandEnv : helperEnv,
        shell: false,
        // POSIX: leader of its own process group/session, so the timeout escalation
        // can signal the whole tree at once (`killProcessTree` above) instead of only
        // the direct child (003 §11.7, issue #303). Windows has no equivalent flag;
        // its tree-kill goes through `taskkill /T` instead, which does not depend on
        // process-group membership.
        detached: !isWindows,
        stdio: isWindows
          ? ['ignore', 'pipe', 'pipe']
          : ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      },
    );

    const admission = child.stdio[4];
    if (!isWindows && admission instanceof Duplex) {
      admission.on('error', () => {
        /* Child startup failure is reported by its exit. */
      });
      admission.end(
        JSON.stringify({
          command: scope.command,
          env: commandEnv,
          deadline,
          grace: SIGKILL_GRACE_MS,
          watchdog: WATCHDOG_PROGRAM,
          native,
        }),
      );
    }

    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let armed = isWindows;
    let armingError: string | undefined;
    const control = child.stdio[3];
    if (control instanceof Duplex)
      control.on('error', () => {
        /* Daemon loss cannot revoke the bound. */
      });
    // Node's type declaration names only the first five slots, but stdio is
    // an ordinary array and this private protocol occupies the sixth descriptor.
    const status = child.stdio.at(5);
    let statusEnded = isWindows;
    let pendingExit:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;
    let controlInput = '';
    if (status instanceof Duplex) {
      status.on('error', () => {
        /* A vanished daemon/worker cannot revoke the bound. */
      });
      status.on('data', (chunk: Buffer) => {
        controlInput += chunk.toString();
        const lines = controlInput.split('\n');
        controlInput = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const message: unknown = JSON.parse(line);
            // Only the two exact private schemas can authorize a result. A bad
            // frame remains a failure even if a later valid frame arrives.
            if (
              typeof message !== 'object' ||
              message === null ||
              !('kind' in message)
            ) {
              armingError = 'Invalid command lifetime-bound status schema';
            } else if (
              message.kind === 'armed' &&
              Object.keys(message).length === 1
            ) {
              armed = true;
            } else if (
              message.kind === 'error' &&
              Object.keys(message).length === 2 &&
              'error' in message &&
              typeof message.error === 'string'
            ) {
              armingError = message.error;
            } else {
              armingError = 'Invalid command lifetime-bound status schema';
            }
          } catch {
            armingError = 'Invalid command lifetime-bound acknowledgement';
          }
        }
      });
    }
    if (status instanceof Duplex) {
      // EOF proves exec closed the launcher's private descriptor, or that its
      // failure message has been fully consumed. Never race it with stdio exit.
      status.once('end', () => {
        // EOF is the frame boundary after exec, so even a valid armed frame
        // cannot authorize an exit when an unfinished error follows it.
        if (controlInput.length > 0) {
          armingError = 'Incomplete command lifetime-bound status frame';
        }
        statusEnded = true;
        if (pendingExit) resolveFromExit(pendingExit.code, pendingExit.signal);
      });
    }
    let truncated = false;
    // Post-timeout SIGKILL escalation timer (003 §11.2/§11.7, issue #303). Deliberately
    // NOT cleared by `finish()`/`clearTimers()` below — see the comment there.
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    let closeFallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    // Trailing stderr bytes retained so far, bounded at STDERR_RETENTION_CAP_BYTES
    // (issue #302) — independent of the stdout cap. Kept as a Buffer (not decoded
    // to a string chunk-by-chunk) so a multi-byte UTF-8 character split across two
    // `data` events is never corrupted; decoding happens once, on the final tail.
    let stderrRetained = Buffer.alloc(0);

    // Bound stdout capture at the 1 MiB cap (003 §11.2): once the cap is reached,
    // further bytes are discarded but the stream is never paused, so a chatty child
    // is always drained and can never block on a full pipe buffer (issue #302).
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= STDOUT_CAP_BYTES) {
        if (chunk.length > 0) truncated = true;
        return;
      }
      const remaining = STDOUT_CAP_BYTES - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    // Captured solely for failure diagnostics (003 §11.5), bounded independently of
    // stdout (issue #302): a pathological stderr volume can never grow this
    // process's own memory unbounded, and — like stdout — never pauses the pipe or
    // kills the child. Only the trailing bytes survive; older chunks are dropped
    // once the retention cap is exceeded.
    child.stderr?.on('data', (chunk: Buffer) => {
      // Concat-then-slice keeps the retained buffer truly bounded at
      // STDERR_RETENTION_CAP_BYTES on every chunk — including a single chunk
      // larger than the cap — rather than only evicting whole chunks (which
      // could retain far more than the cap, or drop bytes from within the
      // trailing window when a huge chunk is followed by a tiny one).
      //
      // `Buffer.subarray` returns a VIEW onto its source, not a copy: slicing
      // the trailing window off `combined` would keep the whole concatenated
      // backing store alive for as long as `stderrRetained` is referenced,
      // silently defeating the retention cap (a `stderrRetained.length` of
      // 8000 could still pin an arbitrarily large `.buffer.byteLength`). Copy
      // the trailing window whenever it's over the cap so only the bounded
      // bytes are retained.
      //
      // `Buffer.from(view)` is NOT a reliable exact-size copy: its pooling
      // heuristics are environment-dependent (observed byteLength 8000
      // locally vs. 65536 in CI on the same Node major), so it can silently
      // defeat the cap it's meant to enforce. `Buffer.allocUnsafeSlow` always
      // allocates a fresh, non-pooled backing store of exactly the requested
      // size, so `.copy()` into it is deterministic across Node versions.
      const combined = Buffer.concat([stderrRetained, chunk]);
      if (combined.length > STDERR_RETENTION_CAP_BYTES) {
        const tail = combined.subarray(-STDERR_RETENTION_CAP_BYTES);
        const copy = Buffer.allocUnsafeSlow(tail.length);
        tail.copy(copy);
        stderrRetained = copy;
      } else {
        stderrRetained = combined;
      }
    });

    function clearTimers(): void {
      clearTimeout(wallClockTimer);
      clearTimeout(closeFallbackTimer);
      // A completed leader can leave a live group behind. Keep shutdown
      // cancellation until the watchdog closes its private control channel.
      if (!(control instanceof Duplex) || control.destroyed) {
        shutdownSignal?.removeEventListener('abort', cancel);
      }
      // `sigkillTimer` is deliberately NOT cleared here. It targets the whole
      // process GROUP with SIGKILL after the SIGTERM grace period, and must run to
      // completion even once this promise has already settled: a direct child can
      // exit on SIGTERM (default disposition) while a descendant it backgrounded
      // has SIGTERM ignored (e.g. inherited via `exec` from a subshell that
      // trapped it) and so survives untouched. Cancelling the pending SIGKILL as
      // soon as the direct child's own `exit` resolved this promise would leave
      // that descendant orphaned forever (003 §11.7, issue #303). Leaving it armed
      // is always safe: the follow-up re-verifies the group's identity first, so
      // an emptied group is a no-op and a reused group id is never signalled
      // (008 §5).
    }

    function finish(outcome: ExecOutcome): void {
      if (settled) return;
      settled = true;
      clearTimers();
      // Once direct-command output has settled, normal completion releases the
      // entire finite observation group. Timeout failures retain the full grace.
      // EOF never means completion, so daemon death cannot remove the backstop.
      if (
        !timedOut &&
        !cancelled &&
        control instanceof Duplex &&
        !control.destroyed
      ) {
        control.write('complete\n');
      }
      // The independent watchdog keeps its own timers referenced. A settled
      // caller may exit immediately even while timeout descendants use the grace.
      if (control instanceof Socket) control.unref();
      resolve(outcome);
    }

    /**
     * Decode the retained trailing stderr bytes to the final `STDERR_TAIL_CHARS`
     * diagnostic tail. Decoding happens once, here, from the bounded byte buffer —
     * never per-chunk — so a UTF-8 character split across `data` events is never
     * corrupted (issue #302).
     */
    function stderrTailString(): string {
      return stderrRetained.toString('utf8').slice(-STDERR_TAIL_CHARS);
    }

    function resolveFromExit(
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void {
      if (!statusEnded) {
        pendingExit = { code, signal };
        return;
      }
      if (cancelled || !armed || armingError !== undefined) {
        finish({
          kind: 'failure',
          error: cancelled
            ? 'Command cancelled during shutdown'
            : (armingError ??
              'Could not arm command lifetime bound: launcher exited before acknowledgement'),
          stderrTail: stderrTailString(),
        });
        return;
      }
      // Only decode/concat the retained stderr when it's actually needed (the
      // failure branches below) — the success path never reads it, so
      // computing it unconditionally would allocate on every successful tick.
      if (timedOut) {
        finish({
          kind: 'failure',
          error: `Command timed out after ${String(scope.timeoutMs)}ms`,
          stderrTail: stderrTailString(),
        });
        return;
      }
      if (signal !== null) {
        // Terminated by a signal we did not send ourselves (timedOut is false) — no
        // usable result was produced (003 §11.5).
        finish({
          kind: 'failure',
          error: `Command terminated by signal ${signal}`,
          stderrTail: stderrTailString(),
        });
        return;
      }
      finish({
        kind: 'result',
        result: {
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          exitCode: code ?? 0,
          truncated,
        },
      });
    }

    child.once('error', (error) => {
      finish({
        kind: 'failure',
        error: error.message,
        stderrTail: stderrTailString(),
      });
    });

    child.once('exit', (code, signal) => {
      // The independent watchdog may win the timer race. Classify the result
      // by the same absolute deadline even when its signal precedes our callback.
      if (armed && monotonicNowMs() >= deadline) timedOut = true;
      if (settled) return;
      if (timedOut) {
        // Resolve from the direct child's own exit — never wait on stdio stream
        // close here. An orphaned descendant that inherited stdout/stderr (e.g.
        // `sleep` under `sh -c 'sleep 30 & wait'`) can hold those pipes open
        // indefinitely even once the whole process group has been signaled; gating
        // resolution on `close` would hang this call forever in that case — the
        // exact bug this fixes (003 §11.7, issue #303).
        resolveFromExit(code, signal);
        return;
      }
      // Normal completion: disarm the wall-clock timeout immediately. Without this,
      // it stays armed for up to CLOSE_FALLBACK_MS more while we wait below for
      // stdio to `close` (e.g. a descendant inherited stdout and is holding it
      // open) — if `scope.timeoutMs` is short enough to elapse during that wait,
      // it would fire, set `timedOut = true`, and retroactively flip this already-
      // successful exit into a reported timeout once the fallback resolves
      // (003 §11.2, issue #303). The direct child is confirmed exited here, so the
      // wall-clock timeout has nothing left to bound.
      clearTimeout(wallClockTimer);
      // Give stdio a bounded window to `close` so a fast, well-behaved command's
      // full output is still captured (the existing accurate behavior). The
      // `close` listener below cancels this fallback the moment streams actually
      // close, which happens within milliseconds unless a descendant is holding
      // them open.
      closeFallbackTimer = setTimeout(() => {
        resolveFromExit(code, signal);
      }, CLOSE_FALLBACK_MS);
      closeFallbackTimer.unref();
      streamsClosed();
    });

    // The private watchdog descriptor may outlive the command. Ordinary stream
    // completion still reports the direct command's output promptly.
    function streamsClosed(): void {
      if (
        (child.stdout?.readableEnded || child.stdout?.destroyed) &&
        (child.stderr?.readableEnded || child.stderr?.destroyed) &&
        (child.exitCode !== null || child.signalCode !== null)
      ) {
        resolveFromExit(child.exitCode, child.signalCode);
      }
    }
    child.stdout?.once('end', streamsClosed);
    child.stderr?.once('end', streamsClosed);
    child.stdout?.once('close', streamsClosed);
    child.stderr?.once('close', streamsClosed);

    child.once('close', (code, signal) => {
      if (settled) return;
      resolveFromExit(code, signal);
    });

    // Wall-clock timeout: SIGTERM the whole process group, then SIGKILL after a 5s
    // grace (003 §11.2). Targeting the group — not just the direct child — is what
    // guarantees no orphaned descendant survives (003 §11.7, issue #303). Both steps
    // re-verify the group's identity at signal time (008 §5).
    const cleanupTarget = cleanupTargetFor(child, isWindows);
    const cleanupAction = `command-poll timeout escalation for ${displayObjectKey(scope.objectKey)}`;
    /** Shutdown bypasses the timeout grace but retains the ordinary identity gate. */
    function cancel(): void {
      cancelled = true;
      if (
        control instanceof Duplex &&
        !control.destroyed &&
        (child.exitCode !== null || child.signalCode !== null)
      ) {
        // The live watchdog supplies uninterrupted self-group identity even
        // when the already-reaped command no longer supplies a live handle.
        control.write('cancel\n');
      } else if (cleanupTarget !== undefined) {
        void killProcessTree(
          cleanupTarget,
          'SIGKILL',
          isWindows,
          'command-poll daemon shutdown',
        );
      }
    }
    const wallClockTimer = setTimeout(
      () => {
        timedOut = true;
        if (cleanupTarget === undefined) return;
        const termStep = killProcessTree(
          cleanupTarget,
          'SIGTERM',
          isWindows,
          cleanupAction,
        );
        // Unconditional: this must run to completion and SIGKILL the process group
        // even if the direct child has already exited and `finish()` has already
        // settled the promise (see the comment in `clearTimers` above) — a
        // descendant that ignores SIGTERM while the direct child dies from it is
        // otherwise never reaped (003 §11.7, issue #303). It waits for the SIGTERM
        // step to finish so it can rely on the group membership confirmed so far
        // (by that step, at the leader's exit and through the grace period); an
        // emptied group is a no-op, and one whose continuity was lost is an
        // abstention, never a signal (008 §5).
        sigkillTimer = setTimeout(() => {
          void termStep.then(() =>
            killProcessTree(cleanupTarget, 'SIGKILL', isWindows, cleanupAction),
          );
        }, SIGKILL_GRACE_MS);
        // sigkillTimer must not keep the event loop alive on its own.
        sigkillTimer.unref();
      },
      Math.max(1, deadline - monotonicNowMs()),
    );
    wallClockTimer.unref();
    if (control instanceof Duplex) {
      control.once('close', () =>
        shutdownSignal?.removeEventListener('abort', cancel),
      );
    }
    shutdownSignal?.addEventListener('abort', cancel, { once: true });
    if (shutdownSignal?.aborted) cancel();

    // The mandatory life record already precedes spawn. Numeric hints are
    // recorded before returning to the event loop, with live supervision fully
    // installed; an optional hint failure must never abandon the running child.
    if (child.pid !== undefined && owner !== undefined) {
      const pid = child.pid;
      updatePidBookkeeping(() => {
        owner.spawned(pid);
      });
      child.once('exit', () => {
        updatePidBookkeeping(() => {
          owner.exited(pid);
        });
      });
    }
  });
}

/** The precommitted life mark remains authoritative when an optional numeric hint cannot be updated. */
function updatePidBookkeeping(update: () => void): void {
  try {
    update();
  } catch {
    process.stderr.write(
      'Command ownership PID bookkeeping failed; the committed life mark remains available for restart cleanup.\n',
    );
  }
}

/** Recursively sort object keys for order-insensitive JSON comparison (mirrors api-poll). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function parseTopLevelIgnorePaths(
  changeDetection: { 'ignore-paths'?: unknown } | undefined,
): string[] {
  const rawIgnorePaths = changeDetection?.['ignore-paths'];
  if (rawIgnorePaths === undefined) return [];
  if (
    !Array.isArray(rawIgnorePaths) ||
    !rawIgnorePaths.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new Error(
      'change-detection.ignore-paths must be an array of strings',
    );
  }
  return rawIgnorePaths;
}

function normalizeJsonPath(path: string): string {
  if (path === '$' || path.startsWith('$.')) return path;
  return `$.${path}`;
}

function assertValidJsonPathSegment(path: string, segment: string): void {
  if (segment.length === 0) {
    throw new Error(
      `Invalid change-detection.ignore-paths entry "${path}": empty path segment`,
    );
  }
  if (/[.[\]*?]/.test(segment)) {
    throw new Error(
      `Invalid change-detection.ignore-paths entry "${path}": unsupported path segment "${segment}"`,
    );
  }
}

/**
 * Clone parsed JSON and remove author-requested paths before canonical sorting.
 * Paths are intentionally the same minimal dotted grammar used by keyed
 * collections: `$.duration` and bare `duration` both address a root field.
 */
function stripIgnoredJsonPaths(value: unknown, ignorePaths: string[]): unknown {
  if (ignorePaths.length === 0) return value;
  const cloned = structuredClone(value);
  for (const path of ignorePaths) {
    removeJsonPath(cloned, path);
  }
  return cloned;
}

function removeJsonPath(value: unknown, path: string): void {
  const normalizedPath = normalizeJsonPath(path);
  if (normalizedPath === '$') return;
  const segments = normalizedPath.slice(2).split('.');
  let current: unknown = value;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    assertValidJsonPathSegment(path, segment ?? '');
    if (current === null || typeof current !== 'object') return;
    if (!Object.hasOwn(current, segment ?? '')) return;
    current = (current as Record<string, unknown>)[segment ?? ''];
  }
  const last = segments.at(-1) ?? '';
  assertValidJsonPathSegment(path, last);
  if (current !== null && typeof current === 'object') {
    Reflect.deleteProperty(current, last);
  }
}

/**
 * Whether the result changed versus the prior baseline under `strategy` (003 §11.3).
 * `json-diff` falls back to raw text comparison when either side fails to parse,
 * identical to `api-poll`. `stderr` is never compared.
 */
function hasChanged(
  strategy: ChangeStrategy,
  ignorePaths: string[],
  prev: { stdout: string; exitCode: number },
  curr: { stdout: string; exitCode: number },
): boolean {
  switch (strategy) {
    case 'exit-code':
      return prev.exitCode !== curr.exitCode;
    case 'json-diff': {
      let prevParsed: unknown;
      let currParsed: unknown;
      try {
        prevParsed = JSON.parse(prev.stdout);
        currParsed = JSON.parse(curr.stdout);
      } catch {
        return prev.stdout !== curr.stdout;
      }
      return (
        JSON.stringify(
          sortKeys(stripIgnoredJsonPaths(prevParsed, ignorePaths)),
        ) !==
        JSON.stringify(sortKeys(stripIgnoredJsonPaths(currParsed, ignorePaths)))
      );
    }
    case 'text-diff':
      return prev.stdout !== curr.stdout;
  }
}

function isCommandState(value: unknown): value is CommandState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['stdout'] === 'string' &&
    typeof v['exitCode'] === 'number' &&
    typeof v['truncated'] === 'boolean' &&
    (v['health'] === 'ok' || v['health'] === 'failing') &&
    typeof v['baselined'] === 'boolean'
  );
}

/**
 * Build the output-changed observation (003 §11.4). `env` is deliberately absent
 * from every persisted field (payload/snapshot/state).
 */
function changedObservation(
  scope: ScopeConfig,
  result: ExecResult,
): Observation {
  return {
    title: `Command output changed: ${displayObjectKey(scope.objectKey)}`,
    summary: `Command output changed: ${displayObjectKey(scope.objectKey)}`,
    payload: {
      command: scope.command,
      exitCode: result.exitCode,
      strategy: scope.strategy,
      stdout: result.stdout,
      truncated: result.truncated,
    },
    snapshotText: result.stdout,
    objectKey: scope.objectKey,
    queryScope: { command: scope.objectKey },
    snapshot: {
      command: scope.command,
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      strategy: scope.strategy,
    },
    changeKind: 'modified',
  };
}

const scopeSchema: JsonSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description:
        'Argv array; command[0] is the executable (resolved via PATH). Spawned directly, never via a shell. ' +
        "For a pipeline or other shell operators, spawn a shell explicitly: ['sh', '-c', 'git status -sb | grep ahead'].",
    },
    cwd: {
      type: 'string',
      description:
        'Working directory for the child process. A relative path resolves against the runtime workspace/config root; an absolute path is used as-is. Omitted entirely, a project monitor defaults to the workspace/config root (a user-level monitor falls back to the daemon process working directory).',
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description:
        'Literal env vars merged over the inherited daemon environment',
    },
    timeout: {
      type: 'string',
      pattern: OPERATION_TIMEOUT_PATTERN,
      description:
        'Wall-clock limit (e.g. "30s"). Expiry is an execution failure. Must be at least 1 unit — a zero-length or leading-zero deadline (e.g. "0s", "01s") is rejected — and at most 2147483647ms (~24.8 days), the largest delay Node\'s setTimeout can schedule.',
    },
    key: {
      type: 'string',
      description:
        'Overrides the observation objectKey (defaults to the joined argv)',
    },
    interval: {
      type: 'string',
      pattern: '^\\d+[smhd]$',
      description:
        'Polling interval (e.g., "5m"). Used by the scheduling engine, not by this plugin directly.',
    },
    'change-detection': {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          enum: ['text-diff', 'json-diff', 'exit-code'],
        },
        // Keyed-collection mode (003 §12). The `collection` block is only valid
        // under `strategy: json-diff`; the `if/then` below enforces that at
        // authoring time (BP3).
        collection: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Dotted path to the array within the parsed JSON (e.g. "tasks" or "$.tasks")',
            },
            key: {
              type: 'string',
              description:
                'Field on each element used as the per-object identity',
            },
            'ignore-paths': {
              type: 'array',
              items: { type: 'string' },
              description:
                'Dotted paths (relative to each element, e.g. "fetchedAt" or "$.fetchedAt") removed before comparison',
            },
          },
          required: ['path', 'key'],
          additionalProperties: false,
        },
        'ignore-paths': {
          type: 'array',
          items: { type: 'string' },
          description:
            'Dotted paths removed from parsed JSON before plain json-diff comparison',
        },
      },
      additionalProperties: false,
      // BP3: change-detection.collection requires strategy: json-diff. Under any
      // other strategy (or the defaulted text-diff), presence of `collection` is an
      // authoring-time error.
      allOf: [
        {
          if: { required: ['collection'] },
          then: {
            properties: { strategy: { const: 'json-diff' } },
            required: ['strategy'],
          },
        },
        {
          if: { required: ['ignore-paths'] },
          then: {
            properties: { strategy: { const: 'json-diff' } },
            required: ['strategy'],
          },
        },
      ],
    },
  },
  required: ['command'],
};

/**
 * Compose finite command bounds with optional durable crash ownership. Daemon
 * users supply a precommitted owner; in-process users need no ownership journal.
 * An optional shutdown signal rejects new admissions and forcefully terminates
 * in-flight command groups through the identity gate before their observers settle.
 * @public
 */
export function createCommandPollSource(
  owner?: CommandProcessOwner,
  shutdownSignal?: AbortSignal,
): ObservationSource {
  return {
    name: 'command-poll',
    stateful: true,
    scopeSchema,
    observe(
      config: Record<string, unknown>,
      context: ObservationContext = { now: new Date() },
    ): Promise<ObservationResult> {
      return observeCommand(config, context, owner, shutdownSignal);
    },
  };
}

/** Acquire a command result and advance only its source-owned comparison/health baseline. */
async function observeCommand(
  config: Record<string, unknown>,
  context: ObservationContext,
  owner?: CommandProcessOwner,
  shutdownSignal?: AbortSignal,
): Promise<ObservationResult> {
  const scope = parseScopeConfig(config);
  const prev = isCommandState(context.previousState)
    ? context.previousState
    : undefined;
  const effectiveCwd = resolveCwd(scope.cwd, context.workspacePath);

  const outcome = await runCommand(scope, effectiveCwd, owner, shutdownSignal);

  // ---- Execution failure path (003 §11.5) -------------------------------------
  if (outcome.kind === 'failure') {
    // Prior state is kept (no re-baseline, no state loss). Emit only on the
    // ok → failing transition edge — including a failing first-ever run, which
    // establishes no baseline but records health so the recovery edge fires.
    const wasFailing = prev?.health === 'failing';
    const nextState: CommandState = {
      stdout: prev?.stdout ?? '',
      exitCode: prev?.exitCode ?? 0,
      truncated: prev?.truncated ?? false,
      health: 'failing',
      baselined: prev?.baselined ?? false,
      // Carry the keyed baseline forward untouched so recovery diffs against it.
      ...(prev?.keyedSnapshot ? { keyedSnapshot: prev.keyedSnapshot } : {}),
    };
    return {
      observations: wasFailing ? [] : [failingObservation(scope, outcome)],
      nextState,
    };
  }

  // ---- Successful execution path ----------------------------------------------
  const result = outcome.result;
  const recovered = prev?.health === 'failing';
  const hadBaseline = prev?.baselined ?? false;

  const observations: Observation[] = [];
  // A failing → ok edge always emits the recovery health observation (003 §11.5).
  if (recovered) {
    observations.push(recoveredObservation(scope));
  }

  // ---- Keyed-collection mode (003 §12) ----------------------------------------
  // Parse stdout as JSON and diff per keyed object. The keyed snapshot lives in the
  // same per-monitor state slot; the baseline rule is unchanged (first successful
  // run records the snapshot, emits nothing). A failing-first-run leaves no keyed
  // baseline, so the first success after it baselines silently too.
  if (scope.collection) {
    const result2 = diffKeyedCollection(
      JSON.parse(result.stdout),
      scope.collection,
      scope.objectKey,
      hadBaseline ? prev?.keyedSnapshot : undefined,
      {
        payload: { command: scope.command },
        queryScope: { command: scope.objectKey },
      },
    );
    observations.push(...result2.observations);
    const nextState: CommandState = {
      stdout: result.stdout,
      exitCode: result.exitCode,
      truncated: result.truncated,
      health: 'ok',
      baselined: true,
      keyedSnapshot: result2.snapshot,
    };
    return { observations, nextState };
  }

  const nextState: CommandState = {
    stdout: result.stdout,
    exitCode: result.exitCode,
    truncated: result.truncated,
    health: 'ok',
    baselined: true,
  };

  // The output-changed observation requires a real pre-failure/prior baseline to
  // diff against. The first-ever success — and the first success after a failing
  // first run — baselines silently (003 §11.4/§11.5).
  if (
    prev !== undefined &&
    hadBaseline &&
    hasChanged(scope.strategy, scope.ignorePaths, prev, result)
  ) {
    observations.push(changedObservation(scope, result));
  }

  return { observations, nextState };
}

const source = createCommandPollSource();

/** Health observation for the `ok → failing` edge (003 §11.5). Never carries `env`. */
function failingObservation(
  scope: ScopeConfig,
  outcome: Extract<ExecOutcome, { kind: 'failure' }>,
): Observation {
  return {
    title: `Command failing: ${displayObjectKey(scope.objectKey)}`,
    summary: `Command failing: ${displayObjectKey(scope.objectKey)}`,
    payload: {
      command: scope.command,
      error: outcome.error,
      stderrTail: outcome.stderrTail,
    },
    objectKey: scope.objectKey,
    queryScope: { command: scope.objectKey },
    changeKind: 'modified',
  };
}

/** Health observation for the `failing → ok` edge (003 §11.5). */
function recoveredObservation(scope: ScopeConfig): Observation {
  return {
    title: `Command recovered: ${displayObjectKey(scope.objectKey)}`,
    summary: `Command recovered: ${displayObjectKey(scope.objectKey)}`,
    payload: { command: scope.command },
    objectKey: scope.objectKey,
    queryScope: { command: scope.objectKey },
    changeKind: 'modified',
  };
}

export default source;
