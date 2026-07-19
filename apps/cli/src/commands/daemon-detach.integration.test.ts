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
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** Run the real CLI to completion, capturing both streams. */
function runCli(args: string[], cwd: string): RunResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd,
    timeout: 60_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/** Start a detached daemon and remember its socket for teardown. */
function runDetach(ws: Workspace, extraArgs: string[] = []): RunResult {
  startedSockets.push(ws.socket);
  return runCli(
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
    ws.dir,
  );
}

afterEach(async () => {
  for (const socket of startedSockets.splice(0)) {
    try {
      await callDaemon('stop', {}, { socketPath: socket });
    } catch {
      /* already stopped, or never started */
    }
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
    const stopped = runCli(['daemon', 'stop', '--socket', ws.socket], ws.dir);
    expect(stopped.exitCode).toBe(0);
  }, 60_000);

  it('composes with --reap-after-ms 0 and says reaping is disabled', async () => {
    const ws = makeWorkspace('persist');

    const result = runDetach(ws, ['--reap-after-ms', '0']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('reaping disabled');
    expect(await daemonAvailable(ws.socket)).toBe(true);

    // A daemon whose reaper is disabled must still be up after well past the
    // tick interval with zero sessions ever registered — the persistent-daemon
    // property the flag combination exists for.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await daemonAvailable(ws.socket)).toBe(true);
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

  it('documents the flag and the persistent-daemon combination in --help', () => {
    const help = runCli(['daemon', 'run', '--help'], tmpdir());
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('--detach');
    expect(help.stdout).toContain('--reap-after-ms 0');
  });
});
