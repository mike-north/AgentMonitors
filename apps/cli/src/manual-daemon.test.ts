import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DaemonConnectionError, resolveSocketPath } from './daemon-ipc.js';
import {
  NO_WORKSPACE_DAEMON_MESSAGE,
  reportManualDaemonError,
  resolveManualDaemonSocketPath,
} from './manual-daemon.js';
import { workspacePaths } from './workspace-paths.js';
import { writeLocalState } from './local-state.js';

/**
 * Regression coverage for issue #335: manual daemon commands (`session
 * open`/`close`/`list`, `doctor`, `events *`, `hook claim`) previously fell
 * back to the bare global default socket for an enabled workspace whose
 * `.claude/agentmonitors.local.md` had no persisted `socket:` value yet —
 * exactly the state left behind by a directly-invoked `agentmonitors daemon
 * run` (the Getting Started guide's own instruction), which never persisted
 * local state at all. `resolveManualDaemonSocketPath` now derives the
 * per-workspace socket in that case instead of silently deferring to the
 * global default, so it agrees with what `daemon run` now binds to.
 */
describe('resolveManualDaemonSocketPath (issue #335)', () => {
  let savedSocketEnv: string | undefined;

  beforeEach(() => {
    savedSocketEnv = process.env['AGENTMONITORS_SOCKET'];
    delete process.env['AGENTMONITORS_SOCKET'];
  });

  afterEach(() => {
    if (savedSocketEnv === undefined) {
      delete process.env['AGENTMONITORS_SOCKET'];
    } else {
      process.env['AGENTMONITORS_SOCKET'] = savedSocketEnv;
    }
  });

  it('an explicit socket flag always wins', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-manualsock-'));
    try {
      writeLocalState(ws, { enabled: true, socket: '/tmp/persisted.sock' });
      expect(resolveManualDaemonSocketPath('/tmp/explicit.sock', ws)).toBe(
        '/tmp/explicit.sock',
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('AGENTMONITORS_SOCKET defers to the caller default (undefined) even for an enabled workspace', () => {
    process.env['AGENTMONITORS_SOCKET'] = '/tmp/env.sock';
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-manualsock-'));
    try {
      writeLocalState(ws, { enabled: true, socket: '/tmp/persisted.sock' });
      expect(resolveManualDaemonSocketPath(undefined, ws)).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an enabled workspace with a persisted socket uses that exact value', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-manualsock-'));
    try {
      writeLocalState(ws, { enabled: true, socket: '/tmp/persisted.sock' });
      expect(resolveManualDaemonSocketPath(undefined, ws)).toBe(
        '/tmp/persisted.sock',
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an enabled workspace with NO persisted socket derives the per-workspace socket (the fix)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-manualsock-'));
    try {
      // `enabled: true` with no `socket:` field — exactly what a directly
      // invoked `daemon run` left behind before this fix (it never wrote
      // local state, so `session open`/`doctor` fell back to the GLOBAL
      // default socket instead of the one `daemon run` actually bound to).
      writeLocalState(ws, { enabled: true });
      expect(resolveManualDaemonSocketPath(undefined, ws)).toBe(
        // Both entrypoints use 002 §10.3's normalized socket, including the
        // owner-private fallback when an isolated data root makes it too long.
        resolveSocketPath(workspacePaths(ws).socket),
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('normalizes an overlong derived socket exactly as the daemon does', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-manualsock-long-'));
    const savedDataHome = process.env['XDG_DATA_HOME'];
    try {
      // Force the fallback independently of the developer's ambient home.
      process.env['XDG_DATA_HOME'] = path.join(ws, 'nested/'.repeat(30));
      writeLocalState(ws, { enabled: true });
      const derived = workspacePaths(ws).socket;
      expect(derived.length).toBeGreaterThan(100);
      const normalized = resolveSocketPath(derived);
      expect(normalized).not.toBe(derived);
      expect(resolveManualDaemonSocketPath(undefined, ws)).toBe(normalized);
    } finally {
      if (savedDataHome === undefined) delete process.env['XDG_DATA_HOME'];
      else process.env['XDG_DATA_HOME'] = savedDataHome;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a not-enabled workspace returns undefined (defers to the global default)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-manualsock-'));
    try {
      expect(resolveManualDaemonSocketPath(undefined, ws)).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

/** Transport causes cannot change whether retrying a written mutation is safe. */
describe('manual daemon failure classification', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it.each(['reply timeout', 'socket error', 'socket close'])(
    'reports %s after write with exit 3',
    (cause) => {
      const stderr = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const stdout = vi
        .spyOn(console, 'log')
        .mockImplementation(() => undefined);
      reportManualDaemonError(
        new DaemonConnectionError(cause, undefined, true),
        true,
        {
          action: 'Events ack',
          checkCommand:
            'agentmonitors events list --session session-1 --unread',
        },
      );
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        `Error: Events ack outcome unknown: the daemon received the request but no reply arrived (${cause}). It may already have been applied, or may still be applied. Check with \`agentmonitors events list --session session-1 --unread\` before running it again.`,
      );
      expect(stdout).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(3);
    },
  );

  it.each(['missing socket', 'refused connection', 'connect timeout'])(
    'preserves %s before write with exit 1',
    (cause) => {
      const stderr = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      reportManualDaemonError(new DaemonConnectionError(cause), true);
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        `Error: ${NO_WORKSPACE_DAEMON_MESSAGE}`,
      );
      expect(process.exitCode).toBe(1);
    },
  );

  it('preserves application errors and JSON routing', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    reportManualDaemonError(new Error('Unknown session'), true);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      '{"error":"Unknown session"}',
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
