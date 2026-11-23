import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `channel serve --poll-ms` rejects an invalid interval before it starts the
 * MCP server or contacts the daemon (issue #306).
 *
 * Drives the built CLI bundle as a subprocess (004 §2.9: never rebuilt here).
 * Each case sends a real MCP `initialize` request on stdin and keeps stdin open:
 * a server that had connected would answer on stdout and stay alive, so an
 * empty stdout plus a prompt exit proves no handshake took place. A listening
 * fake daemon socket, passed via `--socket`, proves no daemon contact either.
 *
 * @see ../../../../docs/specs/005-cli-reference.md §13
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 */

const CLI_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'index.cjs',
);

/** Bound on how long a rejected invocation may take to exit on its own. */
const EXIT_BUDGET_MS = 15_000;

const INITIALIZE_REQUEST = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'poll-ms-test', version: '0.0.0' },
  },
})}\n`;

interface ServeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  daemonConnections: number;
}

let root: string;
let fakeDaemon: net.Server;
let socketPath: string;
let daemonConnections: number;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'am-channel-poll-ms-'));
  socketPath = path.join(root, 'am.sock');
  daemonConnections = 0;
  fakeDaemon = net.createServer((conn) => {
    daemonConnections += 1;
    conn.destroy();
  });
  await new Promise<void>((resolve) => {
    fakeDaemon.listen(socketPath, resolve);
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    fakeDaemon.close(() => {
      resolve();
    });
  });
  rmSync(root, { recursive: true, force: true });
});

function serveWithPollMs(
  pollMs: string,
  socket: string = socketPath,
): Promise<ServeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        CLI_PATH,
        'channel',
        'serve',
        '--socket',
        socket,
        '--workspace',
        root,
        '--host-session-id',
        'poll-ms-host-session',
        '--poll-ms',
        pollMs,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          XDG_DATA_HOME: path.join(root, 'data'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // The child may exit before reading stdin; that EPIPE is expected.
    child.stdin.on('error', () => undefined);
    child.stdin.write(INITIALIZE_REQUEST);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `channel serve --poll-ms ${pollMs} did not exit within ${String(EXIT_BUDGET_MS)} ms; stderr: ${stderr}`,
        ),
      );
    }, EXIT_BUDGET_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ exitCode, stdout, stderr, daemonConnections });
    });
  });
}

describe('channel serve --poll-ms validation (issue #306)', () => {
  it.each(['-1', '0', '1junk', '2.5', '99', '2147483648'])(
    'rejects --poll-ms %s before the MCP handshake',
    async (pollMs) => {
      const result = await serveWithPollMs(pollMs);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `Error: --poll-ms must be a whole number from 100 to 2147483647 (got ${JSON.stringify(pollMs)}).\n`,
      );
      expect(result.stdout).toBe('');
      expect(result.daemonConnections).toBe(0);
    },
    EXIT_BUDGET_MS + 5_000,
  );

  // Regression: socket resolution used to run before the --poll-ms check. An
  // explicit --socket past the Unix socket path limit then printed its
  // fallback warning (and could probe a legacy socket) ahead of the
  // rejection, so the rejection was no longer the only output.
  it(
    'rejects --poll-ms 0 with exactly one stderr line even when --socket is overlong',
    async () => {
      const overlongSocket = path.join(root, `${'s'.repeat(120)}.sock`);
      expect(overlongSocket.length).toBeGreaterThan(104);
      const result = await serveWithPollMs('0', overlongSocket);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        'Error: --poll-ms must be a whole number from 100 to 2147483647 (got "0").\n',
      );
      expect(result.stdout).toBe('');
      expect(result.daemonConnections).toBe(0);
    },
    EXIT_BUDGET_MS + 5_000,
  );

  // 005 §13: omitting --poll-ms polls every 3000 ms. Commander supplies the
  // default as the option's string value, and --help renders that value.
  it('documents 3000 ms as the --poll-ms default in --help', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, 'channel', 'serve', '--help'],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          XDG_DATA_HOME: path.join(root, 'data'),
        },
        encoding: 'utf8',
        timeout: EXIT_BUDGET_MS,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.replace(/\s+/g, ' ')).toContain(
      'Delivery poll interval in milliseconds, a whole number from 100 to 2147483647 (default: "3000")',
    );
  });
});
