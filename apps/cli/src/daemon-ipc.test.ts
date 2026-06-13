import net from 'node:net';
import path from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callDaemon,
  createDaemonServer,
  daemonAvailable,
  DaemonConnectionError,
} from './daemon-ipc.js';
import { createRuntime } from './runtime.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmonitors-ipc-'));
  tempRoots.push(root);
  return root;
}

function tempSocketPath(name: string): string {
  return path.join(tempDir(), `${name}.sock`);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('callDaemon', () => {
  it('rejects cleanly on daemon error responses', async () => {
    const socketPath = tempSocketPath('error-response');
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf-8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        socket.end(`${JSON.stringify({ id: '1', error: 'boom' })}\n`);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });

    // A daemon-side application error (the daemon answered with `error`) must
    // surface as a plain Error — NOT a DaemonConnectionError. Callers with a
    // "daemon unavailable" fallback rely on this distinction so they do not mask
    // a real application failure as "daemon not running" (issue #94 review,
    // comment 3408123745).
    const rejection = await callDaemon(
      'status',
      {},
      {
        socketPath,
        timeoutMs: 200,
      },
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(DaemonConnectionError);
    expect((rejection as Error).message).toBe('boom');

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it('rejects with a DaemonConnectionError when the daemon is unreachable (no socket)', async () => {
    // No server is listening on this path → a socket-level connection failure.
    // This is the only error class for which a caller's "daemon unavailable"
    // fallback may fire (issue #94 review, comment 3408123745).
    const socketPath = tempSocketPath('no-daemon');
    const rejection = await callDaemon(
      'status',
      {},
      {
        socketPath,
        timeoutMs: 200,
      },
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DaemonConnectionError);
  });

  it('rejects cleanly on invalid daemon payloads without double-settlement noise', async () => {
    const socketPath = tempSocketPath('invalid-response');
    const server = net.createServer((socket) => {
      socket.on('error', () => {
        // The server intentionally injects a late failure after sending invalid data.
        // Swallow it so the test can focus on the client's single-settlement behavior.
      });
      let buffer = '';
      socket.setEncoding('utf-8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        socket.end('not-json\n');
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });

    await expect(
      callDaemon('status', {}, { socketPath, timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(Error);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// createDaemonServer: startup lock (stale-lock recovery, live-lock rejection) (#68)
// ---------------------------------------------------------------------------

/**
 * The lock directory path mirrors the private lockPath() helper in daemon-ipc.ts.
 * Keeping this in sync here is intentional: the test exercises the observable
 * file-system contract, not an internal detail.
 */
function startupLockDir(socketPath: string): string {
  return `${socketPath}.lock.d`;
}

describe('createDaemonServer listen() — startup lock', () => {
  it('recovers from a stale lock left by a dead process', async () => {
    const socketPath = tempSocketPath('stale-lock');
    const lockDir = startupLockDir(socketPath);

    // Plant a stale lock: directory exists, pid inside refers to a dead process.
    mkdirSync(lockDir, { recursive: true });
    // PID 0 is never a valid live process.
    writeFileSync(path.join(lockDir, 'pid'), '0', 'utf-8');

    const server = createDaemonServer({
      runtime: createRuntime(':memory:'),
      socketPath,
    });

    try {
      // listen() must recover the stale lock and proceed.
      await expect(server.listen()).resolves.toBeUndefined();
      await expect(daemonAvailable(socketPath)).resolves.toBe(true);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it('treats an EADDRINUSE from a live-lock holder as "already running"', async () => {
    const socketPath = tempSocketPath('live-lock');
    const lockDir = startupLockDir(socketPath);

    // Plant a "live" lock that belongs to our own process.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'pid'), String(process.pid), 'utf-8');

    const challenger = createDaemonServer({
      runtime: createRuntime(':memory:'),
      socketPath,
    });

    // Must fail because the lock is held by a live pid.
    await expect(challenger.listen()).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });

    // Clean up the lock we planted.
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('releases the startup lock after a successful bind', async () => {
    const socketPath = tempSocketPath('lock-released');
    const lockDir = startupLockDir(socketPath);

    const server = createDaemonServer({
      runtime: createRuntime(':memory:'),
      socketPath,
    });

    try {
      await server.listen();
      // After listen() completes the lock directory must be gone.
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it('releases the startup lock even when bind fails', async () => {
    const socketPath = tempSocketPath('lock-released-on-fail');
    const lockDir = startupLockDir(socketPath);

    // Stand up a live daemon to force EADDRINUSE.
    const liveServer = createDaemonServer({
      runtime: createRuntime(':memory:'),
      socketPath,
    });
    await liveServer.listen();

    const challenger = createDaemonServer({
      runtime: createRuntime(':memory:'),
      socketPath,
    });

    try {
      await expect(challenger.listen()).rejects.toThrow();
      // Lock must be gone even though listen() failed.
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      await liveServer.close().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// createDaemonServer: stale socket recovery (#63)
// ---------------------------------------------------------------------------
describe('createDaemonServer listen() — stale socket recovery', () => {
  it('succeeds when a stale socket file is present but nothing is listening', async () => {
    const socketPath = tempSocketPath('stale-recovery');
    // Plant a stale socket file (no listener).
    writeFileSync(socketPath, '');

    const server = createDaemonServer({
      runtime: createRuntime(':memory:'),
      socketPath,
    });

    try {
      // listen() must succeed — it should detect the stale file and unlink it.
      await expect(server.listen()).resolves.toBeUndefined();
      // The daemon must now answer on the socket.
      await expect(daemonAvailable(socketPath)).resolves.toBe(true);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it('rejects with EADDRINUSE and does NOT remove the socket when a live daemon is present', async () => {
    const socketPath = tempSocketPath('live-no-clobber');
    const runtime = createRuntime(':memory:');

    // Stand up a live daemon on the socket.
    const liveServer = createDaemonServer({ runtime, socketPath });
    await liveServer.listen();

    try {
      // A second server on the same path must fail — the live socket must survive.
      const challenger = createDaemonServer({
        runtime: createRuntime(':memory:'),
        socketPath,
      });
      await expect(challenger.listen()).rejects.toThrow();

      // The live daemon must still be answering — no-clobber invariant holds.
      await expect(daemonAvailable(socketPath)).resolves.toBe(true);

      // The socket file must still exist.
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await liveServer.close().catch(() => undefined);
    }
  });
});
