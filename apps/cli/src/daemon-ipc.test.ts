import net from 'node:net';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { callDaemon } from './daemon-ipc.js';

const tempRoots: string[] = [];

function tempSocketPath(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmonitors-ipc-'));
  tempRoots.push(root);
  return path.join(root, `${name}.sock`);
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
