import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type {
  AgentMonitorRuntime,
  AgentSessionRole,
  DeliveryLifecycle,
  Urgency,
} from '@mike-north/core';
import { z } from 'zod';
import { resolveDbPath } from './db-path.js';

type JsonRecord = Record<string, unknown>;
const MAX_UNIX_SOCKET_PATH_LENGTH = 100;
const sessionRoleValues = ['lead', 'subagent'] as const;
const urgencyValues = ['low', 'normal', 'high'] as const;
const deliveryLifecycleValues = [
  'turn-interruptible',
  'turn-idle',
  'post-compact',
] as const;
const daemonMethodSchema = z.enum([
  'ping',
  'status',
  'stop',
  'session.open',
  'session.close',
  'session.list',
  'events.list',
  'events.ack',
  'hook.claim',
  'history.list',
  'daemon.tick',
]);
const daemonResponseSchema = z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
const sessionRoleSchema = z.enum(
  sessionRoleValues satisfies readonly AgentSessionRole[],
);
const urgencySchema = z.enum(urgencyValues satisfies readonly Urgency[]);
const deliveryLifecycleSchema = z.enum(
  deliveryLifecycleValues satisfies readonly DeliveryLifecycle[],
);
const openSessionParamsSchema = z.object({
  adapter: z.string(),
  hostSessionId: z.string(),
  workspacePath: z.string().optional(),
  role: sessionRoleSchema.optional(),
  agentIdentity: z.string(),
  hookStatePath: z.string(),
});
const sessionCloseParamsSchema = z.object({
  sessionId: z.string(),
});
const eventsListParamsSchema = z.object({
  sessionId: z.string().optional(),
  monitorId: z.string().optional(),
  urgency: urgencySchema.optional(),
  tags: z.array(z.string()).optional(),
  scope: z.record(z.string(), z.string()).optional(),
  objectKey: z.string().optional(),
  unreadOnly: z.boolean().optional(),
  sinceBaseline: z.boolean().optional(),
  since: z.coerce.date().optional(),
});
const eventsAckParamsSchema = z.object({
  sessionId: z.string(),
  eventIds: z.array(z.string()).optional(),
});
const hookClaimParamsSchema = z.object({
  sessionId: z.string(),
  lifecycle: deliveryLifecycleSchema,
});
const historyListParamsSchema = z.object({
  monitorId: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
const daemonTickParamsSchema = z.object({
  monitorsDir: z.string(),
  workspacePath: z.string().optional(),
});
const daemonRequestSchema = z.object({
  id: z.string(),
  method: daemonMethodSchema,
  params: z.record(z.string(), z.unknown()),
});

type DaemonMethod = z.infer<typeof daemonMethodSchema>;

export interface DaemonRequest<T extends JsonRecord = JsonRecord> {
  id: string;
  method: DaemonMethod;
  params: T;
}

export interface DaemonResponse<T = unknown> {
  id: string;
  result?: T;
  error?: string;
}

export interface DaemonServerOptions {
  runtime: AgentMonitorRuntime;
  socketPath: string;
  onStop?: () => void;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function socketBaseDir(): string {
  const dbPath = resolveDbPath();
  if (dbPath === ':memory:') {
    return path.join(homedir(), '.local', 'share', 'agentmonitors');
  }
  return path.dirname(dbPath);
}

export function resolveSocketPath(overridePath?: string): string {
  const candidate =
    overridePath ??
    process.env['AGENTMONITORS_SOCKET'] ??
    path.join(socketBaseDir(), 'agentmonitors.sock');

  if (candidate.length <= MAX_UNIX_SOCKET_PATH_LENGTH) {
    return candidate;
  }

  const hash = createHash('sha256')
    .update(candidate)
    .digest('hex')
    .slice(0, 16);
  return path.join('/tmp', `agentmonitors-${hash}.sock`);
}

function cleanupSocket(socketPath: string): void {
  try {
    rmSync(socketPath);
  } catch (error) {
    const code = isErrnoException(error) ? String(error.code) : '';
    if (code !== 'ENOENT') throw error;
  }
}

function handleRequest(
  runtime: AgentMonitorRuntime,
  request: DaemonRequest,
  stop: () => void,
): Promise<unknown> {
  switch (request.method) {
    case 'ping':
      return Promise.resolve({ ok: true });
    case 'status':
      return Promise.resolve(runtime.status());
    case 'stop':
      stop();
      return Promise.resolve({ stopping: true });
    case 'session.open': {
      const params = openSessionParamsSchema.parse(request.params);
      return Promise.resolve(
        runtime.openSession({
          adapter: params.adapter,
          hostSessionId: params.hostSessionId,
          agentIdentity: params.agentIdentity,
          hookStatePath: params.hookStatePath,
          ...(params.workspacePath
            ? { workspacePath: params.workspacePath }
            : {}),
          ...(params.role ? { role: params.role } : {}),
        }),
      );
    }
    case 'session.close':
      return Promise.resolve(
        runtime.closeSession(
          sessionCloseParamsSchema.parse(request.params).sessionId,
        ),
      );
    case 'session.list':
      return Promise.resolve(runtime.listSessions());
    case 'events.list': {
      const params = eventsListParamsSchema.parse(request.params);
      return Promise.resolve(
        runtime.listEvents({
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.monitorId ? { monitorId: params.monitorId } : {}),
          ...(params.urgency ? { urgency: params.urgency } : {}),
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.objectKey ? { objectKey: params.objectKey } : {}),
          ...(params.unreadOnly ? { unreadOnly: params.unreadOnly } : {}),
          ...(params.sinceBaseline
            ? { sinceBaseline: params.sinceBaseline }
            : {}),
          ...(params.since ? { since: params.since } : {}),
        }),
      );
    }
    case 'events.ack':
      {
        const params = eventsAckParamsSchema.parse(request.params);
        runtime.acknowledgeSession(params.sessionId, params.eventIds);
      }
      return Promise.resolve({ ok: true });
    case 'hook.claim': {
      const params = hookClaimParamsSchema.parse(request.params);
      return Promise.resolve(
        runtime.claimDelivery(params.sessionId, params.lifecycle),
      );
    }
    case 'history.list': {
      const params = historyListParamsSchema.parse(request.params);
      return Promise.resolve(
        runtime.listObservationHistory({
          ...(params.monitorId ? { monitorId: params.monitorId } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        }),
      );
    }
    case 'daemon.tick': {
      const params = daemonTickParamsSchema.parse(request.params);
      return runtime.tick(params.monitorsDir, params.workspacePath);
    }
  }
}

export function createDaemonServer({
  runtime,
  socketPath,
  onStop,
}: DaemonServerOptions): {
  listen(): Promise<void>;
  close(): Promise<void>;
} {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  cleanupSocket(socketPath);

  let serverClosed = false;
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf-8');

    const respond = (payload: DaemonResponse) => {
      socket.end(`${JSON.stringify(payload)}\n`);
    };

    socket.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);

      let request: DaemonRequest;
      try {
        request = daemonRequestSchema.parse(JSON.parse(raw));
      } catch {
        respond({ id: 'invalid', error: 'Invalid JSON request.' });
        return;
      }

      void handleRequest(runtime, request, () => {
        onStop?.();
        if (!serverClosed) {
          serverClosed = true;
          setImmediate(() => {
            server.close();
            cleanupSocket(socketPath);
          });
        }
      })
        .then((result) => {
          respond({ id: request.id, result });
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          respond({ id: request.id, error: message });
        });
    });
  });

  server.on('close', () => {
    serverClosed = true;
    cleanupSocket(socketPath);
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (serverClosed) {
          cleanupSocket(socketPath);
          resolve();
          return;
        }
        server.close((error) => {
          cleanupSocket(socketPath);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function callDaemon<T = unknown>(
  method: DaemonMethod,
  params: JsonRecord = {},
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<T> {
  const socketPath = resolveSocketPath(options.socketPath);
  const timeoutMs = options.timeoutMs ?? 2_000;
  const request: DaemonRequest = {
    id: `${String(Date.now())}-${Math.random().toString(16).slice(2)}`,
    method,
    params,
  };

  return await new Promise<T>((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('connect');
      socket.setTimeout(0);
      fn();
    };

    const fail = (error: Error) => {
      settle(() => {
        socket.once('error', () => {
          // Swallow late socket errors after we've already settled the promise.
        });
        socket.destroy();
        reject(error);
      });
    };

    socket.setTimeout(timeoutMs, () => {
      fail(new Error(`Timed out waiting for AgentMon daemon at ${socketPath}`));
    });

    socket.setEncoding('utf-8');
    socket.on('error', (error) => {
      fail(error);
    });
    socket.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const raw = buffer.slice(0, newline);
      try {
        const response = daemonResponseSchema.parse(JSON.parse(raw));
        if (response.error) {
          fail(new Error(response.error));
          return;
        }
        settle(() => {
          socket.end();
          resolve(response.result as T);
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.connect(socketPath);
  });
}

export async function daemonAvailable(socketPath?: string): Promise<boolean> {
  try {
    await callDaemon(
      'ping',
      {},
      socketPath ? { socketPath, timeoutMs: 500 } : { timeoutMs: 500 },
    );
    return true;
  } catch {
    return false;
  }
}
