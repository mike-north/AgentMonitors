import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type StdioOptions,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  openSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  JsonSchema,
  KeyedCollectionConfig,
  KeyedSnapshot,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '@agentmonitors/core';
import {
  OPERATION_TIMEOUT_PATTERN,
  diffKeyedCollection,
  displayObjectKey,
  parseKeyedCollectionConfig,
  parseOperationTimeoutMs,
} from '@agentmonitors/core';

// Re-exported so API Extractor can resolve the default export's type — and
// the core types its interface shape transitively references — from this
// package's own entry point, instead of flagging ae-forgotten-export
// warnings in the checked-in API report.
export type {
  ChangeKind,
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

/**
 * Extra slack beyond the daemon-side SIGTERM→SIGKILL escalation window
 * (`timeout` + {@link SIGKILL_GRACE_MS}) before the child's OWN watchdog fires
 * (003 §11.2, issue #470). The daemon-resident timers stay authoritative in the
 * normal case; the self-watchdog is a pure backstop that only matters when they
 * cannot run — i.e. the daemon died — so it deliberately fires strictly AFTER
 * the daemon would have, never racing the daemon's graceful SIGTERM.
 */
const SELF_WATCHDOG_SLACK_MS = 2_000;

/** Identity tag: enables shell syntax highlighting/linting of the embedded script. */
const sh = String.raw;

/**
 * A discoverable marker embedded in the self-watchdog's command line (003 §11.2,
 * issue #470). It lets an out-of-band orphan sweep (issue #426) recognize a
 * stray command-poll watchdog by its `ps`/`pgrep -f` signature, without having
 * to match on `sleep` (far too broad).
 */
const WATCHDOG_MARKER = 'agentmonitors:command-poll-watchdog';

/**
 * POSIX self-watchdog script (003 §11.2, issue #470). A `command-poll` child is
 * spawned `detached` (its own process group, for issue #303's group-kill), but
 * the SIGTERM→SIGKILL timeout escalation lived only as `setTimeout` timers in the
 * daemon. If the daemon dies abruptly — SIGKILL, crash, OOM — before a hung
 * command's timeout fires, those timers die with it and the detached child
 * reparents to launchd/init and survives **indefinitely**, with nothing left to
 * reap it. For a long-running background daemon that is the reliability-fatal
 * failure mode this closes.
 *
 * The fix is an INDEPENDENT sibling process, spawned `detached` alongside the
 * command. Being its own detached process, it survives the daemon's death and
 * reaps the orphan on its own timer. Spawning it as a *sibling* — rather than
 * wrapping the command in a shell — keeps the command spawned directly
 * (`shell: false`), so every §11.1/§11.2/§11.5 semantic (no shell word-splitting,
 * real spawn-failure errors, exact exit codes) is untouched.
 *
 * The group is signalled by its **numeric** process-group id, but a bare
 * `kill -KILL -<pgid>` after a fixed sleep is unsafe: a numeric pgid is
 * recyclable. If the command exits on its own before the deadline, its pgid can be
 * reused by an unrelated same-user process group, which the delayed signal would
 * then wrongly kill. So the watchdog binds to an **un-recyclable liveness pipe**
 * rather than trusting the pgid alone. The command group inherits the only write
 * ends of that pipe (as fd 3); the watchdog holds the read end (arriving as fd 0).
 * A blocking read on it returns EOF exactly when the WHOLE group — the leader and
 * every descendant — has gone, and a pipe is a kernel object that cannot be
 * recycled. The watchdog races the deadline against that EOF: it signals the group
 * only if the deadline elapses while the pipe is still open (the group provably
 * still alive), and otherwise disarms without ever signalling.
 *
 * The write end is handed to the command at a deliberately HIGH fd
 * ({@link COMMAND_LIVENESS_FD}), not fd 3, so that ordinary shell fd usage can't
 * collide with it and produce a false EOF (issue #472 review) — see that
 * constant's doc comment for the full rationale and its residual limits.
 *
 * `$1` is the command's process-group id; `$2` is the whole-second deadline.
 * "armed" is printed on stdout only once the watchdog has proven it can time the
 * backstop and holds a working blocking read end — the daemon treats its absence
 * as an arming failure and fails the command closed rather than run it unbounded
 * (issue #470 review).
 */
const SELF_WATCHDOG_SCRIPT = sh`
# ${WATCHDOG_MARKER}
pgid="$1"
deadline="$2"
# A missing 'sleep' means the backstop cannot be timed. Never fall through to the
# kill in that case — that would SIGKILL a healthy group instantly. Fail closed:
# exit before printing "armed", so the daemon terminates the command itself.
command -v sleep >/dev/null 2>&1 || exit 0
# The liveness read end arrives as fd 0, but it is passed through a child stdio
# slot, which the runtime forces non-blocking; a bare read would then see a
# spurious EOF and disarm instantly. Re-open it as a fresh BLOCKING fd (portable
# via /dev/fd on macOS and Linux). A failure here also fails closed (no "armed").
exec 3</dev/fd/0 || exit 0
printf 'armed\n'
# Deadline timer.
sleep "$deadline" &
timer=$!
# Liveness reader: the command group holds the only write ends of the pipe on
# fd 3, so a blocking read there returns (EOF) exactly when the WHOLE group — the
# leader and every descendant, including one that ignored SIGTERM — has gone. On
# that EOF, cancel the timer so the deadline branch below can never signal a group
# that has already exited (whose pgid may by then have been recycled).
{ while IFS= read -r _ <&3; do :; done; kill "$timer" 2>/dev/null; } &
reader=$!
# The timer running to completion means the deadline elapsed while the group was
# still alive (the reader had not cancelled it) — reap the whole group. If the
# reader cancelled the timer first, the group is already gone, wait returns
# non-zero, and no signal is ever sent to a possibly-recycled pgid.
if wait "$timer"; then
  kill -KILL -"$pgid" 2>/dev/null
fi
kill "$reader" 2>/dev/null
`;

/** An anonymous liveness pipe's two ends (003 §11.2, issue #470). */
interface LivenessPipe {
  /** Read end handed to the watchdog as its fd 0. */
  rfd: number;
  /**
   * Write end handed to the command at {@link COMMAND_LIVENESS_FD}; closed in the
   * daemon post-spawn.
   */
  wfd: number;
}

/**
 * fd index at which the command receives the liveness pipe's write end (003
 * §11.2, issue #472 review). Deliberately a high fd, not fd 3.
 *
 * The watchdog's EOF-means-"group gone" logic (see {@link SELF_WATCHDOG_SCRIPT})
 * depends on the command and every descendant holding this fd open for their
 * entire lifetime — closing it early is indistinguishable, from the watchdog's
 * side, from the whole group having exited. fd 3 is the single most
 * collision-prone fd for that: POSIX shells routinely use low, ad hoc fds for
 * scratch redirections (`exec 3<file`, `read -u`), and bash's own
 * `exec {var}<>file` auto-assignment starts at fd 10 — so a command as ordinary
 * as `sh -c 'exec 3>&-; ...'`, or one that reopens/closes fd 3 for its own
 * purposes, would unknowingly close its inherited copy of the write end and trip
 * a spurious EOF, disarming the watchdog while the command keeps running (the
 * exact issue #472 defect). Moving the write end to fd 20 — well past the fds
 * ordinary shell/script idioms reach for — makes that class of collision
 * effectively impossible without eliminating a narrower residual: a command that
 * does `closefrom(3)`-style hardening (closing every fd `>= 3`, or `>= N` for
 * some `N <= 20`) still closes this fd too, because there is no fd number such
 * hardening would skip. That residual is unavoidable by fd placement alone and
 * is called out in 003 §11.2 rather than solved here — the alternative (treating
 * early EOF as a *hint* requiring a `kill -0` liveness check before trusting it)
 * was considered and rejected: gating the watchdog's kill on `kill -0 -"$pgid"`
 * being true reintroduces exactly the recycled-pgid hazard this design already
 * closed (a pgid can be reused by an unrelated group between the check and the
 * kill), for a residual this rare and this well-documented.
 */
const COMMAND_LIVENESS_FD = 20;

/**
 * Create an anonymous liveness pipe for the self-watchdog (003 §11.2, issue #470),
 * or `undefined` if one could not be created.
 *
 * Node exposes no `pipe(2)`, so this mints one as a transient, owner-only FIFO,
 * opens both ends, and unlinks the name immediately — the open fds keep the pipe
 * alive, and removing the name closes the brief on-disk window (BP4). An `O_RDWR`
 * scratch open breaks the FIFO open-standoff so the read and write ends can then
 * be opened **blocking** (no `O_NONBLOCK`) in either order — the watchdog needs a
 * blocking read end for EOF to mean "group gone", not "no data yet".
 */
function createLivenessPipe(): LivenessPipe | undefined {
  const fifoPath = path.join(
    tmpdir(),
    `agentmon-wd-${randomBytes(12).toString('hex')}`,
  );
  try {
    execFileSync('mkfifo', ['-m', '600', fifoPath], { stdio: 'ignore' });
  } catch {
    return undefined;
  }
  let scratch: number | undefined;
  let rfd: number | undefined;
  let wfd: number | undefined;
  try {
    scratch = openSync(fifoPath, fsConstants.O_RDWR);
    wfd = openSync(fifoPath, fsConstants.O_WRONLY);
    rfd = openSync(fifoPath, fsConstants.O_RDONLY);
    return { rfd, wfd };
  } catch {
    if (rfd !== undefined) closeSync(rfd);
    if (wfd !== undefined) closeSync(wfd);
    return undefined;
  } finally {
    if (scratch !== undefined) {
      try {
        closeSync(scratch);
      } catch {
        // Already closed — nothing to do.
      }
    }
    try {
      unlinkSync(fifoPath);
    } catch {
      // Best-effort: the open fds keep the pipe usable regardless.
    }
  }
}

/** A spawned self-watchdog and its arming handshake (003 §11.2, issue #470). */
interface SelfWatchdog {
  process: ChildProcess;
  /**
   * Resolves `true` once the watchdog confirms (via its "armed" line) that it can
   * time the backstop and holds a working blocking read end; `false` if it exited
   * or errored before confirming. `false` means no independent bound was armed, so
   * the caller must fail the command closed rather than run it unbounded.
   */
  readonly armed: Promise<boolean>;
}

/**
 * Spawn the independent self-watchdog for a just-started command whose
 * process-group id is `commandPgid`, wired to `rfd` (the liveness read end) as its
 * fd 0 (003 §11.2, issue #470). Returns the watchdog and its arming handshake, or
 * `undefined` if it could not be spawned at all.
 *
 * The watchdog is itself `detached` (its own process group) so that (a) it
 * survives the daemon's death to do its job, and (b) it can later be reaped
 * whole — script shell *and* its `sleep`/reader children — via a single group
 * signal. It is `unref`'d so it never keeps the daemon's event loop alive; only
 * its short-lived stdout handshake is read. `sh` is resolved via `PATH` (portable
 * across POSIX layouts that do not ship `/bin/sh`), and any launch failure fails
 * closed through the handshake rather than leaving the command unbounded.
 */
function spawnSelfWatchdog(
  rfd: number,
  commandPgid: number,
  deadlineMs: number,
): SelfWatchdog | undefined {
  // Whole seconds — `sleep`'s only POSIX-guaranteed granularity — rounded UP so
  // the self-watchdog can never fire earlier than the daemon's own escalation.
  const deadlineSecs = Math.ceil(deadlineMs / 1000);
  let watchdog: ChildProcess;
  try {
    watchdog = spawn(
      'sh',
      [
        '-c',
        SELF_WATCHDOG_SCRIPT,
        'sh',
        String(commandPgid),
        String(deadlineSecs),
      ],
      { detached: true, stdio: [rfd, 'pipe', 'ignore'] },
    );
  } catch {
    return undefined;
  }
  const armed = new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const stdout = watchdog.stdout;
    if (stdout) {
      let seen = '';
      stdout.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8');
        if (seen.includes('armed')) settle(true);
      });
      // The handshake pipe must never keep the daemon's event loop alive. `stdout`
      // is a Socket at runtime (a child stdio pipe), but `unref` is not on the
      // `Readable` type it is declared as, so reach it through an optional shape.
      (stdout as { unref?: () => void }).unref?.();
    }
    // Exiting or erroring before "armed" means the watchdog could not arm.
    watchdog.once('exit', () => {
      settle(false);
    });
    // A spawn 'error' must also never surface as an unhandled event that crashes
    // the daemon; treat it as an arming failure.
    watchdog.once('error', () => {
      settle(false);
    });
  });
  watchdog.unref();
  return { process: watchdog, armed };
}

/**
 * Reap the self-watchdog once the command has resolved on a non-timeout path
 * (003 §11.2, issue #470). Signals the watchdog's whole process GROUP (it is a
 * detached group leader), so the script shell and its `sleep`/reader children die
 * together — signaling only the shell's pid would orphan them. Best-effort: if it
 * already disarmed and exited, the group is empty and the signal is a no-op.
 *
 * Deliberately NOT called on the timeout path: there the daemon's own SIGKILL
 * escalation is still armed for a SIGTERM-ignoring descendant, and if the daemon
 * dies before it fires, the self-watchdog is the only thing left to reap that
 * descendant — so it must stay armed until the group is actually gone (it then
 * disarms itself via the liveness pipe's EOF).
 */
function reapSelfWatchdog(watchdog: SelfWatchdog | undefined): void {
  const pid = watchdog?.process.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone — the desired state.
  }
}

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
 * Best-effort process-tree termination for one escalation step (SIGTERM or SIGKILL).
 *
 * On POSIX, `child` was spawned as the leader of its own process group/session
 * (`detached: true`); signaling the *negative* PID targets that whole group, so a
 * command's own background jobs (`sh -c 'sleep 30 & wait'`) die with it instead of
 * surviving as orphans (003 §11.7, issue #303).
 *
 * Windows has no process-group-signal equivalent, and no reliable graceful signal
 * for a non-console-attached spawned process — `taskkill` without `/F` frequently
 * fails silently for exactly this kind of child. The documented choice (issue #303
 * AC2) is to always use `taskkill /PID <pid> /T /F`: forceful and tree-wide, on both
 * the timeout expiry and the grace follow-up. There is no softer Windows phase to
 * escalate from, so both steps do the same thing — the follow-up is a defensive
 * retry, not a genuine escalation.
 */
function killProcessTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
  isWindows: boolean,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
      // Best-effort: a "not found" failure just means the tree already exited.
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group already gone — nothing left to signal.
  }
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
 * Spawn `command` directly (never a shell — `spawn` with `shell: false`), draining
 * stdout and stderr as they stream rather than buffering to completion, enforcing
 * `timeout` with a SIGTERM→SIGKILL escalation targeted at the command's **entire
 * process tree**, not just the direct child (003 §11.2/§11.7, issue #303). A nonzero
 * exit code with output is a **result**, not a failure (003 §11.2/§11.5); spawn
 * failure and timeout are failures. Crucially, neither stream exceeding its
 * retention cap ever kills the child (issue #302) — `data` listeners are attached
 * unconditionally, so the pipe keeps draining and the command always runs to its
 * real completion (side effects and all); the caps only bound what is *kept*, never
 * what is *drained*, so the reported exit code is always the command's actual one.
 *
 * On POSIX an independent, detached self-watchdog sibling (see
 * {@link spawnSelfWatchdog}) is armed against this command's process group so the
 * group is killed at a backstop deadline even if this daemon dies before the
 * timeout fires — a detached child can otherwise reparent to launchd/init and
 * orphan indefinitely (issue #470). The daemon-resident timers below remain
 * authoritative in the normal case; the self-watchdog only fires when they cannot.
 */
async function runCommand(
  scope: ScopeConfig,
  effectiveCwd: string | undefined,
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    const [file, ...args] = scope.command;
    const isWindows = process.platform === 'win32';

    // Self-bounding backstop (003 §11.2, issue #470): on POSIX an INDEPENDENT
    // detached sibling group-kills this command if the daemon dies before its own
    // timers can. It binds to an un-recyclable liveness pipe whose only write ends
    // the command group inherits (at fd COMMAND_LIVENESS_FD), so creating that pipe
    // UP FRONT means a pipe-creation failure fails closed — the command is never
    // launched unbounded. Windows has no process groups and no portable in-group
    // watchdog, so there the daemon-resident timers remain the only bound (a
    // documented platform limit).
    const livenessPipe = isWindows ? undefined : createLivenessPipe();
    if (!isWindows && livenessPipe === undefined) {
      resolve({
        kind: 'failure',
        error:
          'Could not arm self-bounding watchdog: liveness pipe unavailable',
        stderrTail: '',
      });
      return;
    }

    // `file` is guaranteed defined: parseScopeConfig rejects an empty command.
    const child = spawn(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      file!,
      args,
      {
        cwd: effectiveCwd,
        // `env` is merged over the inherited daemon environment (003 §11.1).
        env: scope.env ? { ...process.env, ...scope.env } : process.env,
        shell: false,
        // POSIX: leader of its own process group/session, so the timeout escalation
        // can signal the whole tree at once (`killProcessTree` above) instead of only
        // the direct child (003 §11.7, issue #303). This same group is what the
        // independent self-watchdog (issue #470) targets. Windows has no equivalent
        // flag; its tree-kill goes through `taskkill /T` instead, which does not
        // depend on process-group membership.
        detached: !isWindows,
        // fd COMMAND_LIVENESS_FD (POSIX only) is the liveness pipe's write end: the
        // command and every descendant inherit it, so the watchdog's read end
        // reaches EOF exactly when the whole group has gone. It is deliberately a
        // high fd rather than the next-available low one — see that constant's
        // doc comment (issue #472 review) for why. The padding entries between
        // fd 3 and it are `'ignore'` (mapped to `/dev/null`), matching how Node
        // already treats stdin/stdout/stderr slots the command doesn't use.
        stdio: livenessPipe
          ? ([
              'ignore',
              'pipe',
              'pipe',
              ...(Array(COMMAND_LIVENESS_FD - 3).fill('ignore') as 'ignore'[]),
              livenessPipe.wfd,
            ] satisfies StdioOptions)
          : ['ignore', 'pipe', 'pipe'],
      },
    );

    // The daemon must not retain the liveness write end, or the pipe would never
    // reach EOF while the daemon is alive; the command holds its own inherited copy.
    if (livenessPipe) {
      try {
        closeSync(livenessPipe.wfd);
      } catch {
        // Already closed — nothing to do.
      }
    }

    // Passing fd 3 widens the spawn return type so the requested `pipe` streams are
    // typed nullable; they are always present here (fds 1/2 are `pipe`).
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) {
      killProcessTree(child, 'SIGKILL', isWindows);
      if (livenessPipe) {
        try {
          closeSync(livenessPipe.rfd);
        } catch {
          // Already closed — nothing to do.
        }
      }
      resolve({
        kind: 'failure',
        error: 'Command stdio pipes were unavailable',
        stderrTail: '',
      });
      return;
    }

    // Armed after `finish()` is defined below, whose fail-closed path it drives.
    let selfWatchdog: SelfWatchdog | undefined;

    let settled = false;
    let timedOut = false;
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
    stdout.on('data', (chunk: Buffer) => {
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
    stderr.on('data', (chunk: Buffer) => {
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
      // `sigkillTimer` is deliberately NOT cleared here. It targets the whole
      // process GROUP with SIGKILL after the SIGTERM grace period, and must run to
      // completion even once this promise has already settled: a direct child can
      // exit on SIGTERM (default disposition) while a descendant it backgrounded
      // has SIGTERM ignored (e.g. inherited via `exec` from a subshell that
      // trapped it) and so survives untouched. Cancelling the pending SIGKILL as
      // soon as the direct child's own `exit` resolved this promise would leave
      // that descendant orphaned forever (003 §11.7, issue #303). Firing SIGKILL
      // on an already-empty process group is caught and ignored in
      // `killProcessTree`, so leaving it armed is always safe.
    }

    function finish(outcome: ExecOutcome): void {
      if (settled) return;
      settled = true;
      clearTimers();
      // Reap the self-watchdog only on a NON-timeout resolution (issue #470). On a
      // normal/failed exit the group is done and the daemon is alive, so reap
      // promptly. On the TIMEOUT path the daemon's own SIGKILL escalation
      // (`sigkillTimer`) is still armed for a SIGTERM-ignoring descendant; if the
      // daemon dies before it fires, the self-watchdog is the only thing left to
      // reap that descendant — so leave it armed. It disarms itself via the
      // liveness pipe's EOF once the group is actually gone.
      if (!timedOut) reapSelfWatchdog(selfWatchdog);
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
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      resolveFromExit(code, signal);
    });

    // Wall-clock timeout: SIGTERM the whole process group, then SIGKILL after a 5s
    // grace (003 §11.2). Targeting the group — not just the direct child — is what
    // guarantees no orphaned descendant survives (003 §11.7, issue #303).
    const wallClockTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGTERM', isWindows);
      // Unconditional: this must run to completion and SIGKILL the process group
      // even if the direct child has already exited and `finish()` has already
      // settled the promise (see the comment in `clearTimers` above) — a
      // descendant that ignores SIGTERM while the direct child dies from it is
      // otherwise never reaped (003 §11.7, issue #303). Signaling an
      // already-empty process group throws ESRCH, which `killProcessTree` catches
      // and ignores.
      sigkillTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL', isWindows);
      }, SIGKILL_GRACE_MS);
      // sigkillTimer must not keep the event loop alive on its own.
      sigkillTimer.unref();
    }, scope.timeoutMs);
    wallClockTimer.unref();

    // Arm the self-watchdog last, once every timer and `finish()` exist for its
    // fail-closed path (003 §11.2, issue #470). Still synchronous, so the bound is
    // in place before the command can make progress. Deadline is set strictly
    // AFTER the daemon's own SIGTERM→SIGKILL window (plus slack), so the daemon
    // stays authoritative in the normal case and the watchdog only ever fires when
    // the daemon can't. Skipped on Windows and if the OS gave us no pid (a pidless
    // spawn resolves via the 'error' path above).
    if (livenessPipe && child.pid !== undefined) {
      selfWatchdog = spawnSelfWatchdog(
        livenessPipe.rfd,
        child.pid,
        scope.timeoutMs + SIGKILL_GRACE_MS + SELF_WATCHDOG_SLACK_MS,
      );
    }
    // The daemon hands the read end to the watchdog and keeps no copy of it; if
    // arming did not happen, closing it here is what lets the pipe reach EOF.
    if (livenessPipe) {
      try {
        closeSync(livenessPipe.rfd);
      } catch {
        // Already closed — nothing to do.
      }
    }
    // Fail closed (issue #470 review): if we intended to arm a bound but couldn't —
    // the watchdog would not even spawn, or it exited/errored before confirming it
    // is armed — the command must not keep running unbounded. Terminate its group
    // and report a failure rather than trust the daemon-resident timers alone,
    // which is exactly the guarantee #470 exists to make.
    if (livenessPipe && child.pid !== undefined) {
      if (selfWatchdog === undefined) {
        killProcessTree(child, 'SIGKILL', isWindows);
        finish({
          kind: 'failure',
          error: 'Could not arm self-bounding watchdog: launch failed',
          stderrTail: '',
        });
      } else {
        void selfWatchdog.armed.then((ok) => {
          if (!ok && !settled) {
            killProcessTree(child, 'SIGKILL', isWindows);
            finish({
              kind: 'failure',
              error:
                'Could not arm self-bounding watchdog: arming was not confirmed',
              stderrTail: stderrTailString(),
            });
          }
        });
      }
    }
  });
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

const source: ObservationSource = {
  name: 'command-poll',
  stateful: true,
  scopeSchema,

  async observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    const scope = parseScopeConfig(config);
    const prev = isCommandState(context.previousState)
      ? context.previousState
      : undefined;
    const effectiveCwd = resolveCwd(scope.cwd, context.workspacePath);

    const outcome = await runCommand(scope, effectiveCwd);

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
  },
};

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
