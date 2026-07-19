/**
 * `agentmonitors daemon run --detach` (issue #389 P1).
 *
 * `init` tells manual (non-plugin) users to "start the daemon yourself:
 * agentmonitors daemon run", which then blocks their terminal — leaving them
 * to discover `& disown` plus their own log redirection. `--detach`
 * backgrounds the daemon, waits until it actually answers on its socket, and
 * reports where to find it.
 *
 * These cases drive the REAL CLI binary as a subprocess, because the property
 * under test is precisely that the PARENT process returns while the daemon
 * keeps running — something an in-process action call cannot demonstrate.
 *
 * NOTE: excluded from the default parallel vitest run (vitest.config.ts) and
 * run only via vitest.serial.config.ts, like the other daemon-spawning suites
 * — the spawned daemon must not be CPU-starved by concurrent test workers.
 *
 * @see ../../../../docs/specs/005-cli-reference.md §9.2 (`daemon run`, Background mode)
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callDaemon, daemonAvailable } from '../daemon-ipc.js';
import { cliEntry } from '../detached-spawn.js';

const CLI_PATH = cliEntry();

interface Workspace {
  dir: string;
  monitorsDir: string;
  socket: string;
  db: string;
}

const workspaces: Workspace[] = [];
const startedSockets: string[] = [];
/** Captured `pid:` from a successful `--detach` run's stdout, keyed by socket. */
const startedPids = new Map<string, number>();

function makeWorkspace(label: string): Workspace {
  const dir = mkdtempSync(path.join(tmpdir(), `agentmon-389-${label}-`));
  const monitorsDir = path.join(dir, '.claude', 'monitors');
  mkdirSync(monitorsDir, { recursive: true });
  // Keep the socket short and out of the (possibly deep) temp workspace path
  // so it stays under the platform's sun_path limit.
  const socket = path.join(
    '/tmp',
    `am389-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
  );
  const ws: Workspace = {
    dir,
    monitorsDir,
    socket,
    db: path.join(dir, 'i.db'),
  };
  workspaces.push(ws);
  return ws;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the real CLI to completion, capturing both streams.
 *
 * `AGENTMONITORS_DB` is always pinned to the case's own temp db. These temp
 * workspaces are not `enabled`, so `resolveWorkspaceDbPath()` would otherwise
 * fall back to the machine-wide default db (005 §2) — and this file shares a
 * single non-isolated fork with the other serial daemon suites
 * (`vitest.serial.config.ts`), so a daemon holding that shared db would leak
 * into their runs.
 */
function runCli(
  ws: Workspace,
  args: string[],
  extraEnv: Record<string, string> = {},
): RunResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: ws.dir,
    timeout: 60_000,
    env: { ...process.env, AGENTMONITORS_DB: ws.db, ...extraEnv },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/**
 * Whether `pid` still refers to a live process, via the standard
 * signal-0-probe idiom (`kill(pid, 0)` delivers no signal but still performs
 * the permission/existence check — throws `ESRCH` once the process is gone).
 * Used instead of `daemonAvailable` for teardown/liveness checks that must
 * hold for a daemon that NEVER bound its socket (round-2 finding
 * 3611413817) — `daemonAvailable` would report `false` for that case
 * regardless of whether the process itself is still running.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record whatever pid a CLI invocation's combined output names for `ws`'s
 * socket, for `afterEach` to fall back to a direct `kill` on (issue #389
 * review finding 5 / round-2 finding 3611413817). A SUCCESSFUL `--detach`
 * prints `pid: N` on stdout; a ready-TIMEOUT prints `(pid N)` on stderr via
 * `reportError` — the exact case this fallback exists for, since the spawned
 * child never bound the socket and `daemonAvailable` will never see it. Every
 * caller that spawns a detached child (success OR failure) must route
 * through this so the pid is captured regardless of which stream or exit
 * code it came from.
 */
function recordSpawnedPid(ws: Workspace, result: RunResult): void {
  const combined = `${result.stdout}${result.stderr}`;
  const pidMatch = /pid:?\s+(\d+)/.exec(combined);
  if (pidMatch?.[1] !== undefined) {
    startedPids.set(ws.socket, Number(pidMatch[1]));
  }
}

/**
 * Start a detached daemon, remembering its socket (and, if it reports one,
 * its pid) for teardown. Capturing the pid lets `afterEach` fall back to a
 * direct `kill` when `daemon stop` over IPC fails (issue #389 review finding
 * 5) — the exact scenario these tests exist to catch is a daemon that never
 * bound its socket, so IPC teardown alone would strand it.
 */
function runDetach(
  ws: Workspace,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): RunResult {
  startedSockets.push(ws.socket);
  const result = runCli(
    ws,
    [
      'daemon',
      'run',
      ws.monitorsDir,
      '--workspace',
      ws.dir,
      '--socket',
      ws.socket,
      '--poll-ms',
      '1000',
      '--detach',
      ...extraArgs,
    ],
    extraEnv,
  );
  recordSpawnedPid(ws, result);
  return result;
}

afterEach(async () => {
  for (const socket of startedSockets.splice(0)) {
    try {
      await callDaemon('stop', {}, { socketPath: socket });
    } catch {
      /* already stopped, never started, or IPC is unreachable */
    }
    // Do not merely ASK the daemon to stop — wait until it has actually let go
    // of the socket. The next file in this fork must not race a shutting-down
    // daemon (the whole reason these suites run serially).
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await daemonAvailable(socket))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Fallback for issue #389 review finding 5 / round-2 finding 3611413817:
    // `callDaemon('stop')` only reaches a daemon that actually bound the
    // socket. A daemon that never came up (exactly the regression class these
    // tests exist to catch — ready-timeout, spawn failure, a race loser)
    // leaves nothing to stop over IPC AND never satisfies `daemonAvailable`,
    // so gating this kill on the socket being reachable made it a no-op for
    // precisely the never-bound case it was meant to cover. Kill the
    // recorded pid whenever it is still alive, independent of the socket.
    const pid = startedPids.get(socket);
    if (pid !== undefined && isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    // Remove a stale socket FILE too — a daemon that died mid-bind (or that
    // we just SIGTERM'd above) can leave one behind, which would otherwise
    // confuse a later test's "already running" probe in this shared,
    // non-isolated serial fork.
    try {
      rmSync(socket, { force: true });
    } catch {
      /* already gone */
    }
    startedPids.delete(socket);
  }
  for (const ws of workspaces.splice(0)) {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

describe('daemon run --detach (issue #389 P1)', () => {
  it('returns to the shell while the daemon keeps answering on its socket', async () => {
    const ws = makeWorkspace('detach');
    const logPath = path.join(ws.dir, 'daemon.log');

    // The parent MUST exit on its own. spawnSync returning at all is the
    // proof: a foreground `daemon run` would block until the 60s timeout.
    const result = runDetach(ws, ['--log', logPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'AgentMon daemon started in the background.',
    );
    // The user is told where to find the daemon and its output.
    expect(result.stdout).toMatch(/pid:\s+\d+/);
    expect(result.stdout).toContain(ws.socket);
    expect(result.stdout).toContain(logPath);

    // And it really is running, after the parent already returned.
    expect(await daemonAvailable(ws.socket)).toBe(true);

    // The log captured the daemon's own startup line rather than discarding it.
    expect(readFileSync(logPath, 'utf-8')).toContain(
      `AgentMon daemon listening on ${ws.socket}`,
    );

    // `daemon stop` reaches the backgrounded daemon like any other.
    const stopped = runCli(ws, ['daemon', 'stop', '--socket', ws.socket]);
    expect(stopped.exitCode).toBe(0);
  }, 60_000);

  // Issue #389 review finding 4: the pre-existing version of this test only
  // asserted survival at 2,500ms — but `shouldReap`'s boot-grace window
  // (`BOOT_GRACE_MS`, `reap-decision.ts`) is 10,000ms, so EVERY freshly
  // booted daemon survives 2.5s regardless of whether `--reap-after-ms 0`
  // ever reached it. A regression that silently dropped the flag (e.g.
  // `spawnDetachedDaemon` forgetting to forward `reapAfterMs`, leaving the
  // spawned child on its `daemon run` default of 5 minutes) would have passed
  // this test just the same — it never actually exercised the flag's
  // forwarding. Asserting past the boot-grace boundary would require either a
  // multi-minute sleep (the real default) or a fragile shrunk-grace hack.
  // Instead, assert the CONFIGURATION directly: `daemon status` echoes the
  // reap window the LIVE daemon is actually running with (`reapAfterMs`,
  // `daemon-ipc.ts` `DaemonStatusResult`) — reading it back is a deterministic
  // proof that `0` reached the spawned process end-to-end (CLI flag →
  // `spawnDetachedDaemon`'s args → `daemon run`'s own parse → `runLoop` →
  // `createDaemonServer`), with no timing dependency at all.
  it('composes with --reap-after-ms 0, says reaping is disabled, and the live daemon reports it disabled', async () => {
    const ws = makeWorkspace('persist');

    const result = runDetach(ws, ['--reap-after-ms', '0']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('reaping disabled');
    expect(await daemonAvailable(ws.socket)).toBe(true);

    const status = runCli(ws, [
      'daemon',
      'status',
      '--socket',
      ws.socket,
      '--format',
      'json',
    ]);
    expect(status.exitCode).toBe(0);
    const parsed = JSON.parse(status.stdout) as {
      running: boolean;
      reapAfterMs: number;
    };
    expect(parsed.running).toBe(true);
    expect(parsed.reapAfterMs).toBe(0);

    // Still up a short beat later — a basic liveness sanity check, NOT the
    // decisive assertion (that's `reapAfterMs` above).
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await daemonAvailable(ws.socket)).toBe(true);
  }, 60_000);

  // Companion to the test above: proves a POSITIVE `--reap-after-ms` value
  // really does reach the daemon too (not just that `0` happens to be the
  // default absence of a flag) — `daemon status` reports back the exact
  // value requested, end to end.
  it('a positive --reap-after-ms value is forwarded to and reported by the live daemon', async () => {
    const ws = makeWorkspace('reap-status');

    const result = runDetach(ws, ['--reap-after-ms', '42000']);
    expect(result.exitCode).toBe(0);

    const status = runCli(ws, [
      'daemon',
      'status',
      '--socket',
      ws.socket,
      '--format',
      'json',
    ]);
    expect(status.exitCode).toBe(0);
    const parsed = JSON.parse(status.stdout) as { reapAfterMs: number };
    expect(parsed.reapAfterMs).toBe(42000);
  }, 60_000);

  it('reports the idle-stop window when the reaper is left enabled', async () => {
    const ws = makeWorkspace('reap');

    const result = runDetach(ws, ['--reap-after-ms', '600000']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('600s with no active session');
    expect(result.stdout).toContain('--reap-after-ms 0');
  }, 60_000);

  // Negative: detaching onto a socket that already has a daemon must not
  // spawn a second one — it hits the same already-running guard the
  // foreground path uses.
  it('refuses to detach a second daemon onto an already-bound socket', async () => {
    const ws = makeWorkspace('dup');

    expect(runDetach(ws).exitCode).toBe(0);
    const second = runDetach(ws);
    expect(second.exitCode).not.toBe(0);
    expect(`${second.stdout}${second.stderr}`).toContain(
      'daemon is already running',
    );
  }, 60_000);

  // Issue #389 review finding 3: Commander accepted `--log` silently even
  // without `--detach`, where it is only ever read inside the detach branch —
  // an empty log during an incident, no diagnostic, the exact "silently
  // ignored flag" papercut class this PR exists to close.
  it('errors when --log is given without --detach', () => {
    const ws = makeWorkspace('logwithoutdetach');
    const logPath = path.join(ws.dir, 'daemon.log');

    const result = runCli(ws, [
      'daemon',
      'run',
      ws.monitorsDir,
      '--workspace',
      ws.dir,
      '--socket',
      ws.socket,
      '--log',
      logPath,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      '--log only applies with --detach',
    );
    expect(existsSync(logPath)).toBe(false);
  });

  // Issue #389 review finding 2: on a ready-timeout the spawned child must
  // not be left running unmanaged. Forcing a REAL 15s timeout would make this
  // suite slow, so this points the socket into an owner-unwritable directory:
  // the spawned child's own bind then fails (EACCES) and it exits almost
  // immediately — but the PARENT (which only watches the socket, not the
  // child's exit) still waits out the full readiness window before reporting,
  // proving the timeout path kills (a no-op here, since the child is already
  // gone) and names the pid rather than silently succeeding or hanging.
  it('reports a timed-out ready-wait honestly and names the pid, when the child dies mid-bind', async () => {
    const ws = makeWorkspace('deadbind');
    const noPermDir = path.join(ws.dir, 'no-perm');
    mkdirSync(noPermDir, { recursive: true });
    chmodSync(noPermDir, 0o000);
    const socket = path.join(noPermDir, 'd.sock');

    try {
      const result = runCli(ws, [
        'daemon',
        'run',
        ws.monitorsDir,
        '--workspace',
        ws.dir,
        '--socket',
        socket,
        '--poll-ms',
        '1000',
        '--detach',
      ]);

      expect(result.exitCode).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/did not answer on .* within 15s/);
      expect(output).toContain('sent SIGTERM');
      expect(output).toMatch(/\(pid \d+\)/);

      // Round-2 finding 3611413817: this timeout path prints its pid on
      // STDERR (via `reportError`), not stdout, and this test previously
      // called `runCli` directly rather than the recording helper — so a
      // regression that dropped the production SIGTERM here would leave an
      // untracked child with no teardown safety net at all, and this suite
      // would not catch it. Route through the SAME recording helper every
      // other case uses, then decisively PROVE the child is actually gone —
      // not merely that we asked it to die — via the pid this output names.
      recordSpawnedPid(ws, result);
      const pid = startedPids.get(ws.socket);
      expect(pid).toBeDefined();
      if (pid !== undefined) {
        expect(isProcessAlive(pid)).toBe(false);
        startedPids.delete(ws.socket);
      }
    } finally {
      chmodSync(noPermDir, 0o700);
    }
  }, 30_000);

  // Issue #389 review finding 1 (end-to-end): two `--detach` invocations
  // targeting the SAME socket, started concurrently, race for the bind. The
  // startup lock (daemon-ipc.ts `acquireStartupLock`) guarantees exactly one
  // wins regardless of OS scheduling — the invariant this test asserts is
  // that BOTH invocations report honestly: the winner's reported pid matches
  // the daemon `daemon status` confirms is actually serving the socket, and
  // the loser never falsely claims success (it can hit either this PR's new
  // "lost the startup race" identity check, or the pre-existing early
  // "already running" guard, depending on exactly how the two races
  // interleave — both are honest, non-zero-exit outcomes; neither invocation
  // may exit 0 while reporting a pid that ISN'T the one actually serving).
  it('when two --detach invocations race the same socket, neither falsely claims success', async () => {
    const ws = makeWorkspace('detachrace');
    const args = [
      'daemon',
      'run',
      ws.monitorsDir,
      '--workspace',
      ws.dir,
      '--socket',
      ws.socket,
      '--poll-ms',
      '1000',
      '--detach',
    ];
    startedSockets.push(ws.socket);

    const runAsync = (): Promise<RunResult> =>
      new Promise((resolve) => {
        const child = spawnAsync('node', [CLI_PATH, ...args], {
          cwd: ws.dir,
          env: { ...process.env, AGENTMONITORS_DB: ws.db },
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
        child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
        child.on('exit', (code) => {
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
      });

    const [first, second] = await Promise.all([runAsync(), runAsync()]);
    const results = [first, second];

    const winners = results.filter((r) => r.exitCode === 0);
    const losers = results.filter((r) => r.exitCode !== 0);
    // Exactly one invocation succeeds — the startup lock admits only one
    // winner regardless of which process happened to reach it first.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser's failure must be one of the two HONEST outcomes — never a
    // false "started in the background" while a different pid actually
    // serves the socket.
    const loserOutput = `${losers[0]?.stdout}${losers[0]?.stderr}`;
    expect(loserOutput).toMatch(
      /daemon is already running|lost the startup race/,
    );
    expect(loserOutput).not.toContain(
      'AgentMon daemon started in the background.',
    );

    // The winner's reported pid is confirmed by `daemon status` as the one
    // actually serving the socket.
    const winnerPidMatch = /pid:\s+(\d+)/.exec(winners[0]?.stdout ?? '');
    expect(winnerPidMatch).not.toBeNull();
    startedPids.set(ws.socket, Number(winnerPidMatch?.[1]));

    const status = runCli(ws, [
      'daemon',
      'status',
      '--socket',
      ws.socket,
      '--format',
      'json',
    ]);
    const parsed = JSON.parse(status.stdout) as { pid: number };
    expect(parsed.pid).toBe(Number(winnerPidMatch?.[1]));
  }, 60_000);

  // The log captures daemon stdout/stderr — workspace paths, socket paths, and
  // monitor failure messages. Under a common `umask 022` a plain
  // `openSync(path, 'a')` creates it 0644, readable by every other local user;
  // it must follow Agent Monitors' owner-only runtime-data policy (002 §3.1)
  // instead. Regression coverage for both a custom `--log` and the default.
  it('creates the log owner-only (0600) and its parent 0700, whatever the umask', async () => {
    const ws = makeWorkspace('logmode');
    const logDir = path.join(ws.dir, 'logs');
    const logPath = path.join(logDir, 'daemon.log');

    const previousUmask = process.umask(0o022);
    try {
      expect(runDetach(ws, ['--log', logPath]).exitCode).toBe(0);
    } finally {
      process.umask(previousUmask);
    }

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
  }, 60_000);

  it('applies the same owner-only modes to the DEFAULT log path', async () => {
    const ws = makeWorkspace('logdefault');
    // Redirect the derived per-workspace data dir into the temp workspace so
    // the default log path is exercised without touching the real data root.
    const xdg = path.join(ws.dir, 'xdg');

    const previousUmask = process.umask(0o022);
    let stdout: string;
    try {
      stdout = runDetach(ws, [], { XDG_DATA_HOME: xdg }).stdout;
    } finally {
      process.umask(previousUmask);
    }

    const logPath = /log:\s+(\S+)/.exec(stdout)?.[1];
    expect(logPath).toBeDefined();
    expect(logPath).toContain(xdg);
    expect(statSync(logPath as string).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(logPath as string)).mode & 0o777).toBe(0o700);
  }, 60_000);

  it('tightens a pre-existing world-readable log before appending to it', async () => {
    const ws = makeWorkspace('logtighten');
    const logPath = path.join(ws.dir, 'preexisting.log');
    writeFileSync(logPath, 'from an earlier run\n', 'utf-8');
    chmodSync(logPath, 0o644);

    expect(runDetach(ws, ['--log', logPath]).exitCode).toBe(0);

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    // Appended, never truncated — the earlier run's output survives.
    const contents = readFileSync(logPath, 'utf-8');
    expect(contents).toContain('from an earlier run');
    expect(contents).toContain(`AgentMon daemon listening on ${ws.socket}`);
  }, 60_000);

  it('documents the flag and the persistent-daemon combination in --help', () => {
    const help = runCli(makeWorkspace('help'), ['daemon', 'run', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('--detach');
    expect(help.stdout).toContain('--reap-after-ms 0');
  });
});
