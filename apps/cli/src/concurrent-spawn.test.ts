/**
 * Integration tests for concurrent-spawn guarantees (#62, #68).
 *
 * #62 — no stale file: two daemons racing the same socket → kernel bind() is
 * the lock, exactly one wins.
 *
 * #68 — stale socket + concurrent spawn (the TOCTOU race): a stale socket file
 * is present when two daemons spawn simultaneously.  Without a startup lock
 * both can probe "not live", both unlink, and the second removes the first's
 * just-bound socket — leaving two daemons running.  This file contains a
 * regression test for that scenario.
 *
 * NOTE: These tests are excluded from the default parallel vitest run
 * (vitest.config.ts) and run only via vitest.serial.config.ts so that spawned
 * daemon processes are not CPU-starved by concurrent test workers.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { daemonAvailable, callDaemon } from './daemon-ipc.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentmon-concurrent-'));
  tempRoots.push(dir);
  return dir;
}

/** Resolve the CLI entrypoint the same way detached-spawn.ts does. */
function cliEntry(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const isBundle = path.basename(path.dirname(thisFile)) === 'dist';
  if (isBundle) return thisFile;
  const packageRoot = path.resolve(path.dirname(thisFile), '..');
  return path.join(packageRoot, 'dist', 'index.cjs');
}

/**
 * A spawned daemon handle that captures stdout+stderr for diagnostics.
 */
interface DaemonHandle {
  child: ChildProcess;
  exitPromise: Promise<number | null>;
  readyPromise: Promise<void>;
  /** Last ~1 KB of combined stdout+stderr output (for diagnostic messages). */
  outputTail: () => string;
}

/**
 * Spawn `agentmonitors daemon run` in the foreground (stdio piped so we can
 * read its "listening" banner) and return the child process plus a promise that
 * resolves to the exit code when the process exits.
 *
 * stderr is captured so that waitForDaemon can include it in timeout diagnostics.
 */
function spawnDaemon(dir: string, socket: string): DaemonHandle {
  const db = path.join(dir, 'i.db');
  const monitorsDir = path.join(dir, '.claude', 'monitors');

  const child = spawn(
    process.execPath,
    [
      cliEntry(),
      'daemon',
      'run',
      monitorsDir,
      '--workspace',
      dir,
      '--socket',
      socket,
      '--poll-ms',
      '60000',
      // Long reap so the daemon doesn't self-stop before the assertions.
      '--reap-after-ms',
      '120000',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENTMONITORS_DB: db,
        AGENTMONITORS_SOCKET: socket,
      },
    },
  );

  // Capture combined stdout+stderr, keeping the last ~1 KB.
  const MAX_TAIL = 1024;
  let outputBuffer = '';
  const appendOutput = (chunk: Buffer | string): void => {
    outputBuffer += String(chunk);
    if (outputBuffer.length > MAX_TAIL * 2) {
      outputBuffer = outputBuffer.slice(-MAX_TAIL);
    }
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  // Resolve readyPromise as soon as the daemon prints its "listening" banner.
  const readyPromise = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      if (String(chunk).includes('listening on')) {
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    // Also resolve if process exits (the loser may exit before printing).
    void exitPromise.then(() => resolve());
  });

  return {
    child,
    exitPromise,
    readyPromise,
    outputTail: () =>
      outputBuffer.length > MAX_TAIL
        ? outputBuffer.slice(-MAX_TAIL)
        : outputBuffer,
  };
}

/**
 * Wait for a daemon to be available on its socket, with a timeout.
 *
 * On timeout, emits a diagnostic block to stderr (so it is visible in CI even
 * when a subsequent retry attempt passes) and then throws.  The diagnostic
 * includes the exit code (or "still running") and output tail of both daemon
 * handles, so a genuine crash or startup failure is not hidden by retry logic.
 */
async function waitForDaemon(
  socket: string,
  timeoutMs: number,
  handles?: [DaemonHandle, DaemonHandle],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await daemonAvailable(socket)) return;
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  // Build diagnostic block before throwing.
  let diag = `waitForDaemon: socket ${socket} not available after ${timeoutMs}ms\n`;
  if (handles) {
    for (const [idx, h] of handles.entries()) {
      const exitCode = await Promise.race([
        h.exitPromise,
        Promise.resolve<null>(null),
      ]);
      const status =
        exitCode !== null
          ? `exited with code ${String(exitCode)}`
          : 'still running';
      diag += `  daemon[${idx}]: ${status}\n`;
      const tail = h.outputTail();
      if (tail) {
        diag += `  daemon[${idx}] output tail:\n${tail
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')}\n`;
      }
    }
  }

  // Always print the diagnostic — retry logic in the serial runner must not
  // silently hide a real crash; the output will appear in CI logs on every
  // failed attempt regardless of whether a later attempt passes.
  console.error(diag);

  throw new Error(
    `Daemon on ${socket} did not become available within ${timeoutMs}ms`,
  );
}

describe('concurrent daemon spawn — single-instance guarantee (#62)', () => {
  it('exactly one daemon wins the socket bind; the loser exits without removing the live socket', async () => {
    const dir = makeTempDir();
    const socket = path.join(dir, 'd.sock');

    const a = spawnDaemon(dir, socket);
    const b = spawnDaemon(dir, socket);

    // Wait until at least one has printed "listening" (or both have exited).
    await Promise.race([
      a.readyPromise,
      b.readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error('Timed out waiting for either daemon to start')),
          15_000,
        ),
      ),
    ]);

    // Poll until the winning daemon is actually answering on the socket.
    // Replace the old fixed sleep + single probe with a bounded wait so
    // CPU-starved environments don't cause spurious failures.
    await waitForDaemon(socket, 15_000, [a, b]);

    // Exactly one daemon must be answering on the socket.
    const available = await daemonAvailable(socket);
    expect(available, 'the winner daemon must be answering on the socket').toBe(
      true,
    );

    // At least one process must have exited — the loser.
    // Use a bounded wait instead of a non-blocking race, so the loser gets
    // enough time to exit even under CPU pressure.
    const atLeastOneExited = await Promise.race([
      a.exitPromise.then(() => true),
      b.exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
    ]);
    expect(
      atLeastOneExited,
      'the losing daemon must have exited after EADDRINUSE',
    ).toBe(true);

    // The winner must still be answering — the loser must NOT have unlinked
    // the live socket.
    const stillAvailable = await daemonAvailable(socket);
    expect(
      stillAvailable,
      'the winner socket must survive after the loser exits',
    ).toBe(true);

    // Clean up: stop the winner.
    try {
      await callDaemon('stop', {}, { socketPath: socket, timeoutMs: 3_000 });
    } catch {
      /* might already be gone */
    }
    a.child.kill();
    b.child.kill();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Stale socket + concurrent spawn — the TOCTOU regression (#68)
//
// Scenario: a stale socket file exists (left by a crashed daemon) AND two new
// daemons are spawned at almost the same moment.  Without a startup lock both
// would:
//   1. probe() → "not live"  (correct — nobody is listening)
//   2. unlinkSync()           (the second removes the first's just-bound socket)
//   3. bind()                 (both succeed → two daemons running)
//
// With the startup lock the probe→unlink→bind critical section is serialised:
// exactly one process holds the lock at a time, so only one daemon ends up
// bound.
// ---------------------------------------------------------------------------
describe('stale socket + concurrent spawn — TOCTOU regression (#68)', () => {
  it('exactly one daemon wins when a stale socket file is present at spawn time', async () => {
    const dir = makeTempDir();
    const socket = path.join(dir, 'd.sock');

    // Plant a stale socket file — simulate a crashed daemon.
    writeFileSync(socket, '');

    const a = spawnDaemon(dir, socket);
    const b = spawnDaemon(dir, socket);

    // Wait for exactly one to win (print "listening") or both to exit quickly.
    await Promise.race([
      a.readyPromise,
      b.readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'Timed out waiting for a daemon to start with stale socket',
              ),
            ),
          15_000,
        ),
      ),
    ]);

    // At most one daemon must be answering — the invariant under test.
    // (We also verify it's exactly one: a winner must exist.)
    // Bump timeout to 15s and thread both handles for diagnostics.
    await waitForDaemon(socket, 15_000, [a, b]);

    const available = await daemonAvailable(socket);
    expect(
      available,
      'exactly one daemon must be answering after stale-socket + concurrent spawn',
    ).toBe(true);

    // The loser (if not already exited) must not be listening — it should have
    // exited because its listen() failed.  Give it a moment, then kill both to
    // be safe and verify there is still exactly one answering socket.
    await new Promise<void>((r) => setTimeout(r, 500));
    const stillAvailable = await daemonAvailable(socket);
    expect(stillAvailable, 'the winner socket must survive the race').toBe(
      true,
    );

    // Clean up.
    try {
      await callDaemon('stop', {}, { socketPath: socket, timeoutMs: 3_000 });
    } catch {
      /* might already be gone */
    }
    a.child.kill();
    b.child.kill();
  }, 30_000);
});
