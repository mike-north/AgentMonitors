import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  isErrnoException,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  restrictExistingPathMode,
  restrictSocketMode,
  withRestrictedUmask,
} from '@agentmonitors/core';
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
  'hook.preview',
  'hook.diagnose',
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
  // Cap on how many delivered high-urgency events a `turn-interruptible` claim
  // surfaces AND claims, so a length-bounded transport claims only what it
  // renders and the remainder re-delivers next context event (issue #299).
  maxEvents: z.number().int().positive().optional(),
});
const hookPreviewParamsSchema = z.object({
  sessionId: z.string(),
});
const hookDiagnoseParamsSchema = z.object({
  sessionId: z.string(),
  lifecycle: deliveryLifecycleSchema,
});
const historyListParamsSchema = z.object({
  monitorId: z.string().optional(),
  workspacePath: z.string().optional(),
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

function socketBaseDir(): string {
  const dbPath = resolveDbPath();
  if (dbPath === ':memory:') {
    // Mirror `workspacePaths()`'s XDG-aware data root so a caller who relocates
    // their data via `XDG_DATA_HOME` gets a consistent default socket location
    // (and so tests can isolate this path). Falls back to `~/.local/share` when
    // unset, matching the pre-existing behavior for the common case.
    const dataRoot =
      process.env['XDG_DATA_HOME'] ?? path.join(homedir(), '.local', 'share');
    return path.join(dataRoot, 'agentmonitors');
  }
  return path.dirname(dbPath);
}

/**
 * Base directory for the long-socket-path fallback. `/tmp` is used (not
 * `os.tmpdir()`) deliberately: the fallback exists precisely because a socket
 * path exceeded the ~100-char AF_UNIX limit, and on macOS `os.tmpdir()` is a
 * deep per-user path (`/var/folders/.../T`, ~48 chars) that would push the
 * substituted socket back over the limit. `/tmp` is short and present on every
 * POSIX host; privacy comes from the owner-only per-uid subdirectory below, not
 * from the shared base.
 */
const SOCKET_FALLBACK_BASE = '/tmp';

/**
 * Owner-private directory that holds the long-socket-path fallback socket
 * (issue #292). The pre-#292 fallback placed a predictable socket directly under
 * a world-writable `/tmp`, where any local user could connect to the
 * unauthenticated daemon. Instead we key an owner-only (`0700`) directory by the
 * current uid, so the socket lives inside a directory other users cannot
 * traverse. The directory itself is created/verified (and ownership-checked) at
 * bind time by {@link ensureSocketDir}; this helper only computes its path.
 */
function socketFallbackDir(): string {
  const uid = process.getuid?.() ?? 0;
  return path.join(SOCKET_FALLBACK_BASE, `agentmonitors-${String(uid)}`);
}

/**
 * Self-contained `node -e` connect probe used by {@link legacyDaemonIsLive}.
 * Connects to the socket given as `argv[1]`; exits `0` if a listener answered,
 * `1` on refusal/timeout. Kept dependency-free so it runs identically whether
 * the CLI is the bundled `dist/index.cjs` or the vitest-loaded source.
 */
const SYNC_SOCKET_PROBE_SCRIPT = [
  'const net=require("node:net");',
  'const sock=net.connect(process.argv[1]);',
  'const done=(code)=>{try{sock.destroy()}catch{}process.exit(code)};',
  'sock.once("connect",()=>done(0));',
  'sock.once("error",()=>done(1));',
  'sock.setTimeout(Number(process.argv[2])||400,()=>done(1));',
].join('');

/**
 * Synchronously decide whether a live daemon is still listening at the *legacy*
 * long-socket-path fallback (`/tmp/agentmonitors-<hash>.sock`, the pre-#292
 * location). {@link resolveSocketPath} is synchronous and called from many call
 * sites, so this probe must be synchronous too; Node has no synchronous socket
 * `connect`, so we run the same connect/answer test {@link probeSocket} performs
 * asynchronously via a short-lived `node -e` subprocess (`spawnSync`).
 *
 * Guarded by an existence check so the steady state — no legacy socket file —
 * never spawns anything. A subprocess is only launched during the migration
 * window, when a pre-upgrade daemon (or a stale socket file it left) is still
 * present.
 */
function legacyDaemonIsLive(legacyPath: string): boolean {
  if (!existsSync(legacyPath)) return false;
  const result = spawnSync(
    process.execPath,
    ['-e', SYNC_SOCKET_PROBE_SCRIPT, legacyPath, '400'],
    { timeout: 1_500, stdio: 'ignore' },
  );
  return result.status === 0;
}

export interface ResolveSocketPathOptions {
  /**
   * Set by a caller when `overridePath` came from a `--socket` flag the user
   * typed explicitly on the command line — as opposed to `AGENTMONITORS_SOCKET`,
   * a `.claude/agentmonitors.local.md`-derived value, or the computed default.
   *
   * When `true` and the resolved candidate exceeds
   * {@link MAX_UNIX_SOCKET_PATH_LENGTH}, a warning naming the requested path,
   * the limit, and the substituted path is printed to stderr before the hash
   * fallback is returned (issue #337) — an explicit request silently landing
   * on a different socket is a correctness trap, not just a length quirk.
   * Non-explicit candidates (env var, local-state, default) keep hashing
   * silently, as before.
   */
  explicit?: boolean;
}

export function resolveSocketPath(
  overridePath?: string,
  options: ResolveSocketPathOptions = {},
): string {
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
  // Owner-private per-uid directory rather than a predictable, shared
  // `/tmp/agentmonitors-<hash>.sock` (issue #292). The containing directory is
  // created owner-only at bind time so other local users cannot reach the
  // socket even though the file itself lands in a shared temp root.
  const substituted = path.join(
    socketFallbackDir(),
    `agentmonitors-${hash}.sock`,
  );

  // Split-brain migration guard (issue #292 review): the fallback location moved
  // from `/tmp/agentmonitors-<hash>.sock` to the per-uid path above. A daemon
  // started by a *pre-upgrade* build is still listening at the legacy path; if
  // upgraded clients unconditionally resolved to the new path they would
  // lazy-boot a SECOND daemon on the same database (the startup lock is keyed by
  // socket path, so it cannot serialize across the two paths). So: if a live
  // daemon still answers at the legacy path, keep talking to it; otherwise use
  // the new per-uid path. A daemon only ever *binds* the new path — a live
  // legacy daemon makes `daemon run` observe "already running", so no second
  // bind happens — which is why one restart of the legacy daemon completes the
  // migration (spec 002 §10.3).
  const legacy = path.join(SOCKET_FALLBACK_BASE, `agentmonitors-${hash}.sock`);
  const resolved = legacyDaemonIsLive(legacy) ? legacy : substituted;

  if (options.explicit && overridePath !== undefined) {
    process.stderr.write(
      `Warning: --socket path "${overridePath}" is ${String(overridePath.length)} characters, which exceeds the ${String(MAX_UNIX_SOCKET_PATH_LENGTH)}-character AF_UNIX socket path limit. Falling back to ${resolved}.\n`,
    );
  }

  return resolved;
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
export function lockPath(socketPath: string): string {
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
export function acquireStartupLock(socketPath: string): boolean {
  const lock = lockPath(socketPath);
  const pidFile = path.join(lock, 'pid');

  const tryMkdir = (): boolean => {
    try {
      // Owner-only lock directory + pid file (issue #292): the lock lives beside
      // the socket, so leaking it would expose the daemon's liveness/pid to
      // other local users. mkdir is atomic and non-recursive here.
      mkdirSync(lock, { mode: PRIVATE_DIR_MODE });
      // We own it — write our pid so a future caller can detect us as dead.
      writeFileSync(pidFile, String(process.pid), {
        encoding: 'utf-8',
        mode: PRIVATE_FILE_MODE,
      });
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
export function releaseStartupLock(socketPath: string): void {
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
        runtime.claimDelivery(
          params.sessionId,
          params.lifecycle,
          params.maxEvents,
        ),
      );
    }
    case 'hook.preview': {
      const params = hookPreviewParamsSchema.parse(request.params);
      return Promise.resolve(
        runtime.previewSettledHighDelivery(params.sessionId),
      );
    }
    case 'hook.diagnose': {
      const params = hookDiagnoseParamsSchema.parse(request.params);
      return Promise.resolve(
        runtime.diagnoseHookDelivery(params.sessionId, params.lifecycle),
      );
    }
    case 'history.list': {
      const params = historyListParamsSchema.parse(request.params);
      return Promise.resolve(
        runtime.listObservationHistory({
          ...(params.monitorId ? { monitorId: params.monitorId } : {}),
          ...(params.workspacePath
            ? { workspacePath: params.workspacePath }
            : {}),
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

/**
 * Ensure the directory that will contain `socketPath` exists before the daemon
 * binds, owner-only for any directory we own (issue #292).
 *
 * The long-socket-path fallback directory lives under a world-writable temp
 * root, so it is created strictly: atomic `mkdir` with mode, and a refusal to
 * bind inside a symlink or another user's directory a hostile peer could have
 * planted to intercept the unauthenticated socket.
 *
 * The Agent-Monitors-owned **default** socket directory (`socketBaseDir()` — the
 * per-workspace data directory, or `~/.local/share/agentmonitors` for a
 * `:memory:` database) is created owner-only *and* tightened when it already
 * exists with a looser mode. On-disk databases already tighten this directory at
 * `createDb` → `ensurePrivateDir`, but a `:memory:` database has no such call
 * site — so without this, a pre-existing world-readable default socket directory
 * would never be tightened (issue #292 review), a hole in spec 002 §3.1's "each
 * startup re-applies" rule that also underwrites the socket TOCTOU mitigation
 * (the owner-only parent directory is the load-bearing guard). Tightening is
 * best-effort — {@link restrictExistingPathMode} warns and continues if the
 * directory is not ours to chmod.
 *
 * Any *other* socket directory — a user-chosen or shared location supplied via
 * an explicit `--socket /tmp/x.sock` or `AGENTMONITORS_SOCKET` — is only
 * `mkdir`'d owner-only when missing; we deliberately never chmod a pre-existing
 * one, because silently tightening (or, as root, `chmod`-ing) someone else's or
 * a system directory would be wrong.
 */
function ensureSocketDir(socketPath: string): void {
  const dir = path.dirname(socketPath);
  if (dir === socketFallbackDir()) {
    ensureOwnerPrivateTmpDir(dir);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // Tighten only the Agent-Monitors-owned default socket directory when it
  // already exists; a user-chosen/shared directory keeps its mode.
  if (dir === socketBaseDir()) {
    restrictExistingPathMode(dir, PRIVATE_DIR_MODE);
  }
}

/**
 * Create-or-verify an owner-only directory in a potentially shared temp root.
 * `mkdir` with an explicit mode is atomic; if the directory already exists we
 * refuse it unless it is a real (non-symlink) directory we own, then tighten it
 * to `0700`. Throws (fails closed) rather than binding the socket inside a
 * directory another user controls.
 */
function ensureOwnerPrivateTmpDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
    return;
  } catch (err) {
    if (!isErrnoException(err) || err.code !== 'EEXIST') throw err;
  }

  let stat: Stats;
  try {
    stat = lstatSync(dir);
  } catch (err) {
    // TOCTOU: the directory vanished between our EEXIST and this lstat. Re-create
    // it owner-only; if that races again we fail closed (throw) rather than bind
    // inside a directory we could not verify.
    if (isErrnoException(err) && err.code === 'ENOENT') {
      mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
      return;
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Refusing to use socket directory ${dir}: it is not a real directory owned by this user.`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `Refusing to use socket directory ${dir}: owned by uid ${String(stat.uid)}, not ${String(uid)}.`,
    );
  }
  // Owned by us but possibly created with a looser mode — tighten it.
  restrictExistingPathMode(dir, PRIVATE_DIR_MODE);
}

export function createDaemonServer({
  runtime,
  socketPath,
  onStop,
}: DaemonServerOptions): {
  listen(): Promise<void>;
  close(): Promise<void>;
} {
  ensureSocketDir(socketPath);

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

      const stop = () => {
        onStop?.();
        if (!serverClosed) {
          serverClosed = true;
          setImmediate(() => {
            server.close();
            cleanupSocket(socketPath);
          });
        }
      };

      // `handleRequest` validates params synchronously (Zod `.parse()` can
      // throw before any Promise is returned). Wrapping the call in
      // `Promise.resolve().then(...)` converts such a synchronous throw into a
      // rejection the `.catch` below turns into an error *response* — otherwise
      // it would propagate out of this socket 'data' handler and kill the whole
      // daemon process (issue #292 review). One bad request must never take the
      // daemon down.
      void Promise.resolve()
        .then(() => handleRequest(runtime, request, stop))
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
          // Bind under a restrictive (`0o077`) umask so the socket file is born
          // `0600` instead of at the umask-default mode — closing the
          // bind→chmod window in which the socket briefly sat world-connectable
          // (issue #292 review). Node binds a Unix domain socket synchronously
          // inside `listen()`, so the umask is still restricted when the socket
          // file is created and is restored before the async 'listening'
          // callback runs. The owner-only parent directory (§3.1) remains the
          // load-bearing guard; `chmodSync` follows symlinks, so the umask +
          // private directory — not the post-bind chmod — is what actually
          // closes the race.
          withRestrictedUmask(() => {
            server.listen(socketPath, () => {
              server.off('error', reject);
              resolve();
            });
          });
        });
        // Re-assert owner-only on the just-bound socket (defense-in-depth on top
        // of the restricted-umask bind above), so other local users cannot
        // connect to the unauthenticated daemon even where the platform enforces
        // socket permission bits (issue #292).
        restrictSocketMode(socketPath);
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
