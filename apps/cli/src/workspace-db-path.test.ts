import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWorkspaceDbPath } from './workspace-db-path.js';
import { workspacePaths } from './workspace-paths.js';
import { writeLocalState } from './local-state.js';
import { resolveDbPath } from './db-path.js';

/**
 * Regression coverage for issue #335: `daemon run`/`daemon once`, invoked
 * directly with no `--socket`/`AGENTMONITORS_DB` overrides (as the Getting
 * Started guide instructs), previously bound to the bare global default db —
 * a *different* SQLite file than the one `doctor` independently derived for
 * an enabled workspace. `session open` (via that daemon) and `session list`
 * agreed with each other, but `doctor` read an empty database and reported no
 * lead session — three commands disagreeing about the same durable state (DX
 * study S3 F5). `resolveWorkspaceDbPath` is the single shared resolver now
 * used by both `doctor` and `daemon run`/`daemon once`, so this test locks
 * down its resolution order directly.
 */
describe('resolveWorkspaceDbPath (issue #335)', () => {
  let savedDb: string | undefined;

  beforeEach(() => {
    savedDb = process.env['AGENTMONITORS_DB'];
    delete process.env['AGENTMONITORS_DB'];
  });

  afterEach(() => {
    if (savedDb === undefined) {
      delete process.env['AGENTMONITORS_DB'];
    } else {
      process.env['AGENTMONITORS_DB'] = savedDb;
    }
  });

  it('AGENTMONITORS_DB always wins, even for an enabled workspace with a persisted db', () => {
    process.env['AGENTMONITORS_DB'] = '/tmp/override.db';
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-dbpath-'));
    try {
      writeLocalState(ws, { enabled: true, db: '/tmp/persisted.db' });
      expect(resolveWorkspaceDbPath(ws)).toBe('/tmp/override.db');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an enabled workspace with no persisted db uses the derived per-workspace db (the fix)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-dbpath-'));
    try {
      // `enabled: true` with no `db:` field — exactly what `init --enable-only`
      // writes, and exactly what a directly-invoked `daemon run` saw before
      // this fix (it never read local state at all).
      writeLocalState(ws, { enabled: true });
      expect(resolveWorkspaceDbPath(ws)).toBe(workspacePaths(ws).db);
      // Never falls back to the bare global default for an enabled workspace —
      // this is the exact regression: pre-fix, `daemon run`'s runtime used
      // `resolveDbPath()` unconditionally, so this assertion fails against
      // the pre-fix behavior.
      expect(resolveWorkspaceDbPath(ws)).not.toBe(resolveDbPath());
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an enabled workspace with a persisted db uses that exact value', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-dbpath-'));
    try {
      const persisted = path.join(ws, 'persisted.db');
      writeLocalState(ws, { enabled: true, db: persisted });
      expect(resolveWorkspaceDbPath(ws)).toBe(persisted);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a not-enabled workspace falls back to the shared global default', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-dbpath-'));
    try {
      // No local state file at all → readLocalState returns { enabled: false }.
      expect(resolveWorkspaceDbPath(ws)).toBe(resolveDbPath());
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('accepts a pre-read LocalState to avoid a redundant readLocalState call', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-dbpath-'));
    try {
      expect(resolveWorkspaceDbPath(ws, { enabled: false })).toBe(
        resolveDbPath(),
      );
      expect(
        resolveWorkspaceDbPath(ws, { enabled: true, db: '/tmp/explicit.db' }),
      ).toBe('/tmp/explicit.db');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
