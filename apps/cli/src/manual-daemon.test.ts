import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveManualDaemonSocketPath } from './manual-daemon.js';
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
        workspacePaths(ws).socket,
      );
    } finally {
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
