import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireStartupLock,
  callDaemon,
  createDaemonServer,
  daemonAvailable,
  DaemonConnectionError,
  DaemonUnsupportedRequestError,
  lockPath,
  releaseStartupLock,
  resolveSocketPath,
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

  // Issue #382: an old, still-running daemon build predates a method the
  // client's schema knows about (e.g. `doctor.report`) — its own
  // `daemonRequestSchema.parse()` rejects the request and it can only ever
  // reply with the legacy `{ id: 'invalid', error: 'Invalid JSON request.' }`
  // sentinel (no `code` field, since that build predates it). A client must
  // recognize this exact legacy pair and raise a distinct, dedicated error so
  // a caller with a "fall back and keep going" guard (like `doctor`) can tell
  // "reached an incompatible daemon" apart from both a genuine connection
  // failure and a genuine daemon-side application error.
  //
  // Pre-fix, this failed: `callDaemon` had no sentinel detection at all, so
  // the daemon's `error` string surfaced as a plain `Error` — indistinguishable
  // from a real application error, which is exactly what broke `doctor`
  // (issue #382's root cause).
  it('rejects with a DaemonUnsupportedRequestError when an old daemon answers with the legacy unparseable-request sentinel', async () => {
    const socketPath = tempSocketPath('legacy-sentinel');
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf-8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        // Exactly what a pre-#382 daemon build sends for ANY request its
        // schema rejects — no `code` field, since that build predates it.
        socket.end(
          `${JSON.stringify({ id: 'invalid', error: 'Invalid JSON request.' })}\n`,
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });

    const rejection = await callDaemon(
      'doctor.report',
      { monitorsDir: '/tmp/monitors', workspacePath: '/tmp/workspace' },
      { socketPath, timeoutMs: 200 },
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(DaemonUnsupportedRequestError);
    // Never a plain Error nor a connection failure — a caller must be able to
    // branch on the class alone (issue #94 review precedent).
    expect(rejection).not.toBeInstanceOf(DaemonConnectionError);

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

  // A genuine daemon-side application error that happens to reply with a
  // DIFFERENT request id than 'invalid' must never be misclassified as the
  // unsupported-request sentinel — the match is precise (id AND message),
  // not a loose substring/prefix check.
  it('does NOT classify a real application error as unsupported-request merely because its message contains similar words', async () => {
    const socketPath = tempSocketPath('real-app-error');
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf-8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as {
          id: string;
        };
        // Real request id (not the 'invalid' sentinel id), genuine app error.
        socket.end(
          `${JSON.stringify({ id: request.id, error: 'Invalid workspace path.' })}\n`,
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });

    const rejection = await callDaemon(
      'doctor.report',
      { monitorsDir: '/tmp/monitors', workspacePath: '/tmp/workspace' },
      { socketPath, timeoutMs: 200 },
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(DaemonUnsupportedRequestError);
    expect(rejection).not.toBeInstanceOf(DaemonConnectionError);
    expect((rejection as Error).message).toBe('Invalid workspace path.');

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
// createDaemonServer: one bad request must not crash the daemon (issue #292)
// ---------------------------------------------------------------------------
describe('createDaemonServer — request-handling resilience', () => {
  it('answers an error response and stays alive when a request fails synchronous param validation', async () => {
    const socketPath = tempSocketPath('bad-params');
    const server = createDaemonServer({
      runtime: createRuntime(':memory:'),
      socketPath,
    });
    try {
      await server.listen();

      // `session.open` with empty params passes the request envelope schema but
      // fails the per-method Zod parse *synchronously* inside handleRequest.
      // Pre-fix that throw propagated out of the socket 'data' handler as an
      // uncaught exception and killed the daemon; it must now come back as a
      // clean error response instead.
      const rejection = await callDaemon(
        'session.open',
        {},
        { socketPath, timeoutMs: 1000 },
      ).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toBeInstanceOf(DaemonConnectionError);

      // Decisive assertion: the daemon survived and still answers.
      await expect(daemonAvailable(socketPath)).resolves.toBe(true);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  // Issue #382: going forward, a schema-rejected request (e.g. an unknown
  // `method` — what a NEW client sends an OLD daemon build that predates it,
  // or vice versa) must carry a `code` a client can match on WITHOUT relying
  // on the human-readable `error` text staying byte-for-byte stable — while
  // the legacy `id`/`error` pair stays unchanged so an old client (whose
  // schema simply ignores the added `code` field) sees no behavior change.
  it('answers a schema-rejected request with the legacy id/message pair PLUS a machine-distinguishable code', async () => {
    const socketPath = tempSocketPath('unsupported-request-code');
    const server = createDaemonServer({
      runtime: createRuntime(':memory:'),
      socketPath,
    });
    try {
      await server.listen();

      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(socketPath);
        let buffer = '';
        socket.setEncoding('utf-8');
        socket.on('connect', () => {
          // A method the daemon's own schema doesn't recognize — same shape
          // an old daemon receives from a newer client (or vice versa).
          socket.write(
            `${JSON.stringify({ id: '1', method: 'not-a-real-method', params: {} })}\n`,
          );
        });
        socket.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.includes('\n')) {
            socket.end();
            resolve(buffer);
          }
        });
        socket.on('error', reject);
      });

      const response = JSON.parse(raw.trimEnd()) as {
        id: string;
        error?: string;
        code?: string;
      };
      expect(response.id).toBe('invalid');
      expect(response.error).toBe('Invalid JSON request.');
      expect(response.code).toBe('unsupported_request');
    } finally {
      await server.close().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveSocketPath: explicit --socket substitution warning (issue #337)
// ---------------------------------------------------------------------------

/**
 * A candidate string guaranteed to exceed MAX_UNIX_SOCKET_PATH_LENGTH (100),
 * mirroring the DX study repro (a deeply-nested sandbox path over the AF_UNIX
 * `sun_path` limit).
 */
const OVER_LIMIT_SOCKET_PATH = `/tmp/${'a'.repeat(120)}/agentmon.sock`;

/**
 * The owner-private per-uid directory the long-socket-path fallback now lives in
 * (issue #292). Mirrors `socketFallbackDir()` in daemon-ipc.ts — kept in sync
 * here on purpose so the test exercises the observable path contract. The base
 * is `/tmp` (not `os.tmpdir()`) so the substituted socket stays under the
 * ~100-char AF_UNIX limit even on macOS.
 */
function expectedFallbackDir(): string {
  const uid = process.getuid?.() ?? 0;
  return path.join('/tmp', `agentmonitors-${String(uid)}`);
}

describe('resolveSocketPath — explicit substitution warning (issue #337)', () => {
  const originalSocketEnv = process.env['AGENTMONITORS_SOCKET'];

  afterEach(() => {
    if (originalSocketEnv === undefined) {
      delete process.env['AGENTMONITORS_SOCKET'];
    } else {
      process.env['AGENTMONITORS_SOCKET'] = originalSocketEnv;
    }
    vi.restoreAllMocks();
  });

  // Acceptance criterion 1: any command substituting a hashed path for an
  // EXPLICITLY passed --socket must say so on stderr — requested path, the
  // limit exceeded, and the substituted path.
  //
  // Regression: pre-fix, resolveSocketPath had no `explicit` concept at all and
  // never wrote to stderr — this assertion set fails against that code, since
  // `writeSpy` would never be called.
  it('warns on stderr with the requested path, the limit, and the substituted path when an explicit --socket exceeds the limit', () => {
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const resolved = resolveSocketPath(OVER_LIMIT_SOCKET_PATH, {
      explicit: true,
    });

    // Criterion 2: the substitution itself is still a short, hash-derived path —
    // but now inside an owner-private per-uid directory rather than directly
    // under a shared, world-writable /tmp (issue #292).
    expect(resolved).not.toBe(OVER_LIMIT_SOCKET_PATH);
    expect(path.dirname(resolved)).toBe(expectedFallbackDir());
    expect(path.basename(resolved).startsWith('agentmonitors-')).toBe(true);
    expect(resolved.endsWith('.sock')).toBe(true);
    expect(resolved.length).toBeLessThanOrEqual(100);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [message] = writeSpy.mock.calls[0] as [string];
    expect(message).toContain(OVER_LIMIT_SOCKET_PATH); // requested path
    expect(message).toContain('100'); // the limit exceeded
    expect(message).toContain(String(OVER_LIMIT_SOCKET_PATH.length)); // by how much
    expect(message).toContain(resolved); // the substituted path
  });

  it('does not warn when an explicit --socket path is within the limit', () => {
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const shortPath = '/tmp/short.sock';

    const resolved = resolveSocketPath(shortPath, { explicit: true });

    expect(resolved).toBe(shortPath);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  // Acceptance criterion 4: env/default-derived candidates may hash silently,
  // as today — an over-limit candidate that was NOT flagged `explicit` (the
  // caller passed no --socket flag at all) must stay silent.
  it('substitutes an over-limit path silently when not marked explicit', () => {
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const resolved = resolveSocketPath(OVER_LIMIT_SOCKET_PATH);

    expect(resolved).not.toBe(OVER_LIMIT_SOCKET_PATH);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('stays silent for an over-limit AGENTMONITORS_SOCKET value even when explicit:true is passed with no overridePath', () => {
    // explicit:true only matters when overridePath itself is defined — an
    // env-derived candidate must never be attributed to the caller as if they
    // typed --socket themselves.
    process.env['AGENTMONITORS_SOCKET'] = OVER_LIMIT_SOCKET_PATH;
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const resolved = resolveSocketPath(undefined, { explicit: true });

    expect(resolved).not.toBe(OVER_LIMIT_SOCKET_PATH);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveSocketPath: legacy long-path fallback migration (issue #292 review)
//
// The over-limit fallback location moved from /tmp/agentmonitors-<hash>.sock to
// the per-uid /tmp/agentmonitors-<uid>/agentmonitors-<hash>.sock. If a live
// pre-upgrade daemon still answers at the legacy path, upgraded clients must
// keep talking to it (no split-brain second daemon); otherwise they use the new
// per-uid path.
// ---------------------------------------------------------------------------

/**
 * A DISTINCT over-limit candidate (its own hash) so the live legacy socket we
 * plant here never leaks into the other over-limit tests, which expect the new
 * per-uid path.
 */
const MIGRATION_CANDIDATE = `/tmp/${'m'.repeat(130)}/agentmon.sock`;

/** The legacy (pre-#292) fallback path for a candidate. Mirrors daemon-ipc. */
function legacyFallbackPath(candidate: string): string {
  const hash = createHash('sha256')
    .update(candidate)
    .digest('hex')
    .slice(0, 16);
  return path.join('/tmp', `agentmonitors-${hash}.sock`);
}

describe.skipIf(process.platform === 'win32')(
  'resolveSocketPath — legacy fallback migration (issue #292)',
  () => {
    let liveLegacy: net.Server | undefined;

    afterEach(async () => {
      if (liveLegacy) {
        await new Promise<void>((resolve) => {
          liveLegacy?.close(() => {
            resolve();
          });
        });
        liveLegacy = undefined;
      }
      rmSync(legacyFallbackPath(MIGRATION_CANDIDATE), { force: true });
    });

    it('routes to the legacy path when a live daemon still answers there', async () => {
      const legacy = legacyFallbackPath(MIGRATION_CANDIDATE);
      rmSync(legacy, { force: true });
      liveLegacy = net.createServer();
      await new Promise<void>((resolve, reject) => {
        liveLegacy?.once('error', reject);
        liveLegacy?.listen(legacy, () => {
          resolve();
        });
      });

      // A pre-upgrade daemon is listening at the legacy path → keep using it.
      expect(resolveSocketPath(MIGRATION_CANDIDATE)).toBe(legacy);
    });

    it('routes to the new per-uid path when no live legacy daemon is present', () => {
      // No listener (also covers a stale socket file: a dead listener fails the
      // liveness probe and we fall through to the new per-uid path).
      rmSync(legacyFallbackPath(MIGRATION_CANDIDATE), { force: true });

      const resolved = resolveSocketPath(MIGRATION_CANDIDATE);
      expect(resolved).not.toBe(legacyFallbackPath(MIGRATION_CANDIDATE));
      expect(path.dirname(resolved)).toBe(expectedFallbackDir());
      expect(resolved.endsWith('.sock')).toBe(true);
    });
  },
);

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

// ---------------------------------------------------------------------------
// Owner-only IPC artifacts: socket, socket directory, startup lock, and the
// long-socket-path fallback directory (issue #292).
//
// POSIX-only (modes are meaningless on win32). Each test runs under an explicit
// permissive umask (0o022) so a raw bind/mkdir would otherwise leave
// world-readable artifacts — the assertions therefore prove the hardening.
// ---------------------------------------------------------------------------
const mode = (p: string): number => statSync(p).mode & 0o777;

describe.skipIf(process.platform === 'win32')(
  'daemon IPC artifacts are owner-only (issue #292)',
  () => {
    let originalUmask: number;

    beforeEach(() => {
      originalUmask = process.umask(0o022);
    });

    afterEach(() => {
      process.umask(originalUmask);
    });

    it('creates a missing socket directory 0700 and binds the socket 0600', async () => {
      // A socket directory the daemon has to create (e.g. the default
      // per-workspace data directory on first run) must be owner-only, and the
      // bound socket itself owner-only, even under a permissive umask.
      const dir = path.join(tempDir(), 'data');
      const socketPath = path.join(dir, 'agentmonitors.sock');

      const server = createDaemonServer({
        runtime: createRuntime(':memory:'),
        socketPath,
      });
      try {
        await server.listen();
        expect(mode(dir)).toBe(0o700);
        expect(lstatSync(socketPath).isSocket()).toBe(true);
        expect(mode(socketPath)).toBe(0o600);
      } finally {
        await server.close().catch(() => undefined);
      }
    });

    it('does not chmod a pre-existing, shared socket directory (respects an explicit --socket)', () => {
      // Regression guard: binding a socket the user pointed at a shared/system
      // directory must NOT tighten that directory (tightening — or, as root,
      // chmod-ing — /tmp or another user's dir would be wrong). Only the
      // Agent-Monitors-owned data directory is tightened, at createDb time.
      const shared = tempDir();
      chmodSync(shared, 0o755);
      const socketPath = path.join(shared, 'explicit.sock');

      const server = createDaemonServer({
        runtime: createRuntime(':memory:'),
        socketPath,
      });
      // We only need the synchronous dir-preparation side effect; the factory
      // runs ensureSocketDir eagerly, so no bind is required.
      void server;
      expect(mode(shared)).toBe(0o755);
    });

    it('tightens a pre-existing Agent-Monitors-owned default socket directory for a :memory: db (issue #292 review)', () => {
      // Root gap: a :memory: db never runs createDb's ensurePrivateDir, so a
      // pre-existing world-readable default socket directory was never
      // tightened. Point the XDG data root at a temp dir so socketBaseDir()
      // (which ensureSocketDir compares against) resolves there.
      const dataHome = tempDir();
      const prevXdg = process.env['XDG_DATA_HOME'];
      const prevDb = process.env['AGENTMONITORS_DB'];
      process.env['XDG_DATA_HOME'] = dataHome;
      process.env['AGENTMONITORS_DB'] = ':memory:';
      try {
        const baseDir = path.join(dataHome, 'agentmonitors');
        mkdirSync(baseDir, { recursive: true });
        chmodSync(baseDir, 0o755);
        const socketPath = path.join(baseDir, 'agentmonitors.sock');

        // ensureSocketDir runs eagerly in the factory; no bind needed.
        void createDaemonServer({
          runtime: createRuntime(':memory:'),
          socketPath,
        });

        expect(mode(baseDir)).toBe(0o700);
      } finally {
        if (prevXdg === undefined) delete process.env['XDG_DATA_HOME'];
        else process.env['XDG_DATA_HOME'] = prevXdg;
        if (prevDb === undefined) delete process.env['AGENTMONITORS_DB'];
        else process.env['AGENTMONITORS_DB'] = prevDb;
      }
    });

    it('creates the startup lock directory 0700', () => {
      const socketPath = tempSocketPath('lock-mode');
      const acquired = acquireStartupLock(socketPath);
      try {
        expect(acquired).toBe(true);
        expect(mode(lockPath(socketPath))).toBe(0o700);
      } finally {
        releaseStartupLock(socketPath);
      }
    });

    it('places the long-path fallback socket 0600 inside an owner-only per-uid directory', async () => {
      // An over-limit candidate resolves to the private per-uid fallback dir,
      // never a predictable /tmp/*.sock a peer could connect to.
      const fallbackSocket = resolveSocketPath(OVER_LIMIT_SOCKET_PATH);
      const fallbackDir = path.dirname(fallbackSocket);
      expect(fallbackDir).toBe(expectedFallbackDir());

      const server = createDaemonServer({
        runtime: createRuntime(':memory:'),
        socketPath: fallbackSocket,
      });
      try {
        await server.listen();
        // The per-uid fallback directory is owner-only, so a peer cannot even
        // traverse into it to reach the socket.
        expect(mode(fallbackDir)).toBe(0o700);
        expect(mode(fallbackSocket)).toBe(0o600);
      } finally {
        await server.close().catch(() => undefined);
        // Clean only the socket we created; the per-uid dir is shared and
        // stays (owner-only) for any real daemon on this machine.
        rmSync(fallbackSocket, { force: true });
      }
    });
  },
);
