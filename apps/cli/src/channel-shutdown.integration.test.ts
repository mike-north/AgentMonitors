import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLocalState } from './local-state.js';

/**
 * Clean-shutdown guard for the channel transport's heartbeat (issue #425).
 *
 * A heartbeat is a RECURRING timer, and a recurring timer that is never cleared
 * keeps the Node event loop alive forever. For a long-lived server that is not
 * a test annoyance — it is a product defect: `channel serve` is spawned as an
 * MCP subprocess by the host, and a copy that refuses to exit after the host
 * disconnects becomes an orphan holding a daemon socket and a stale heartbeat
 * that other sessions then read as "a transport is listening here".
 *
 * These tests therefore assert the property that matters at the process level —
 * **the process actually exits on its own** — rather than inspecting timers,
 * which would pass even if some other handle kept the loop alive.
 *
 * They spawn a real CLI subprocess, so they live in the SERIAL config
 * (`vitest.serial.config.ts`) alongside the other process-spawning suites.
 *
 * @see ../../../docs/specs/006-agent-integration.md §12 (transport health)
 */

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'dist', 'index.cjs');

/** Bound on how long a disconnected server may take to exit. */
const EXIT_BUDGET_MS = 20_000;

let workspace: string;
let dataHome: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'am-channel-shutdown-'));
  dataHome = path.join(workspace, 'data-home');
  mkdirSync(dataHome, { recursive: true });
  mkdirSync(path.join(workspace, '.claude', 'monitors'), { recursive: true });
  writeLocalState(workspace, {
    enabled: true,
    socket: path.join(workspace, 'am.sock'),
  });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function transportsDir(): string {
  return path.join(dataHome, 'agentmonitors', 'transports');
}

/**
 * Run `channel serve` with stdin already at EOF and wait for it to exit.
 *
 * Deliberately spawned with no reachable daemon: a server that cannot reach its
 * daemon still heartbeats (that is the whole point — it is bound but the daemon
 * is down), so this is the state most likely to leave a timer running.
 */
function runChannelServeToCompletion(hostSessionId: string): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      CLI_PATH,
      'channel',
      'serve',
      '--workspace',
      workspace,
      '--host-session-id',
      hostSessionId,
      '--poll-ms',
      '200',
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        AGENTMONITORS_SOCKET: path.join(workspace, 'am.sock'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  // Drain both streams: an unread pipe fills its buffer and can wedge the
  // child, which would make this test hang for a reason unrelated to the
  // heartbeat it is meant to be guarding.
  child.stdout.resume();
  child.stderr.resume();
  // Close stdin immediately — this is exactly what the host does on
  // disconnect, and the signal `channel serve` shuts down on.
  child.stdin.end();

  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `channel serve did not exit within ${String(EXIT_BUDGET_MS)}ms after stdin EOF — ` +
            'a recurring heartbeat (or another unreleased handle) is holding the event loop open.',
        ),
      );
    }, EXIT_BUDGET_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

describe('channel serve shutdown (issue #425)', () => {
  it('exits on its own after the host disconnects, despite the recurring heartbeat', async () => {
    // The regression this guards: a `setInterval`/re-armed `setTimeout` that is
    // never cleared (or is cleared but not unref'd) turns every disconnected
    // channel server into an immortal orphan.
    const code = await runChannelServeToCompletion('shutdown-exits');
    expect(code).toBe(0);
  }, 30_000);

  it('removes its heartbeat on clean shutdown so it is not read as still listening', async () => {
    // "No channel" and "stale channel" are different findings with different
    // fixes (006 §12). A server that shut down cleanly must leave the former,
    // not linger as the latter for the whole TTL.
    await runChannelServeToCompletion('shutdown-removes');

    // A heartbeat file for THIS session must not survive the shutdown.
    const leftovers = existsSync(transportsDir())
      ? readdirSync(transportsDir()).filter((name) =>
          name.includes('shutdown-removes'),
        )
      : [];
    expect(leftovers).toEqual([]);
  }, 30_000);

  it('leaves no orphaned process behind', async () => {
    // Belt and braces for the CI symptom this whole guard exists for: a test
    // suite that passes but whose runner never exits because a spawned child
    // is still alive.
    await runChannelServeToCompletion('shutdown-no-orphan');
    const survivors = execFileSync('sh', [
      '-c',
      `ps -A -o args= | grep -c '[s]hutdown-no-orphan' || true`,
    ])
      .toString()
      .trim();
    expect(survivors).toBe('0');
  }, 30_000);
});
