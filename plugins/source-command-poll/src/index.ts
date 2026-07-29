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

/** Identity tag: enables JS syntax highlighting/linting of the embedded program. */
const js = String.raw;

/**
 * A discoverable marker embedded in the self-watchdog's command line (003 §11.2,
 * issue #470). It lets an out-of-band orphan sweep (issue #426) recognize a
 * stray command-poll watchdog by its `ps`/`pgrep -f` signature, without having
 * to match on `sleep` (far too broad).
 */
const WATCHDOG_MARKER = 'agentmonitors:command-poll-watchdog';

/**
 * POSIX self-watchdog program (003 §11.2, issue #470). A `command-poll` child is
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
 * This runs on the daemon's OWN Node binary (`process.execPath`), not a shell
 * (issue #472 review round 6). A shell watchdog has no timer of its own: it can
 * only borrow one from `sleep`, and every property of the backstop then rests on
 * a `PATH` lookup the daemon does not control. Two review rounds were spent
 * hardening that — a `sleep` that resolves but exits at once, one that silently
 * caps its operand, one that never returns at all — and each fix could only ever
 * detect the failure, never obtain a working timer. `setTimeout` cannot be
 * missing, cannot return early, cannot hang, and needs nothing on `PATH`, so the
 * entire failure class is gone rather than guarded. It also removes the SIGPIPE
 * hazard (Node ignores SIGPIPE; a write to the dead daemon's pipe surfaces as an
 * ordinary `EPIPE` event) and the `date` dependency the clock cross-check needed.
 *
 * The group is signalled by its **numeric** process-group id, but a bare kill
 * after a fixed delay is unsafe: a numeric pgid is recyclable. If the command
 * exits on its own before the deadline, its pgid can be reused by an unrelated
 * same-user process group, which the delayed signal would then wrongly kill. So
 * the watchdog binds to an **un-recyclable liveness pipe** rather than trusting
 * the pgid alone. The command receives the only write end of that pipe at
 * {@link COMMAND_LIVENESS_FD}, and each descendant that inherits that fd holds a
 * copy of it; the watchdog holds the read end (arriving as fd 3). Reading it to
 * EOF proves every process still holding a copy of that write end has gone, and a
 * pipe is a kernel object that cannot be recycled. EOF therefore proves the fd
 * holders are gone — NOT, in general, that the process group is empty: a
 * descendant spawned through an API that closes non-explicit fds on exec never
 * inherits the fd, so it is invisible to the pipe (the documented boundary — see
 * {@link COMMAND_LIVENESS_FD} and 003 §11.2/§11.7). The watchdog races the
 * deadline against that EOF: it signals the group only if the deadline elapses
 * while the pipe is still held open (so a group member is provably still alive,
 * and the pgid provably still that group's), and otherwise disarms without ever
 * signalling.
 *
 * Ordering is what makes the bound real (issue #472 review round 6). The watchdog
 * is spawned and armed BEFORE the command exists, and learns the pgid afterwards
 * over its stdin — rather than being launched after the command, which left the
 * command running unbounded for the whole of the watchdog's own startup. Until a
 * pgid arrives there is deliberately nothing this process can signal:
 *
 * - Liveness EOF before a pgid means the write end was only ever held by the
 *   daemon, so the command was never spawned (or is already gone) — disarm.
 * - The deadline elapsing before a pgid means the handoff never completed and no
 *   target can be named — exit without signalling, never guess.
 *
 * `argv[1]` is the backstop deadline in milliseconds. "armed" is printed on
 * stdout once the deadline timer is running and the liveness read end is being
 * read; the daemon does not spawn the command at all until it sees that line, and
 * treats its absence as an arming failure (issue #470 review).
 */
const SELF_WATCHDOG_SOURCE = js`
// ${WATCHDOG_MARKER}
'use strict';
const { createReadStream } = require('node:fs');

const deadlineMs = Number(process.argv[1]);
let pgid;
let done = false;

// Never let a write to the daemon's pipe take this process down: the daemon
// dying first is the entire scenario this exists for. Node ignores SIGPIPE, so
// the failed write arrives as an EPIPE 'error' event, which is simply ignored.
process.stdout.on('error', () => {});

function finish() {
  if (done) return;
  done = true;
  process.exit(0);
}

// The backstop. Firing with a pgid in hand means the deadline elapsed while the
// liveness pipe was still held open (EOF would have disarmed us first), so a
// member of that group is provably still alive and the pgid is provably still
// that group's.
const deadline = setTimeout(() => {
  if (pgid !== undefined) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Group already gone — nothing left to signal.
    }
  }
  finish();
}, deadlineMs);

// The liveness read end. Reaching EOF means every holder of the inherited write
// end has gone, so there is nothing left to bound: disarm without signalling a
// pgid that may by then have been recycled.
//
// Read through 'fs', NOT 'net': a net.Socket over a FIFO fd never delivers 'end'
// on macOS (verified — the read simply never completes), which would silently
// cost the watchdog its disarm and leave it running to its deadline on every
// well-behaved command. An fs read stream reports EOF promptly on both
// platforms. Its read occupies a threadpool thread while the pipe is held open,
// which is free here: bounding this one group is all this process exists to do.
let liveness;
try {
  liveness = createReadStream(null, { fd: 3, autoClose: true });
} catch {
  // No usable liveness proof means we could only ever kill on a bare pgid.
  // Refuse to arm instead; the daemon fails the command closed.
  clearTimeout(deadline);
  process.exit(0);
}
liveness.on('end', () => {
  clearTimeout(deadline);
  finish();
});
liveness.on('error', () => {
  clearTimeout(deadline);
  finish();
});
liveness.resume();

// The pgid handoff, which the daemon performs only after the command exists.
let handoff = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  handoff += chunk;
  const line = handoff.indexOf('\n');
  if (line === -1) return;
  const parsed = Number(handoff.slice(0, line).trim());
  if (Number.isInteger(parsed) && parsed > 0) pgid = parsed;
});
process.stdin.on('error', () => {});
process.stdin.resume();

// Armed: the deadline is running and the liveness pipe is being read. Only now
// does the daemon spawn the command.
process.stdout.write('armed\n');
`;

/** An anonymous liveness pipe's ends (003 §11.2, issue #470). */
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
 * entire lifetime — closing it early, or never inheriting it at all, is
 * indistinguishable, from the watchdog's side, from the whole group having
 * exited. fd 3 was the single most collision-prone fd for the deliberate-close
 * case: POSIX shells routinely use low, ad hoc fds for scratch redirections
 * (`exec 3<file`, `read -u`), and bash's own `exec {var}<>file` auto-assignment
 * starts at fd 10 — so a command as ordinary as `sh -c 'exec 3>&-; ...'`, or one
 * that reopens/closes fd 3 for its own purposes, would unknowingly close its
 * inherited copy of the write end and trip a spurious EOF, disarming the
 * watchdog while the command keeps running. Moving the write end to fd 20 — well
 * past the fds ordinary shell/script idioms reach for — makes that specific
 * class of collision effectively impossible, but it does NOT close two other,
 * more consequential residuals in the same "false EOF" family (both confirmed on
 * this head, issue #472 second review round):
 *
 * 1. A `closefrom(3)`-style hardened program (closing every fd `>= 3`, or `>= N`
 *    for some `N <= 20`) still closes this fd too, because there is no fd number
 *    such hardening would skip. Narrow and deliberate; unavoidable by fd
 *    placement alone.
 * 2. **A descendant the monitored command spawns via any process API documented
 *    to default to close-on-exec for non-explicit fds (Python's `subprocess`
 *    with its default `close_fds=True`, Go's `os/exec`, Ruby's `Process.spawn`)
 *    never inherits this fd at all.** This is not a hardening edge case; it is
 *    completely ordinary code. When the immediate/intermediate process that DOES
 *    hold this fd exits (having handed real work off to that descendant), the
 *    pipe EOFs even though the descendant is still alive, and the watchdog
 *    disarms — exactly the #470 orphan failure this whole mechanism exists to
 *    prevent. Fd inheritance into a further descendant is entirely the
 *    exec-ing process's own choice; from outside that process tree there is no
 *    portable OS mechanism to force it. Closing this fully would need a
 *    liveness proof that does not depend on fd inheritance at all — e.g.
 *    periodically re-verifying group membership via `kill -0 -"$pgid"` — but
 *    that reintroduces, in a bounded-but-nonzero form, exactly the
 *    recycled-pgid hazard this liveness-pipe design was built to close (a pgid
 *    can be reused by an unrelated group between the last successful check and
 *    the actual kill; shrinking the poll interval shrinks that window but
 *    cannot remove it, unlike the zero-risk proof a still-open fd gives).
 *    Given the standing instruction to never reintroduce that hazard, this
 *    residual is left unresolved here rather than "fixed" with a materially
 *    different safety property — see the issue #472 second-round review thread
 *    for the full analysis and the reproduction that confirmed it.
 *
 *    For Node's own `child_process.spawn`, whether a descendant receives a
 *    copy of this fd turns out to be PLATFORM-DEPENDENT, not a documented
 *    cross-platform default (issue #472 review round 5) — Node does not
 *    itself guarantee closing every non-explicit fd on `spawn()`; that is a
 *    property of the underlying OS process-creation call. Confirmed while
 *    reproducing this scenario in CI: on macOS, `spawn(cmd, args, { stdio:
 *    'ignore' })` does NOT pass this fd to the descendant (the gap above
 *    reproduces exactly). On the Linux/Node combination CI runs, the SAME call
 *    DOES pass it through — verified directly via `/proc/<pid>/fd/20` showing
 *    a live symlink to the (deleted) liveness FIFO in the descendant's own fd
 *    table — so there the pipe never reaches EOF while that descendant runs,
 *    and the ordinary backstop deadline reaps it by pgid instead; the gap
 *    does not reproduce on that platform. Both
 *    outcomes are pinned by platform-scoped tests in
 *    `plugins/source-command-poll/src/index.test.ts` (the "self-watchdog
 *    boundary — a close-on-exec-spawned descendant" describe block) so
 *    neither platform's actual behavior can silently drift unnoticed.
 *
 * In practice, the guarantee this mechanism delivers is: the monitored command's
 * own leader process, and any descendant that continues to hold an inherited
 * copy of this fd (typically: plain shell/exec-based backgrounding, e.g.
 * `cmd &`, with no intervening program that clears it), are bounded even if the
 * daemon dies. A descendant spawned through a close-on-exec-by-default runtime
 * API is not currently covered by that guarantee.
 */
const COMMAND_LIVENESS_FD = 20;

/**
 * Create an anonymous liveness pipe for the self-watchdog (003 §11.2, issue #470),
 * or `undefined` if one could not be created.
 *
 * Node exposes no `pipe(2)`, so this mints one as a transient, owner-only FIFO,
 * opens its ends, and unlinks the name immediately — the open fds keep the pipe
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

/**
 * How long the daemon waits for the watchdog's "armed" line before treating
 * arming as failed (003 §11.2, issue #472 review round 6).
 *
 * Arming has no dependency that can block indefinitely any more, but the deadline
 * exists so that no future one can either: without it, an arming handshake that
 * never resolves leaves `observe()` pending forever, wedging an in-process host
 * (`daemon once`) and stranding a detached watchdog subtree with it — the failure
 * mode a hung `sleep` produced on the previous shell-based watchdog. Sized well
 * above a Node process launch on a loaded machine; exceeding it fails the command
 * closed, so a slow launch costs an observation, never an unbounded command.
 */
const ARMING_DEADLINE_MS = 15_000;

/** A spawned self-watchdog and its arming handshake (003 §11.2, issue #470). */
interface SelfWatchdog {
  process: ChildProcess;
  /**
   * Resolves `true` once the watchdog confirms (via its "armed" line) that its
   * deadline timer is running and it is reading the liveness pipe; `false` if it
   * exited, errored, or failed to say so within {@link ARMING_DEADLINE_MS}.
   * `false` means no independent bound exists, so the caller must NOT run the
   * command.
   */
  readonly armed: Promise<boolean>;
  /**
   * Hand the just-spawned command's process-group id to the watchdog. Until this
   * lands the watchdog has no target and will never signal anything.
   */
  sendPgid(pgid: number): void;
  /**
   * SIGKILL the watchdog's own process group, best-effort. It is `detached`, so
   * one group signal reaps it and anything it may have spawned — no stray subtree
   * survives an arming failure (003 §11.2, issue #472 review round 6).
   */
  reap(): void;
}

/**
 * Spawn the independent self-watchdog, wired to `rfd` (the liveness read end) as
 * its fd 3, and armed for `deadlineMs` (003 §11.2, issue #470). Returns the
 * watchdog and its arming handshake, or `undefined` if it could not be spawned.
 *
 * Called BEFORE the command exists: the command's process-group id is delivered
 * afterwards via {@link SelfWatchdog.sendPgid}, so the bound is in place before
 * the command can run at all (issue #472 review round 6).
 *
 * The watchdog is itself `detached` (its own process group) so that (a) it
 * survives the daemon's death to do its job, and (b) it can be reaped whole via a
 * single group signal. It is `unref`'d so it never keeps the daemon's event loop
 * alive; only its short-lived stdout handshake is read. It runs on
 * `process.execPath` — the daemon's own Node binary — so it depends on nothing in
 * `PATH`, and any launch failure fails closed through the handshake.
 */
function spawnSelfWatchdog(
  rfd: number,
  deadlineMs: number,
): SelfWatchdog | undefined {
  let watchdog: ChildProcess;
  try {
    watchdog = spawn(
      process.execPath,
      ['-e', SELF_WATCHDOG_SOURCE, '--', String(Math.ceil(deadlineMs))],
      { detached: true, stdio: ['pipe', 'pipe', 'ignore', rfd] },
    );
  } catch {
    return undefined;
  }
  const reap = (): void => {
    const pid = watchdog.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone — nothing left to signal.
    }
  };
  const armed = new Promise<boolean>((resolve) => {
    let settled = false;
    const stdout = watchdog.stdout;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Release the event loop the moment the handshake is decided — from here
      // on the watchdog is on its own and must never hold this process open.
      // `stdout` is a Socket at runtime (a child stdio pipe), but `unref` is
      // not on the `Readable` type it is declared as, so reach it through an
      // optional shape.
      (stdout as { unref?: () => void } | null)?.unref?.();
      resolve(value);
    };
    if (stdout) {
      let seen = '';
      stdout.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8');
        if (seen.includes('armed')) settle(true);
      });
      // Deliberately left REF'd until the handshake settles (issue #472 review
      // round 5). The caller's `observe()` cannot settle before this decision,
      // and everything else in flight is unref'd — the watchdog process and its
      // timers. Unref'ing here too left nothing keeping the event loop alive, so
      // a short-lived host process (`daemon once`, which ticks in-process) could
      // simply RUN OUT OF WORK and exit zero mid-tick, before `observe()` ever
      // settled: no events, no error, no output at all.
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
    // A handshake that never resolves must not wedge the caller (issue #472
    // review round 6): give up, reap the watchdog's whole group so nothing is
    // stranded, and report the arming failure.
    deadline = setTimeout(() => {
      reap();
      settle(false);
    }, ARMING_DEADLINE_MS);
    deadline.unref();
  });
  watchdog.unref();
  return {
    process: watchdog,
    armed,
    sendPgid(pgid: number): void {
      try {
        watchdog.stdin?.end(`${String(pgid)}\n`);
      } catch {
        // A dead watchdog cannot be handed a target; its own liveness-pipe EOF
        // or deadline will retire it.
      }
    },
    reap,
  };
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

    /** Close every liveness-pipe fd, best-effort (any may already be closed). */
    function closeLivenessPipe(): void {
      if (!livenessPipe) return;
      try {
        closeSync(livenessPipe.wfd);
      } catch {
        // Already closed — nothing to do.
      }
      try {
        closeSync(livenessPipe.rfd);
      } catch {
        // Already closed — nothing to do.
      }
    }

    // Arm the backstop BEFORE the command exists (003 §11.2, issue #472 review
    // round 6). Arming used to happen after the spawn, which left a real window —
    // the whole of the watchdog's launch and handshake — in which the command was
    // already running with nothing bounding it; a command whose first act was to
    // kill the daemon escaped entirely (measured at 2/40 runs on the previous
    // head, and far more on a loaded machine). The watchdog is therefore launched
    // and armed first and learns its target afterwards, so there is no instant at
    // which the command is running without an independently surviving bound.
    if (livenessPipe) {
      const watchdog = spawnSelfWatchdog(
        livenessPipe.rfd,
        scope.timeoutMs + SIGKILL_GRACE_MS + SELF_WATCHDOG_SLACK_MS,
      );
      // The daemon hands the read end to the watchdog and keeps no copy of it.
      // (The WRITE end stays open here until the command has inherited it —
      // closing it early would EOF the pipe and disarm the watchdog before the
      // command it is meant to bound even exists.)
      try {
        closeSync(livenessPipe.rfd);
      } catch {
        // Already closed — nothing to do.
      }
      if (watchdog === undefined) {
        closeLivenessPipe();
        resolve({
          kind: 'failure',
          error: 'Could not arm self-bounding watchdog: launch failed',
          stderrTail: '',
        });
        return;
      }
      void watchdog.armed.then((ok) => {
        if (!ok) {
          // Fail closed (issue #470 review): with no independent bound, the
          // command is not started at all — the previous ordering could only
          // terminate it after the fact, which is strictly worse and, for a
          // command with an immediate side effect, too late. Reap the watchdog's
          // own group so a partially-started one leaves nothing behind.
          watchdog.reap();
          closeLivenessPipe();
          resolve({
            kind: 'failure',
            error:
              'Could not arm self-bounding watchdog: arming was not confirmed',
            stderrTail: '',
          });
          return;
        }
        startCommand(watchdog);
      });
      return;
    }
    startCommand(undefined);

    /**
     * Spawn and supervise the command itself, once `watchdog` (POSIX) is armed
     * and waiting for its target — or immediately on Windows, which has no
     * process groups and no portable in-group watchdog, so its daemon-resident
     * timers remain the only bound (a documented platform limit).
     */
    function startCommand(watchdog: SelfWatchdog | undefined): void {
      // `file` is guaranteed defined: parseScopeConfig rejects an empty command. `spawn`
      // is synchronous up to and including this call (the actual process launch is
      // async; failures there surface later via the child's `'error'` event, handled
      // below) — but it CAN throw synchronously for arguments `execve(2)` can never
      // accept at all, e.g. a `command`/`arg`/`cwd`/`env` value containing an embedded
      // NUL byte (issue #472 review). Without a try/catch here, that throw skips every
      // line below — including the `closeSync` calls that release the liveness pipe's
      // two fds — leaking both on every single such call; a monitor whose command
      // reaches this state on every tick leaks the daemon's fd table without bound.
      let child: ChildProcess;
      try {
        child = spawn(
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
            // fd COMMAND_LIVENESS_FD (POSIX only) is the liveness pipe's write end:
            // the command receives it, and every descendant that inherits it holds a
            // copy, so the watchdog's read end reaches EOF exactly when all of those
            // fd holders have gone — which is not the same as the whole process group
            // having exited, since a descendant spawned through an API that closes
            // non-explicit fds on exec never inherits it (003 §11.2/§11.7). It is
            // deliberately a high fd rather than the next-available low one — see that
            // constant's doc comment (issue #472 review) for why. The padding entries between
            // fd 3 and it are `'ignore'` (mapped to `/dev/null`), matching how Node
            // already treats stdin/stdout/stderr slots the command doesn't use.
            stdio: livenessPipe
              ? ([
                  'ignore',
                  'pipe',
                  'pipe',
                  ...(Array(COMMAND_LIVENESS_FD - 3).fill(
                    'ignore',
                  ) as 'ignore'[]),
                  livenessPipe.wfd,
                ] satisfies StdioOptions)
              : ['ignore', 'pipe', 'pipe'],
          },
        );
      } catch (error) {
        closeLivenessPipe();
        resolve({
          kind: 'failure',
          error: error instanceof Error ? error.message : String(error),
          stderrTail: '',
        });
        return;
      }

      // Hand the watchdog its target now that the group exists. Until this lands the
      // watchdog is armed but has nothing it can signal, which is exactly the
      // behavior wanted if the daemon dies mid-handoff: no pgid is ever guessed.
      if (child.pid !== undefined) watchdog?.sendPgid(child.pid);

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
        closeLivenessPipe();
        resolve({
          kind: 'failure',
          error: 'Command stdio pipes were unavailable',
          stderrTail: '',
        });
        return;
      }

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
        // The self-watchdog is deliberately NEVER proactively killed here, on ANY
        // resolution path (issue #472 review). It used to be reaped immediately on a
        // non-timeout resolution on the assumption that the direct child's own
        // successful/failed exit means the whole process group is done — but that
        // is not true: a leader can exit 0 having backgrounded a descendant
        // (`sh -c 'sleep 300 & ...; exit 0'`, the same idiom #303's group-kill exists
        // for) that is still very much alive. Proactively killing the watchdog at
        // that point destroyed the one thing still capable of noticing and reaping
        // that descendant, leaking it silently on every such observation — with no
        // daemon-side timer ever armed for it either, since the wall-clock
        // SIGTERM→SIGKILL escalation only exists on the TIMEOUT path. The watchdog
        // now runs to its own conclusion unconditionally: it disarms ITSELF, via the
        // same liveness-pipe EOF used on the timeout path, the moment the whole
        // group it can observe is actually gone (near-instant for a well-behaved
        // command with no live descendant), and otherwise reaps the group at its own
        // backstop deadline — regardless of how `observe()` itself resolved.
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

      // The watchdog is already armed and now holds this group's pgid (handed over
      // right after the spawn above), so there is nothing left to arm here: the
      // bound existed before the command did (003 §11.2, issue #472 review round 6).
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
