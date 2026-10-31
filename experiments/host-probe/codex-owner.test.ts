/** Synthetic socket fixtures prove read-only diagnostics, never host delivery support (006 §11.6). */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCodexOwner } from './codex-owner.mjs';

type IRequest = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};
type IResponder = (
  request: IRequest,
  socket: WebSocket,
  transport: Duplex,
) => void;
const cleanups: (() => Promise<void>)[] = [];
/** HTTP Upgrade and WebSocket frames model the documented Unix transport, capturing all methods. */
async function fixture(respond?: IResponder) {
  const dir = await mkdtemp(join(tmpdir(), 'am-owner-'));
  const socketPath = join(dir, 'rpc.sock');
  const requests: IRequest[] = [];
  const sockets = new Set<WebSocket>();
  const server = createServer();
  const upgrades: IncomingHttpHeaders[] = [];
  server.on('upgrade', (request) => upgrades.push(request.headers));
  const websocketServer = new WebSocketServer({ server });
  websocketServer.on('connection', (socket, upgradeRequest) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      const request: IRequest = JSON.parse(data.toString());
      requests.push(request);
      if (respond) respond(request, socket, upgradeRequest.socket);
      else reply(request, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) =>
      websocketServer.close(() => resolve()),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { socketPath, requests, upgrades };
}
/** Only read responses are modeled; no fake write success can conceal a mutation. */
function reply(request: IRequest, socket: WebSocket, result?: unknown) {
  if (request.id === undefined) return;
  const defaults: Record<string, unknown> = {
    initialize: {
      userAgent: 'agentmonitors_owner_probe/0.165.0-alpha.1 (Mac OS; arm64)',
    },
    'thread/loaded/list': { data: ['existing-thread'], nextCursor: null },
    'thread/read': { thread: { id: 'existing-thread', cwd: '/workspace' } },
  };
  socket.send(
    `${JSON.stringify({ id: request.id, result: result ?? defaults[request.method] })}\n`,
  );
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe('explicit Codex owner diagnostic', () => {
  it('uses HTTP Upgrade and WebSocket frames to pin identity with read-only methods', async () => {
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
    expect(server.upgrades).toHaveLength(1);
    expect(server.upgrades[0]['upgrade']).toBe('websocket');
    expect(server.upgrades[0]['sec-websocket-extensions']).toBeUndefined();
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
      if (mode === 'malformed') socket.send('not json\n');
      if (mode === 'close') socket.close();
      if (mode === 'server-request')
        socket.send(
          '{"id":80,"method":"item/commandExecution/requestApproval"}\n',
        );
      if (mode === 'rpc-error')
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: 'private content' },
          }) + '\n',
        );
      if (mode === 'oversized') socket.send('x'.repeat(1024 * 1024 + 1));
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
  it('rejects binary messages instead of interpreting them as protocol text', async () => {
    const server = await fixture((request, socket) => {
      socket.send(Buffer.from(JSON.stringify({ id: request.id, result: {} })));
    });
    await expect(
      probeCodexOwner({
        socketPath: server.socketPath,
        threadId: 'existing-thread',
      }),
    ).rejects.toThrow(/text/);
  });
  it('bounds aggregate notification bytes even when every frame is small', async () => {
    const server = await fixture((_request, socket) => {
      for (let index = 0; index < 20; index++) {
        socket.send(
          JSON.stringify({
            method: 'notice',
            params: { data: 'x'.repeat(65536) },
          }),
        );
      }
    });
    await expect(
      probeCodexOwner({
        socketPath: server.socketPath,
        threadId: 'existing-thread',
      }),
    ).rejects.toThrow(/budget/);
  });
  it('applies the whole-probe deadline while HTTP Upgrade is stalled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'am-owner-stall-'));
    const socketPath = join(directory, 'rpc.sock');
    const connections = new Set<Duplex>();
    const server = createServer();
    server.on('upgrade', (_request, socket) => {
      connections.add(socket);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        probeCodexOwner({
          socketPath,
          threadId: 'existing-thread',
          timeoutMs: 30,
        }),
      ).rejects.toThrow();
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('never follows a Unix server redirect to a TCP listener', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'am-owner-redirect-'));
    const socketPath = join(directory, 'rpc.sock');
    let tcpRequests = 0;
    const tcp = createServer((_request, response) => {
      tcpRequests++;
      response.end();
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const address = tcp.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener');
    const unix = createServer((_request, response) => {
      response.writeHead(302, { Location: `ws://127.0.0.1:${address.port}/` });
      response.end();
    });
    await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
    try {
      await expect(
        probeCodexOwner({
          socketPath,
          threadId: 'existing-thread',
          timeoutMs: 100,
        }),
      ).rejects.toThrow();
      expect(tcpRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => unix.close(() => resolve()));
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
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
  // The last response is not success if its parsing turn also observes a failure.
  // Consecutive sends let the WebSocket parser observe both frames before promise continuations.
  it.each(['malformed', 'server-request', 'duplicate'] as const)(
    'refuses a final valid response followed by %s in the same parsing turn',
    async (mode) => {
      let listings = 0;
      const server = await fixture((request, socket) => {
        if (request.method !== 'thread/loaded/list' || ++listings !== 2) {
          reply(request, socket);
          return;
        }
        const response = JSON.stringify({
          id: request.id,
          result: { data: ['existing-thread'], nextCursor: null },
        });
        const tail =
          mode === 'malformed'
            ? 'not JSON'
            : mode === 'server-request'
              ? JSON.stringify({
                  id: 99,
                  method: 'item/commandExecution/requestApproval',
                })
              : response;
        socket.send(response);
        socket.send(tail);
      });
      await expect(
        probeCodexOwner({
          socketPath: server.socketPath,
          threadId: 'existing-thread',
        }),
      ).rejects.toThrow();
      expect(server.requests.map((request) => request.method)).toEqual([
        'initialize',
        'initialized',
        'thread/loaded/list',
        'thread/read',
        'thread/loaded/list',
      ]);
    },
  );
  it.each([1000, 1011])(
    'refuses an already-observed close frame (%s) following the final response',
    async (closeCode) => {
      let listings = 0;
      const server = await fixture((request, socket, transport) => {
        if (request.method !== 'thread/loaded/list' || ++listings !== 2) {
          reply(request, socket);
          return;
        }
        const response = Buffer.from(
          JSON.stringify({
            id: request.id,
            result: { data: ['existing-thread'], nextCursor: null },
          }),
        );
        // One transport write ensures both frames are available to the parser before
        // ownership promises settle. Short, unmasked server frames are sufficient here.
        expect(response.length).toBeLessThan(126);
        const closePayload = Buffer.alloc(2);
        closePayload.writeUInt16BE(closeCode);
        transport.write(
          Buffer.concat([
            Buffer.from([0x81, response.length]),
            response,
            Buffer.from([0x88, closePayload.length]),
            closePayload,
          ]),
        );
      });
      await expect(
        probeCodexOwner({
          socketPath: server.socketPath,
          threadId: 'existing-thread',
        }),
      ).rejects.toThrow(/clos/i);
    },
  );
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
  it('refuses a connection failure observed after the final frame but before returning evidence', async () => {
    const server = await fixture();
    const emit = WebSocket.prototype.emit;
    // Inject a local socket error between promise continuations, after the last
    // message callback completes. No waiting for future peer activity is required.
    const intercepted = vi
      .spyOn(WebSocket.prototype, 'emit')
      .mockImplementation(function (
        this: WebSocket,
        event: string | symbol,
        ...args: unknown[]
      ): boolean {
        const result = emit.apply(this, [event, ...args]);
        if (
          event === 'message' &&
          Buffer.isBuffer(args[0]) &&
          args[0].toString().includes('"id":4,"result"')
        ) {
          queueMicrotask(() =>
            this.emit('error', new Error('Synthetic late read failure')),
          );
        }
        return result;
      });
    try {
      await expect(
        probeCodexOwner({
          socketPath: server.socketPath,
          threadId: 'existing-thread',
        }),
      ).rejects.toThrow();
    } finally {
      intercepted.mockRestore();
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
