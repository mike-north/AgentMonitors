/**
 * Integration tests for source-incoming-changes.
 *
 * Tests use a real temp git repository initialised with execFileSync so that
 * the source is exercised against genuine git output.
 *
 * Deterministic env vars:
 *   - GIT_AUTHOR_DATE / GIT_COMMITTER_DATE are set to a fixed ISO timestamp
 *     so commit SHAs are stable across machines and CI runs.
 *   - `-c user.name` / `-c user.email` are passed for every git call that
 *     requires them so the tests never depend on global git config.
 *
 * Rule: no `new Date()` / `Date.now()` in test data (fixed-dates-in-tests rule).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import source from './index.js';

// ---------------------------------------------------------------------------
// Fixed test constants (no dynamic Date/now usage)
// ---------------------------------------------------------------------------

const FIXED_DATE = '2024-01-15T10:30:00+0000';
const NOW = new Date('2024-01-15T10:30:00.000Z');

// ---------------------------------------------------------------------------
// Temp repo helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ic-test-'));
  dirs.push(dir);

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

/** Run a git command in the given repo directory with deterministic author/committer dates. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    },
  });
}

/** Write a file in `dir` and commit it, returning the new commit SHA. */
function writeAndCommit(
  dir: string,
  files: Record<string, string>,
  message: string,
): string {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, ['add', '.']);
  git(dir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--message',
    message,
  ]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** Delete a file in `dir` and commit the deletion, returning the new SHA. */
function deleteAndCommit(
  dir: string,
  relPath: string,
  message: string,
): string {
  git(dir, ['rm', relPath]);
  git(dir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--message',
    message,
  ]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('source-incoming-changes', () => {
  it('has correct name, stateful flag, and scopeSchema', () => {
    expect(source.name).toBe('incoming-changes');
    expect(source.stateful).toBe(true);
    expect(source.scopeSchema).toHaveProperty('properties');
    const props = source.scopeSchema['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('paths');
    expect(props).toHaveProperty('branch');
    expect(props).toHaveProperty('cwd');
    expect(source.scopeSchema['required']).toContain('paths');
  });

  it('throws on missing paths config', async () => {
    const dir = makeTempRepo();
    writeAndCommit(dir, { 'a.txt': 'init' }, 'init');
    await expect(source.observe({ cwd: dir }, { now: NOW })).rejects.toThrow(
      'scope.paths',
    );
  });

  // -------------------------------------------------------------------------
  // Baseline behaviour
  // -------------------------------------------------------------------------

  describe('baseline run', () => {
    it('emits no observations on first run and records the current SHA', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'hello' }, 'init');

      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      expect(result.observations).toHaveLength(0);
      expect(result.nextState).toBeDefined();

      const state = result.nextState as { ref: string };
      expect(typeof state.ref).toBe('string');
      expect(state.ref).toHaveLength(40); // full SHA
    });

    it('does not report existing files as created on baseline', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }, 'init');

      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      expect(result.observations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Ref-advance detection
  // -------------------------------------------------------------------------

  describe('ref advance', () => {
    it('emits no observations when ref has not advanced', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'hello' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      // Second observe with same HEAD — nothing changed
      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      expect(result.observations).toHaveLength(0);
    });

    it('emits a modified observation when a tracked file changes', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'initial content' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      writeAndCommit(dir, { 'a.txt': 'updated content' }, 'update a.txt');

      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.changeKind).toBe('modified');
      expect(obs?.objectKey).toBe('a.txt');
      expect(obs?.title).toContain('a.txt');
      expect(obs?.title).toContain('modified');
      expect(obs?.snapshotText).toBe('updated content');
    });

    it('emits a created observation when a new file is added', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'existing' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      writeAndCommit(dir, { 'new.txt': 'brand new' }, 'add new.txt');

      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.changeKind).toBe('created');
      expect(obs?.objectKey).toBe('new.txt');
      expect(obs?.snapshotText).toBe('brand new');
    });

    it('emits a deleted observation when a file is removed', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'to-delete.txt': 'bye' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      deleteAndCommit(dir, 'to-delete.txt', 'remove to-delete.txt');

      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.changeKind).toBe('deleted');
      expect(obs?.objectKey).toBe('to-delete.txt');
      // No snapshotText for deleted files
      expect(obs?.snapshotText).toBeUndefined();
    });

    it('emits one observation per changed file when multiple files change', async () => {
      const dir = makeTempRepo();
      writeAndCommit(
        dir,
        { 'a.txt': 'a0', 'b.txt': 'b0', 'c.txt': 'c0' },
        'init',
      );

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      writeAndCommit(dir, { 'a.txt': 'a1', 'b.txt': 'b1' }, 'update a and b');

      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      expect(result.observations).toHaveLength(2);
      const keys = result.observations.map((o) => o.objectKey).sort();
      expect(keys).toEqual(['a.txt', 'b.txt']);
    });
  });

  // -------------------------------------------------------------------------
  // Path filtering
  // -------------------------------------------------------------------------

  describe('path filtering', () => {
    it('ignores changes outside configured paths', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'src/app.ts': 'export {}' }, 'init');

      const baseline = await source.observe(
        { paths: ['src/'], cwd: dir },
        { now: NOW },
      );

      // Only change a file outside src/
      writeAndCommit(dir, { 'README.md': '# Project' }, 'add readme');

      const result = await source.observe(
        { paths: ['src/'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      expect(result.observations).toHaveLength(0);
    });

    it('includes changes inside configured paths and excludes those outside', async () => {
      const dir = makeTempRepo();
      writeAndCommit(
        dir,
        { 'src/app.ts': 'v0', 'docs/guide.md': 'v0' },
        'init',
      );

      const baseline = await source.observe(
        { paths: ['src/'], cwd: dir },
        { now: NOW },
      );

      // Change both src/ and docs/
      writeAndCommit(
        dir,
        { 'src/app.ts': 'v1', 'docs/guide.md': 'v1' },
        'update both',
      );

      const result = await source.observe(
        { paths: ['src/'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.objectKey).toBe('src/app.ts');
    });
  });

  // -------------------------------------------------------------------------
  // nextState round-trip / restart-safety
  // -------------------------------------------------------------------------

  describe('nextState round-trip', () => {
    it('advances nextState.ref after each commit', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'v0' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );
      const sha0 = (baseline.nextState as { ref: string }).ref;

      writeAndCommit(dir, { 'a.txt': 'v1' }, 'update a');

      const result1 = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );
      const sha1 = (result1.nextState as { ref: string }).ref;

      expect(sha0).not.toBe(sha1);
      expect(sha1).toHaveLength(40);
    });

    it('is restart-safe: feeding nextState back as previousState yields the same result', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'v0' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      writeAndCommit(dir, { 'a.txt': 'v1' }, 'update a');

      const run1 = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      // Simulate a daemon restart: re-run with run1's nextState
      // (no new commits since) — should emit no observations
      const run2 = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: run1.nextState, now: NOW },
      );

      expect(run2.observations).toHaveLength(0);
      expect((run2.nextState as { ref: string }).ref).toBe(
        (run1.nextState as { ref: string }).ref,
      );
    });

    it('accumulates net diff across multiple commits when daemon was offline', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'v0', 'b.txt': 'v0' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      // Multiple commits happen while daemon is "offline"
      writeAndCommit(dir, { 'a.txt': 'v1' }, 'commit 1');
      writeAndCommit(dir, { 'b.txt': 'v1' }, 'commit 2');
      writeAndCommit(dir, { 'a.txt': 'v2' }, 'commit 3');

      // Single observe call catches all net changes
      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      // a.txt: net modified (v0→v2), b.txt: net modified (v0→v1)
      const keys = result.observations.map((o) => o.objectKey).sort();
      expect(keys).toEqual(['a.txt', 'b.txt']);
      expect(
        result.observations.every((o) => o.changeKind === 'modified'),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // payload / queryScope structure
  // -------------------------------------------------------------------------

  describe('observation payload and queryScope', () => {
    it('includes fromRef, toRef, path, and status in payload', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'file.ts': 'original' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );
      const fromRef = (baseline.nextState as { ref: string }).ref;

      writeAndCommit(dir, { 'file.ts': 'modified' }, 'change file');

      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      const obs = result.observations[0];
      const payload = obs?.payload as {
        path: string;
        status: string;
        fromRef: string;
        toRef: string;
      };
      expect(payload.path).toBe('file.ts');
      expect(payload.status).toBe('M');
      expect(payload.fromRef).toBe(fromRef);
      expect(typeof payload.toRef).toBe('string');
      expect(payload.toRef).toHaveLength(40);
    });

    it('includes path in queryScope', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'x.ts': 'init' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      writeAndCommit(dir, { 'x.ts': 'change' }, 'change x');

      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: baseline.nextState, now: NOW },
      );

      const obs = result.observations[0];
      expect(obs?.queryScope).toEqual({ path: 'x.ts' });
    });
  });

  // -------------------------------------------------------------------------
  // Non-fast-forward (force-push / rebase) — must not crash
  // -------------------------------------------------------------------------

  describe('non-fast-forward advance', () => {
    it('handles a force-push (orphaned history) without crashing', async () => {
      const dir = makeTempRepo();
      writeAndCommit(dir, { 'a.txt': 'initial' }, 'init');

      const baseline = await source.observe(
        { paths: ['.'], cwd: dir },
        { now: NOW },
      );

      // Capture current HEAD as the "previous" SHA before orphaning
      const prevSha = (baseline.nextState as { ref: string }).ref;

      // Create an orphan branch (simulates a force-push with rewritten history)
      git(dir, ['checkout', '--orphan', 'orphan-branch']);
      git(dir, ['rm', '-rf', '.']);
      writeAndCommit(dir, { 'a.txt': 'rewritten' }, 'orphan root commit');

      const orphanSha = git(dir, ['rev-parse', 'HEAD']).trim();

      // Feed the old baseline (prevSha) but current HEAD is now the orphan SHA.
      // git diff <prevSha>..<orphanSha> should still produce output (or empty).
      // The important thing is it must not throw.
      const result = await source.observe(
        { paths: ['.'], cwd: dir },
        { previousState: { ref: prevSha }, now: NOW },
      );

      // We just care it doesn't throw; observations may or may not include a.txt
      expect(Array.isArray(result.observations)).toBe(true);
      expect(typeof (result.nextState as { ref: string }).ref).toBe('string');
      // nextState should record the orphan SHA (current HEAD on orphan branch)
      expect((result.nextState as { ref: string }).ref).toBe(orphanSha);
    });
  });
});
