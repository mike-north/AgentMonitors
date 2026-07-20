import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLocalState, writeLocalState } from './local-state.js';

// DEFAULT_REAP_AFTER_MS is 5 * 60 * 1000 = 300_000 — keep in sync with the module.
const DEFAULT_REAP_AFTER_MS = 5 * 60 * 1_000;

describe('local-state', () => {
  it('returns enabled:false when the file is absent (quick-exit default)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      expect(readLocalState(ws).enabled).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('round-trips enabled + socket + db + reapAfterMs', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      writeLocalState(ws, {
        enabled: true,
        socket: '/x/a.sock',
        db: '/x/i.db',
        reapAfterMs: 300000,
      });
      const state = readLocalState(ws);
      expect(state).toEqual({
        enabled: true,
        socket: '/x/a.sock',
        db: '/x/i.db',
        reapAfterMs: 300000,
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('treats a present-but-enabled:false file as disabled', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      // Use writeLocalState (which creates `.claude/`) so the test reliably
      // exercises the enabled:false parse path — never throwing on a missing dir.
      writeLocalState(ws, { enabled: false });
      expect(readLocalState(ws).enabled).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Negative / edge cases
  // -------------------------------------------------------------------------

  it('returns enabled:false when content does not start with ---', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      mkdirSync(path.join(ws, '.claude'), { recursive: true });
      writeFileSync(
        path.join(ws, '.claude', 'agentmonitors.local.md'),
        'not frontmatter at all\nenabled: true\n',
        'utf-8',
      );
      expect(readLocalState(ws).enabled).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns enabled:false when opening --- has no closing ---', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      mkdirSync(path.join(ws, '.claude'), { recursive: true });
      writeFileSync(
        path.join(ws, '.claude', 'agentmonitors.local.md'),
        '---\nenabled: true\nsocket: /x/a.sock\n(no closing delimiter)',
        'utf-8',
      );
      expect(readLocalState(ws).enabled).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('uses DEFAULT_REAP_AFTER_MS when reap-after-ms is absent', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      // Write a file with no reap-after-ms field
      mkdirSync(path.join(ws, '.claude'), { recursive: true });
      writeFileSync(
        path.join(ws, '.claude', 'agentmonitors.local.md'),
        '---\nenabled: true\nsocket: /x/a.sock\n---\n',
        'utf-8',
      );
      const state = readLocalState(ws);
      expect(state.reapAfterMs).toBe(DEFAULT_REAP_AFTER_MS);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // lastBootFailureAt (issue #389 review finding 6): distinguishes
  // "this session's own lazy boot failed" from "no session has ever
  // started here" — both otherwise look identical (enabled, no socket).
  // ---------------------------------------------------------------------

  it('round-trips lastBootFailureAt', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      const failedAt = '2026-07-19T14:00:00.000Z';
      writeLocalState(ws, {
        enabled: true,
        reapAfterMs: DEFAULT_REAP_AFTER_MS,
        lastBootFailureAt: failedAt,
      });
      const state = readLocalState(ws);
      expect(state.lastBootFailureAt).toBe(failedAt);
      // Never persisted alongside a socket in real usage (session.ts writes
      // the marker WITHOUT socket/db on failure) — but the parser itself
      // makes no such assumption, so this is purely a marker roundtrip.
      expect(state.socket).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('omits lastBootFailureAt from the written file (and reads back undefined) when absent', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      writeLocalState(ws, { enabled: true, socket: '/x/a.sock' });
      const state = readLocalState(ws);
      expect(state.lastBootFailureAt).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('round-trips a socket/db path containing a space', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      const socketWithSpace = '/tmp/my workspace/daemon.sock';
      const dbWithSpace = '/tmp/my workspace/inbox.db';
      writeLocalState(ws, {
        enabled: true,
        socket: socketWithSpace,
        db: dbWithSpace,
        reapAfterMs: 1000,
      });
      const state = readLocalState(ws);
      expect(state.socket).toBe(socketWithSpace);
      expect(state.db).toBe(dbWithSpace);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
