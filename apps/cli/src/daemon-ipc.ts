import { createHash } from 'node:crypto';
import {
  mkdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type {
  AgentMonitorRuntime,
  AgentSessionRole,
  DeliveryLifecycle,
  Urgency,
} from '@agentmonitors/core';
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
  'monitor.explain',
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
const monitorExplainParamsSchema = z.object({
  monitorId: z.string(),
  monitorsDir: z.string(),
  workspacePath: z.string().optional(),
  historyLimit: z.number().int().positive().optional(),
  eventLimit: z.number().int().positive().optional(),
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

/**
 * Thrown by {@link callDaemon} when the daemon could not be *reached* — the
 * socket was absent/refused, the connection dropped, or the request timed out.
 *
 * This is deliberately distinct from a plain `Error` carrying a daemon-side
 * application error (one the daemon answered with via `response.error`). Callers
 * that have a "daemon unavailable" fallback (e.g. `monitor explain`) must only
 * fall back on this class — falling back on an application error would mask the
 * real failure and misreport it as "daemon not running" (issue #94 review,
 * comment 3408123745).
 */
export class DaemonConnectionError extends Error {
  override readonly name = 'DaemonConnectionError';
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
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

/**
 * Attempt a short-lived connect to socketPath. Returns true if something
 * answered (a real daemon is running), false if the socket is stale / absent.
 *
 * Used by listen() to distinguish a live EADDRINUSE from a stale one so we
 * only unlink when nothing is actually listening (no-clobber invariant).
 */
function probeSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.setTimeout(0);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    sock.setTimeout(timeoutMs, () => {
      done(false);
    });
    sock.on('connect', () => {
      done(true);
    });
    sock.on('error', () => {
      done(false);
    });
    sock.connect(socketPath);
  });
}

// ---------------------------------------------------------------------------
// Startup lock — serialises the probe→unlink→bind critical section
// ---------------------------------------------------------------------------

/**
 * Path of the startup lock directory for a given socket path.
 *
 * We use a directory (not a file) because mkdir is atomic on all POSIX
 * filesystems: exactly one process gets EEXIST, all others succeed.  A file
 * created with O_EXCL would work too, but the dir approach lets us recover
 * the holder PID without a separate read step.
 */
function lockPath(socketPath: string): string {
  return `${socketPath}.lock.d`;
}

/**
 * Attempt to acquire the startup lock for `socketPath`.
 *
 * The lock is a directory `<socketPath>.lock.d` that contains a `pid` file.
 * mkdir is atomic: the first caller succeeds, all others receive EEXIST.
 *
 * Stale-lock recovery: if the lock directory exists but the PID written inside
 * is dead (`process.kill(pid, 0)` throws ESRCH), the lock is stale — remove it
 * and try once more.  If the pid is alive, another daemon is starting right now
 * → return false so the caller can treat this as "already running".
 *
 * Returns true when the lock is held, false if a live peer holds it.
 */
function acquireStartupLock(socketPath: string): boolean {
  const lock = lockPath(socketPath);
  const pidFile = path.join(lock, 'pid');

  const tryMkdir = (): boolean => {
    try {
      mkdirSync(lock);
      // We own it — write our pid so a future caller can detect us as dead.
      writeFileSync(pidFile, String(process.pid), 'utf-8');
      return true;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'EEXIST') throw err;
      return false;
    }
  };

  if (tryMkdir()) return true;

  // Lock exists. Read the holder pid and decide whether it's stale.
  let holderPid: number | undefined;
  try {
    holderPid = parseInt(readFileSync(pidFile, 'utf-8'), 10);
  } catch {
    // The pid file was removed between our mkdir and now — concurrent startup;
    // treat as live to be safe.
    return false;
  }

  if (!Number.isFinite(holderPid) || holderPid <= 0) {
    // Unreadable/corrupt pid — treat as stale.
    holderPid = undefined;
  }

  const holderIsAlive = (() => {
    if (holderPid === undefined) return false;
    try {
      process.kill(holderPid, 0);
      return true;
    } catch (err) {
      // ESRCH → process is dead; EPERM → alive but no permission (treated live)
      if (isErrnoException(err) && err.code === 'ESRCH') return false;
      return true;
    }
  })();

  if (holderIsAlive) {
    // Another process is actively starting up (or running) — yield.
    return false;
  }

  // Stale lock — remove it and try to acquire once.
  try {
    unlinkSync(pidFile);
  } catch {
    /* already gone — that's fine */
  }
  try {
    rmdirSync(lock);
  } catch {
    /* lost the removal race — another peer cleaned it up; just try mkdir */
  }

  return tryMkdir();
}

/**
 * Release the startup lock acquired by {@link acquireStartupLock}.
 * Called immediately after `server.listen()` resolves (or rejects); from that
 * point on the bound socket itself is the liveness signal.
 */
function releaseStartupLock(socketPath: string): void {
  const lock = lockPath(socketPath);
  const pidFile = path.join(lock, 'pid');
  try {
    unlinkSync(pidFile);
  } catch {
    /* ignore */
  }
  try {
    rmdirSync(lock);
  } catch {
    /* ignore */
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
    case 'monitor.explain': {
      const params = monitorExplainParamsSchema.parse(request.params);
      return runtime.explainMonitor({
        monitorId: params.monitorId,
        monitorsDir: params.monitorsDir,
        ...(params.workspacePath
          ? { workspacePath: params.workspacePath }
          : {}),
        ...(params.historyLimit ? { historyLimit: params.historyLimit } : {}),
        ...(params.eventLimit ? { eventLimit: params.eventLimit } : {}),
      });
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
    async listen() {
      // Acquire the per-workspace startup lock before entering the
      // probe→unlink→bind critical section.  This prevents the TOCTOU race
      // where two daemons both see "stale socket", both unlink, and the second
      // removes the first's just-bound socket — leaving two daemons running on
      // the same workspace (issue #68).
      //
      // The lock is a directory (<socketPath>.lock.d); mkdir is atomic on POSIX.
      // We write our pid inside so a future caller can detect us as dead (stale-
      // lock recovery).  We release the lock immediately after bind() completes —
      // from that point the bound socket itself is the liveness signal.
      const locked = acquireStartupLock(socketPath);
      if (!locked) {
        // A live peer is in the middle of (or just completed) its own startup.
        // Behave as if we hit EADDRINUSE so the caller's "already running" guard
        // takes over.
        throw Object.assign(
          new Error('EADDRINUSE: startup lock held by peer'),
          {
            code: 'EADDRINUSE',
          },
        );
      }

      try {
        // Probe the socket: a live daemon answers → keep it (no-clobber).
        // A stale file (no listener) → safe to unlink so our bind succeeds.
        const live = await probeSocket(socketPath);
        if (!live) {
          try {
            unlinkSync(socketPath);
          } catch (unlinkErr) {
            const code = isErrnoException(unlinkErr)
              ? String(unlinkErr.code)
              : '';
            if (code !== 'ENOENT') throw unlinkErr;
          }
        }
        // Attempt the actual bind.  If `live` is true we leave the socket alone
        // and let bind fail with EADDRINUSE so the caller detects "already running".
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(socketPath, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } finally {
        // Release immediately — the bound socket is the liveness signal now.
        releaseStartupLock(socketPath);
      }
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
      // A timeout means the daemon could not be reached in time — a connection
      // failure, not a daemon-side application error.
      fail(
        new DaemonConnectionError(
          `Timed out waiting for AgentMon daemon at ${socketPath}`,
        ),
      );
    });

    socket.setEncoding('utf-8');
    socket.on('error', (error) => {
      // Socket-level errors (ECONNREFUSED, ENOENT, dropped connection, …) mean
      // the daemon was unreachable — classify them as connection failures so a
      // caller's "daemon unavailable" fallback can distinguish them from a real
      // daemon-side application error.
      fail(
        new DaemonConnectionError(
          error instanceof Error ? error.message : String(error),
          error,
        ),
      );
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
