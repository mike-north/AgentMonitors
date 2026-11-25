/**
 * Manual commands must distinguish an unreachable daemon from a written
 * request whose result cannot be established (005 §17). The built executable
 * uses its real IPC deadline; the peer reads one request and withholds a reply.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { NO_WORKSPACE_DAEMON_MESSAGE } from './manual-daemon.js';

const cli = path.resolve(import.meta.dirname, '../dist/index.cjs');

/** Expected actions and inspection commands come from the CLI contract. */
const commands = [
  {
    args: ['session', 'open', '--host-session-id', 'host'],
    method: 'session.open',
    action: 'Session open',
    check: 'agentmonitors session list',
  },
  {
    args: ['session', 'close', 'session-1'],
    method: 'session.close',
    action: 'Session close',
    check: 'agentmonitors session list',
  },
  {
    args: ['events', 'ack', '--session', 'session-1'],
    method: 'events.ack',
    action: 'Events ack',
    check: 'agentmonitors events list --session session-1 --unread',
  },
  {
    args: [
      'hook',
      'claim',
      '--session',
      'session-1',
      '--lifecycle',
      'turn-idle',
    ],
    method: 'hook.claim',
    action: 'Hook claim',
    check: 'agentmonitors events list --session session-1',
  },
  {
    args: [
      'watch',
      'declare',
      'schedule',
      '--session',
      'session-1',
      '--scope',
      'cron=* * * * *',
    ],
    method: 'watch.declare',
    action: 'Watch declare',
    check: 'agentmonitors watch list',
  },
  {
    args: ['watch', 'cancel', 'watch-1', '--session', 'session-1'],
    method: 'watch.cancel',
    action: 'Watch cancel',
    check: 'agentmonitors watch list',
  },
  { args: ['session', 'list'], method: 'session.list' },
  { args: ['events', 'list', '--session', 'session-1'], method: 'events.list' },
  { args: ['watch', 'list', '--session', 'session-1'], method: 'watch.list' },
];

/** Capture both channels without blocking the peer's request reader. */
async function run(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data: string) => {
    stdout += data;
  });
  child.stderr.setEncoding('utf8').on('data', (data: string) => {
    stderr += data;
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

describe.each(['text', 'json'])(
  'manual daemon diagnostics with %s output',
  (format) => {
    it.each(commands)(
      '$method reports an unknown outcome after a written request',
      async ({ args, method, ...mutation }) => {
        const socketPath = path.join(tmpdir(), 'manual.sock');
        const methods: string[] = [];
        const sockets = new Set<net.Socket>();
        const server = net.createServer((socket) => {
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          socket.on('error', () => undefined);
          socket.setEncoding('utf8');
          let buffer = '';
          socket.on('data', (chunk: string) => {
            buffer += chunk;
            if (!buffer.includes('\n')) return;
            const request: unknown = JSON.parse(
              buffer.slice(0, buffer.indexOf('\n')),
            );
            if (
              typeof request === 'object' &&
              request !== null &&
              'method' in request &&
              typeof request.method === 'string'
            ) {
              methods.push(request.method);
            }
            // Keep the connection open without replying, exercising the real timeout.
          });
        });
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, resolve);
          });
          const result = await run([
            ...args,
            '--socket',
            socketPath,
            ...(method === 'events.ack' ? [] : ['--format', format]),
          ]);
          expect(methods).toEqual([method]);
          const cause = `Timed out waiting for AgentMon daemon at ${socketPath}`;
          const message =
            'action' in mutation
              ? `${mutation.action} outcome unknown: the daemon received the request but no reply arrived (${cause}). It may already have been applied, or may still be applied. Check with \`${mutation.check}\` before running it again.`
              : `Request to the AgentMon daemon at ${socketPath} got no reply (${cause}); the daemon is running but did not answer.`;
          expect(result.stderr).toBe(`Error: ${message}\n`);
          expect(result.stderr).not.toContain(NO_WORKSPACE_DAEMON_MESSAGE);
          expect(result.stderr).not.toContain('No daemon running');
          expect(result.stdout).toBe('');
          expect(result.code).toBe(3);
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );

    it.each(commands)(
      '$method preserves the unreachable-daemon diagnostic',
      async ({ args, method }) => {
        const result = await run([
          ...args,
          '--socket',
          path.join(tmpdir(), 'absent.sock'),
          ...(method === 'events.ack' ? [] : ['--format', format]),
        ]);
        expect(result.stderr).toBe(`Error: ${NO_WORKSPACE_DAEMON_MESSAGE}\n`);
        expect(result.stdout).toBe('');
        expect(result.code).toBe(1);
      },
    );
  },
);
