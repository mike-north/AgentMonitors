/** Synthetic socket fixtures prove read-only diagnostics, never host delivery support (006 §11.6). */
import { createServer, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeCodexOwner } from './codex-owner.mjs';

type IRequest = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};
type IResponder = (request: IRequest, socket: Socket) => void;
const cleanups: (() => Promise<void>)[] = [];
/** A real local socket captures every method, including otherwise hidden writes. */
async function fixture(respond?: IResponder) {
  const dir = await mkdtemp(join(tmpdir(), 'am-owner-'));
  const socketPath = join(dir, 'rpc.sock');
  const requests: IRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      pending += chunk;
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n');
        const request: IRequest = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        requests.push(request);
        if (respond) respond(request, socket);
        else reply(request, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { socketPath, requests };
}
/** Only read responses are modeled; no fake write success can conceal a mutation. */
function reply(request: IRequest, socket: Socket, result?: unknown) {
  if (request.id === undefined) return;
  const defaults: Record<string, unknown> = {
    initialize: {
      userAgent: 'agentmonitors_owner_probe/0.165.0-alpha.1 (Mac OS; arm64)',
    },
    'thread/loaded/list': { data: ['existing-thread'], nextCursor: null },
    'thread/read': { thread: { id: 'existing-thread', cwd: '/workspace' } },
  };
  socket.write(
    `${JSON.stringify({ id: request.id, result: result ?? defaults[request.method] })}\n`,
  );
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe('explicit Codex owner diagnostic', () => {
  it('pins version, identity and workspace using only initialization and reads', async () => {
    const server = await fixture();
    await expect(
      probeCodexOwner({
        socketPath: server.socketPath,
        threadId: 'existing-thread',
      }),
    ).resolves.toMatchObject({
      status: 'owner-observed',
      hostVersion: '0.165.0-alpha.1',
      threadId: 'existing-thread',
      workspacePath: '/workspace',
      deliveryCapability: 'unverified',
    });
    expect(server.requests.map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/loaded/list',
      'thread/read',
      'thread/loaded/list',
    ]);
    expect(
      server.requests.find((request) => request.method === 'thread/read')
        ?.params,
    ).toEqual({ threadId: 'existing-thread', includeTurns: false });
  });
  it('follows pagination before declaring ownership absent', async () => {
    const server = await fixture((request, socket) => {
      if (request.method === 'thread/loaded/list' && !request.params?.cursor)
        reply(request, socket, { data: ['other'], nextCursor: 'page-2' });
      else reply(request, socket);
    });
    await expect(
      probeCodexOwner({
        socketPath: server.socketPath,
        threadId: 'existing-thread',
      }),
    ).resolves.toMatchObject({ status: 'owner-observed' });
  });
  it.each([
    ['unloaded', 'thread/loaded/list', { data: [] }],
    ['invalid list', 'thread/loaded/list', { data: [42] }],
    ['invalid cursor', 'thread/loaded/list', { data: [], nextCursor: 42 }],
    [
      'wrong identity',
      'thread/read',
      { thread: { id: 'other', cwd: '/workspace' } },
    ],
    ['missing workspace', 'thread/read', { thread: { id: 'existing-thread' } }],
    [
      'relative workspace',
      'thread/read',
      { thread: { id: 'existing-thread', cwd: 'relative' } },
    ],
    ['missing version', 'initialize', {}],
    ['malformed version', 'initialize', { userAgent: 'unknown' }],
  ])('refuses %s without mutation', async (_label, method, result) => {
    const server = await fixture((request, socket) =>
      reply(request, socket, request.method === method ? result : undefined),
    );
    await expect(
      probeCodexOwner({
        socketPath: server.socketPath,
        threadId: 'existing-thread',
      }),
    ).rejects.toThrow();
    expect(
      server.requests.every((request) =>
        [
          'initialize',
          'initialized',
          'thread/loaded/list',
          'thread/read',
        ].includes(request.method),
      ),
    ).toBe(true);
  });
  it('refuses a thread unloaded during its metadata read', async () => {
    let lists = 0;
    const server = await fixture((request, socket) => {
      if (request.method === 'thread/loaded/list' && ++lists === 2)
        reply(request, socket, { data: [] });
      else reply(request, socket);
    });
    await expect(
      probeCodexOwner({
        socketPath: server.socketPath,
        threadId: 'existing-thread',
      }),
    ).rejects.toThrow(/loaded/);
  });
  it.each([
    'malformed',
    'timeout',
    'close',
    'server-request',
    'rpc-error',
    'oversized',
  ])('fails closed for %s', async (mode) => {
    const server = await fixture((request, socket) => {
      if (mode === 'malformed') socket.write('not json\n');
      if (mode === 'close') socket.end();
      if (mode === 'server-request')
        socket.write(
          '{"id":80,"method":"item/commandExecution/requestApproval"}\n',
        );
      if (mode === 'rpc-error')
        socket.write(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: 'private content' },
          }) + '\n',
        );
      if (mode === 'oversized') socket.write('x'.repeat(1024 * 1024 + 1));
    });
    await expect(
      probeCodexOwner({
        socketPath: server.socketPath,
        threadId: 'existing-thread',
        timeoutMs: 100,
      }),
    ).rejects.toThrow();
    expect(server.requests.map((request) => request.method)).toEqual([
      'initialize',
    ]);
  });
  it('bounds repeated cursors', async () => {
    const server = await fixture((request, socket) =>
      reply(
        request,
        socket,
        request.method === 'thread/loaded/list'
          ? { data: [], nextCursor: 'loop' }
          : undefined,
      ),
    );
    await expect(
      probeCodexOwner({
        socketPath: server.socketPath,
        threadId: 'existing-thread',
      }),
    ).rejects.toThrow(/cursor/);
  });
  it('requires explicit absolute socket and nonempty thread before connecting', async () => {
    for (const options of [
      {},
      { socketPath: '/tmp/x' },
      { socketPath: 'relative', threadId: 'x' },
      { socketPath: '/tmp/x', threadId: ' ' },
      { socketPath: '/tmp/x', threadId: 'x', timeoutMs: 0 },
    ]) {
      await expect(probeCodexOwner(options)).rejects.toThrow(/Invalid/);
    }
  });
  it('refuses absent sockets without creating a server', async () => {
    await expect(
      probeCodexOwner({
        socketPath: '/tmp/agentmonitors-nonexistent-owner.sock',
        threadId: 'x',
      }),
    ).rejects.toThrow();
  });
});

/** Exercise argument handling and stdout through the same entry point an operator invokes. */
describe('owner probe command', () => {
  const run = promisify(execFile);
  const script = fileURLToPath(new URL('./codex-owner.mjs', import.meta.url));
  it('prints only selected metadata and never conversation text', async () => {
    const server = await fixture((request, socket) =>
      reply(
        request,
        socket,
        request.method === 'thread/read'
          ? {
              thread: {
                id: 'existing-thread',
                cwd: '/workspace',
                preview: 'PRIVATE_BODY',
              },
            }
          : undefined,
      ),
    );
    const result = await run(process.execPath, [
      script,
      '--socket',
      server.socketPath,
      '--thread',
      'existing-thread',
    ]);
    expect(JSON.parse(result.stdout).status).toBe('owner-observed');
    expect(result.stdout).not.toContain('PRIVATE_BODY');
    expect(result.stderr).toBe('');
  });
  it.each([[], ['--socket', 'relative', '--thread', 'x'], ['--unknown', 'x']])(
    'refuses invalid CLI input %j',
    async (...args) => {
      await expect(
        run(process.execPath, [script, ...args]),
      ).rejects.toMatchObject({ code: 1, stdout: '' });
    },
  );
});
