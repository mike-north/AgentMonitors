import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveChannelSocketPath } from './channel.js';
import { resolveSocketPath } from '../daemon-ipc.js';
import { workspacePaths } from '../workspace-paths.js';
import { writeLocalState } from '../local-state.js';

/**
 * Unit coverage for `resolveChannelSocketPath` (issue #358): `channel serve`
 * previously resolved its socket directly via `resolveSocketPath`, considering
 * only an explicit `--socket`/`AGENTMONITORS_SOCKET`/the bare global default —
 * never an enabled workspace's persisted-or-derived per-workspace socket, the
 * resolution every other workspace-aware command uses
 * (`resolveManualDaemonSocketPath`, issue #335).
 *
 * Because `channel serve` is spawned *automatically* by the plugin's
 * `.mcp.json` (no flags, like a hook), its precedence is deliberately
 * different from `resolveManualDaemonSocketPath`'s env-first order: an
 * **enabled** workspace's own socket must win over a stale
 * `AGENTMONITORS_SOCKET` left over from a different workspace, or `channel
 * serve` can cross-connect to another workspace's daemon (a session-isolation
 * break) — see `resolveChannelSocketPath`'s doc comment in `channel.ts`. These
 * tests lock down: explicit `--socket` beats everything; an enabled
 * workspace's socket beats `AGENTMONITORS_SOCKET`; `AGENTMONITORS_SOCKET`
 * still applies when the workspace is not enabled; and the resolved value
 * matches the exact formula `session start`'s lazy-boot uses
 * (`resolveSocketPath(state.socket ?? workspacePaths(workspace).socket)`,
 * `apps/cli/src/commands/session.ts`).
 *
 * @see ../../../../docs/specs/006-agent-integration.md §4.1
 * @see ../../../../docs/specs/005-cli-reference.md §13
 */
describe('resolveChannelSocketPath (issue #358)', () => {
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

  it('an enabled workspace with a persisted socket resolves to the SAME socket session start lazy-boots to (the fix)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-chansock-'));
    try {
      const persisted = path.join(ws, 'persisted.sock');
      writeLocalState(ws, { enabled: true, socket: persisted });

      // `session start`'s own formula (apps/cli/src/commands/session.ts):
      // `resolveSocketPath(state.socket ?? workspacePaths(workspacePath).socket)`.
      const sessionStartDerivation = resolveSocketPath(persisted);

      expect(resolveChannelSocketPath(undefined, ws)).toBe(
        sessionStartDerivation,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an enabled workspace with NO persisted socket yet resolves to the derived per-workspace socket (matches session start before any daemon has bound)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-chansock-'));
    try {
      // `enabled: true` with no `socket:` field — the exact state a fresh
      // `.claude/agentmonitors.local.md` is in before `session start` has
      // ever lazy-booted a daemon for this workspace (the issue's own repro).
      writeLocalState(ws, { enabled: true });

      const sessionStartDerivation = resolveSocketPath(
        workspacePaths(ws).socket,
      );

      expect(resolveChannelSocketPath(undefined, ws)).toBe(
        sessionStartDerivation,
      );
      // Never the bare global default for an enabled workspace — this is the
      // exact regression: pre-fix, `channel serve` always resolved the bare
      // global default here, regardless of workspace state.
      expect(resolveChannelSocketPath(undefined, ws)).not.toBe(
        resolveSocketPath(undefined),
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an explicit --socket flag still wins outright, even for an enabled workspace with a different persisted socket', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-chansock-'));
    try {
      writeLocalState(ws, { enabled: true, socket: '/tmp/persisted.sock' });
      expect(resolveChannelSocketPath('/tmp/explicit.sock', ws)).toBe(
        '/tmp/explicit.sock',
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an enabled workspace socket wins over AGENTMONITORS_SOCKET (the isolation fix): a stale env var must not cross workspaces for automatically-spawned channel serve', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-chansock-'));
    try {
      writeLocalState(ws, { enabled: true, socket: '/tmp/persisted.sock' });
      process.env['AGENTMONITORS_SOCKET'] = '/tmp/env.sock';
      expect(resolveChannelSocketPath(undefined, ws)).toBe(
        resolveSocketPath('/tmp/persisted.sock'),
      );
      expect(resolveChannelSocketPath(undefined, ws)).not.toBe('/tmp/env.sock');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('AGENTMONITORS_SOCKET still wins when the workspace is NOT enabled (no per-workspace socket to prefer)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-chansock-'));
    try {
      // No local state file at all → readLocalState returns { enabled: false }.
      process.env['AGENTMONITORS_SOCKET'] = '/tmp/env.sock';
      expect(resolveChannelSocketPath(undefined, ws)).toBe('/tmp/env.sock');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a not-enabled workspace falls back to the SAME global default channel serve always used (unchanged behavior)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-chansock-'));
    try {
      // No local state file at all → readLocalState returns { enabled: false }.
      expect(resolveChannelSocketPath(undefined, ws)).toBe(
        resolveSocketPath(undefined),
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an explicit --socket flag still wins even when AGENTMONITORS_SOCKET and an enabled workspace socket are both set', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-chansock-'));
    try {
      writeLocalState(ws, { enabled: true, socket: '/tmp/persisted.sock' });
      process.env['AGENTMONITORS_SOCKET'] = '/tmp/env.sock';
      expect(resolveChannelSocketPath('/tmp/explicit.sock', ws)).toBe(
        '/tmp/explicit.sock',
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
