import net from 'node:net';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callDaemon,
  createDaemonServer,
  daemonAvailable,
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

    await expect(
      callDaemon('status', {}, { socketPath, timeoutMs: 200 }),
    ).rejects.toThrow('boom');

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
