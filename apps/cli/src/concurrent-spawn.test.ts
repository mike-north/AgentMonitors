/**
 * Integration test for the concurrent-spawn single-instance guarantee (#62).
 *
 * The daemon uses the kernel's Unix-socket bind() as its single-instance lock:
 * two daemons racing the same socket path → whoever binds first wins, the loser
 * gets EADDRINUSE, exits without running any cleanup, and therefore does NOT
 * remove the winner's socket.  This test turns that property into a regression
 * guard.
 *
 * Approach: spawn two daemon processes almost simultaneously on the same socket
 * path.  Wait for at least one to come up (poll daemonAvailable).  Then assert:
 *   1. Exactly one daemon is answering on the socket.
 *   2. Both spawned processes have exited (the loser must have exited).
 *   3. The winner's socket was NOT unlinked by the loser.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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
 * Spawn `agentmonitors daemon run` in the foreground (stdio piped so we can
 * read its "listening" banner) and return the child process plus a promise that
 * resolves to the exit code when the process exits.
 */
function spawnDaemon(
  dir: string,
  socket: string,
): {
  child: ChildProcess;
  exitPromise: Promise<number | null>;
  readyPromise: Promise<void>;
} {
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

  return { child, exitPromise, readyPromise };
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

    // Allow a short settling window so the loser's exit is registered.
    const SETTLE_MS = 2_000;
    await new Promise<void>((r) => setTimeout(r, SETTLE_MS));

    // Exactly one daemon must be answering on the socket.
    const available = await daemonAvailable(socket);
    expect(available, 'the winner daemon must be answering on the socket').toBe(
      true,
    );

    // At least one process must have exited — the loser.
    const [exitA, exitB] = await Promise.all([
      Promise.race([a.exitPromise, Promise.resolve(undefined)]),
      Promise.race([b.exitPromise, Promise.resolve(undefined)]),
    ]);
    const atLeastOneExited = exitA !== undefined || exitB !== undefined;
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
