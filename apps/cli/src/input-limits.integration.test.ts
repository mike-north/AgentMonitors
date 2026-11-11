/** Real daemon admission tests: malformed work cannot mutate or strand other sessions. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callDaemon,
  daemonAvailable,
  DaemonConnectionError,
} from './daemon-ipc.js';

/** Send raw chunks so framing, byte counts, and missing delimiters are exercised. */
function exchange(
  socketPath: string,
  chunks: readonly Buffer[],
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () =>
      socket.destroy(new Error('No bounded response')),
    );
    socket.on('connect', () => {
      for (const chunk of chunks) {
        socket.write(chunk);
      }
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

/** Serialize one ordinary request, keeping raw framing tests explicit at their callsites. */
function request(socketPath: string, method: string, params: unknown) {
  return exchange(socketPath, [
    Buffer.from(`${JSON.stringify({ id: 'limits-test', method, params })}\n`),
  ]);
}

describe('daemon input admission (002 §10.4)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ipc-limits-'));
  const socketPath = path.join(root, 'daemon.sock');
  let child: ReturnType<typeof spawn>;
  let exited: Promise<unknown>;
  let firstSession: { id: string };
  let sessionsBefore: unknown;

  beforeAll(async () => {
    const entry = fileURLToPath(new URL('../dist/index.cjs', import.meta.url));
    child = spawn(
      process.execPath,
      [
        entry,
        'daemon',
        'run',
        path.join(root, 'monitors'),
        '--workspace',
        root,
        '--socket',
        socketPath,
        '--poll-ms',
        '60000',
        '--reap-after-ms',
        '120000',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          AGENTMONITORS_DB: path.join(root, 'db.sqlite'),
          AGENTMONITORS_SOCKET: socketPath,
        },
      },
    );
    exited = once(child, 'exit');
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const deadline = Date.now() + 20000;
    while (!(await daemonAvailable(socketPath))) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`Daemon did not start: ${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    firstSession = await callDaemon<{ id: string }>(
      'session.open',
      {
        adapter: 'claude-code',
        hostSessionId: 'limits-a',
        agentIdentity: 'a',
        hookStatePath: path.join(root, 'a.json'),
        workspacePath: root,
      },
      { socketPath },
    );
    await callDaemon(
      'session.open',
      {
        adapter: 'claude-code',
        hostSessionId: 'limits-b',
        agentIdentity: 'b',
        hookStatePath: path.join(root, 'b.json'),
        workspacePath: root,
      },
      { socketPath },
    );
    sessionsBefore = await callDaemon('session.list', {}, { socketPath });
  }, 25000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects arrays and records before method validation or session mutation', async () => {
    for (const extra of [
      { eventIds: Array(1001).fill(42) },
      {
        scope: Object.fromEntries(
          Array.from({ length: 1001 }, (_, i) => [`k${i}`, 42]),
        ),
      },
      { ignored: { nested: Array(1001).fill(null) } },
    ]) {
      const response = await request(socketPath, 'session.close', {
        sessionId: firstSession.id,
        ...extra,
      });
      expect(response).toMatchObject({
        id: 'limits-test',
        code: 'INPUT_LIMIT_EXCEEDED',
      });
      expect(String(response['error']).length).toBeLessThan(300);
    }
    expect(await callDaemon('session.list', {}, { socketPath })).toEqual(
      sessionsBefore,
    );
    expect(await daemonAvailable(socketPath)).toBe(true);
  });

  it('surfaces admission as an application error rather than daemon unavailability', async () => {
    const error: unknown = await callDaemon(
      'events.list',
      { tags: Array(1001).fill('tag') },
      { socketPath },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DaemonConnectionError);
    expect(await daemonAvailable(socketPath)).toBe(true);
  });

  it('bounds nesting and aggregate validation work even when individual collections fit', async () => {
    let nested: unknown = null;
    for (let i = 0; i < 34; i++) {
      nested = { child: nested };
    }
    for (const ignored of [
      nested,
      Array.from({ length: 1000 }, () => Array(10).fill(null)),
    ]) {
      expect(await request(socketPath, 'ping', { ignored })).toMatchObject({
        code: 'INPUT_LIMIT_EXCEEDED',
      });
    }
  });

  it('accepts collection boundaries and ordinary requests after rejection', async () => {
    expect(
      await request(socketPath, 'events.list', {
        tags: Array(1000).fill('tag'),
        scope: Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [`k${i}`, 'v']),
        ),
      }),
    ).toMatchObject({ id: 'limits-test', result: [] });
    expect(await daemonAvailable(socketPath)).toBe(true);
  });

  it('rejects an oversized unterminated frame, including fragmented multibyte input', async () => {
    const bytes = Buffer.from('é'.repeat(524289));
    const response = await exchange(socketPath, [
      bytes.subarray(0, 65535),
      bytes.subarray(65535),
    ]);
    expect(response).toMatchObject({
      id: 'invalid',
      code: 'INPUT_LIMIT_EXCEEDED',
    });
    expect(response['error']).toBe('Request must be at most 1048576 bytes');
    expect(await callDaemon('session.list', {}, { socketPath })).toEqual(
      sessionsBefore,
    );
    expect(await daemonAvailable(socketPath)).toBe(true);
  });

  it('accepts exactly 1 MiB before the newline and dispatches only the first frame', async () => {
    const envelope = JSON.stringify({
      id: 'boundary',
      method: 'ping',
      params: { padding: '' },
    });
    const raw = envelope.replace(
      '"padding":""',
      `"padding":"${'x'.repeat(1048576 - Buffer.byteLength(envelope))}"`,
    );
    expect(Buffer.byteLength(raw)).toBe(1048576);
    expect(await exchange(socketPath, [Buffer.from(`${raw}\n`)])).toMatchObject(
      { id: 'boundary', result: { ok: true } },
    );
    expect(
      await exchange(socketPath, [
        Buffer.from(
          `${JSON.stringify({ id: 'one', method: 'ping', params: {} })}\n${JSON.stringify({ id: 'two', method: 'session.close', params: { sessionId: firstSession.id } })}\n`,
        ),
      ]),
    ).toMatchObject({ id: 'one' });
    expect(await callDaemon('session.list', {}, { socketPath })).toEqual(
      sessionsBefore,
    );
  });
});
