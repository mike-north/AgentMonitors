import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  claudeCodeAdapter,
  createDb,
} from '@agentmonitors/core';
import source, { isNotFoundError } from './index.js';

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fp-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('source-file-fingerprint', () => {
  it('has correct name and scopeSchema', () => {
    expect(source.name).toBe('file-fingerprint');
    expect(source.scopeSchema).toHaveProperty('properties');
  });

  it('returns no observations on first run (baseline)', async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'a.txt'), 'hello');

    const result = await source.observe(
      { globs: ['*.txt'], cwd: dir },
      { now: new Date() },
    );
    expect(result.observations).toHaveLength(0);
    expect(result.nextState).toBeDefined();
  });

  it('detects file changes on subsequent runs', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'a.txt');
    writeFileSync(filePath, 'hello');

    const baseline = await source.observe(
      { globs: ['*.txt'], cwd: dir },
      { now: new Date() },
    );

    writeFileSync(filePath, 'world');
    const result = await source.observe(
      { globs: ['*.txt'], cwd: dir },
      { previousState: baseline.nextState, now: new Date() },
    );

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.title).toContain('a.txt');
    const snap = result.observations[0]?.snapshot as {
      previousHash: string;
      currentHash: string;
    };
    expect(snap.previousHash).not.toBe(snap.currentHash);
  });

  it('returns no observations when files have not changed', async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'stable.txt'), 'same content');

    const baseline = await source.observe(
      { globs: ['*.txt'], cwd: dir },
      { now: new Date() },
    );
    const result = await source.observe(
      { globs: ['*.txt'], cwd: dir },
      { previousState: baseline.nextState, now: new Date() },
    );

    expect(result.observations).toHaveLength(0);
  });

  it('throws on missing globs config', async () => {
    await expect(source.observe({}, { now: new Date() })).rejects.toThrow(
      'globs',
    );
  });

  // G3: beyond modify, the source distinguishes created / deleted / descoped.
  describe('create, delete, and descope (G3)', () => {
    // changeKind is a first-class typed field on the Observation; the runtime is
    // what copies it into the materialized event's queryScope (tested in core).
    function changeKindOf(obs: { changeKind?: unknown } | undefined): unknown {
      return obs?.changeKind;
    }

    it('emits a created observation when a new file appears after baseline', async () => {
      const dir = makeTempDir();
      writeFileSync(path.join(dir, 'a.txt'), 'a');
      const baseline = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date() },
      );

      writeFileSync(path.join(dir, 'b.txt'), 'b');
      const result = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { previousState: baseline.nextState, now: new Date() },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.title).toContain('b.txt');
      expect(changeKindOf(obs)).toBe('created');
    });

    it('emits a deleted observation when a tracked file is removed from disk', async () => {
      const dir = makeTempDir();
      const filePath = path.join(dir, 'a.txt');
      writeFileSync(filePath, 'a');
      const baseline = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date() },
      );

      rmSync(filePath);
      const result = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { previousState: baseline.nextState, now: new Date() },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.title).toContain('a.txt');
      expect(changeKindOf(obs)).toBe('deleted');
      expect(obs?.snapshotText).toBeUndefined();
      const next = result.nextState as { fingerprints: Record<string, string> };
      expect(Object.keys(next.fingerprints)).toHaveLength(0);
    });

    it('emits a descoped observation when a tracked file still exists but no longer matches', async () => {
      const dir = makeTempDir();
      writeFileSync(path.join(dir, 'a.txt'), 'a');
      const baseline = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date() },
      );

      // a.txt is still on disk, but the globs no longer match it.
      const result = await source.observe(
        { globs: ['*.md'], cwd: dir },
        { previousState: baseline.nextState, now: new Date() },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.title).toContain('a.txt');
      expect(changeKindOf(obs)).toBe('descoped');
      const next = result.nextState as { fingerprints: Record<string, string> };
      expect(Object.keys(next.fingerprints)).toHaveLength(0);
    });

    it('tags modified observations with changeKind "modified"', async () => {
      const dir = makeTempDir();
      const filePath = path.join(dir, 'a.txt');
      writeFileSync(filePath, 'hello');
      const baseline = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date() },
      );

      writeFileSync(filePath, 'world');
      const result = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { previousState: baseline.nextState, now: new Date() },
      );

      expect(result.observations).toHaveLength(1);
      expect(changeKindOf(result.observations[0])).toBe('modified');
    });

    it('does not emit created/deleted observations on the baseline run', async () => {
      const dir = makeTempDir();
      writeFileSync(path.join(dir, 'a.txt'), 'a');
      writeFileSync(path.join(dir, 'b.txt'), 'b');

      const result = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date() },
      );
      expect(result.observations).toHaveLength(0);
    });
  });

  // Salience policy (003 §3.4): a `deleted` observation carries `salience:
  // 'high'` so a `normal..high` band monitor can escalate on file deletion.
  // Other change kinds carry no salience, leaving effective urgency at the
  // monitor's band floor (band.lo).
  describe('salience (003 §3.4)', () => {
    it('emits salience: high on a deleted observation', async () => {
      const dir = makeTempDir();
      const filePath = path.join(dir, 'a.txt');
      writeFileSync(filePath, 'a');
      const baseline = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date('2026-01-15T10:00:00.000Z') },
      );

      rmSync(filePath);
      const result = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        {
          previousState: baseline.nextState,
          now: new Date('2026-01-15T10:01:00.000Z'),
        },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.changeKind).toBe('deleted');
      expect(obs?.salience).toBe('high');
    });

    it('emits no salience on a modified observation (effective urgency stays at band floor)', async () => {
      const dir = makeTempDir();
      const filePath = path.join(dir, 'a.txt');
      writeFileSync(filePath, 'hello');
      const baseline = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date('2026-01-15T10:00:00.000Z') },
      );

      writeFileSync(filePath, 'world');
      const result = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        {
          previousState: baseline.nextState,
          now: new Date('2026-01-15T10:01:00.000Z'),
        },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.changeKind).toBe('modified');
      expect(obs?.salience).toBeUndefined();
    });

    it('emits no salience on a created observation (effective urgency stays at band floor)', async () => {
      const dir = makeTempDir();
      writeFileSync(path.join(dir, 'a.txt'), 'a');
      const baseline = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date('2026-01-15T10:00:00.000Z') },
      );

      writeFileSync(path.join(dir, 'b.txt'), 'b');
      const result = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        {
          previousState: baseline.nextState,
          now: new Date('2026-01-15T10:01:00.000Z'),
        },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.changeKind).toBe('created');
      expect(obs?.salience).toBeUndefined();
    });

    it('emits no salience on a descoped observation (file still exists, no info lost)', async () => {
      const dir = makeTempDir();
      writeFileSync(path.join(dir, 'a.txt'), 'a');
      const baseline = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date('2026-01-15T10:00:00.000Z') },
      );

      // Switch globs so a.txt is no longer matched — it still exists on disk.
      const result = await source.observe(
        { globs: ['*.md'], cwd: dir },
        {
          previousState: baseline.nextState,
          now: new Date('2026-01-15T10:01:00.000Z'),
        },
      );

      expect(result.observations).toHaveLength(1);
      const obs = result.observations[0];
      expect(obs?.changeKind).toBe('descoped');
      expect(obs?.salience).toBeUndefined();
    });
  });

  // Regression: only a genuine "not found" may be read as a deletion. Other stat
  // errors (EACCES, transient IO) must not be misclassified as `deleted`.
  describe('isNotFoundError', () => {
    it('treats ENOENT and ENOTDIR as not-found', () => {
      expect(isNotFoundError({ code: 'ENOENT' })).toBe(true);
      expect(isNotFoundError({ code: 'ENOTDIR' })).toBe(true);
    });

    it('does not treat other errors as not-found', () => {
      expect(isNotFoundError({ code: 'EACCES' })).toBe(false);
      expect(isNotFoundError({ code: 'EPERM' })).toBe(false);
      expect(isNotFoundError(new Error('boom'))).toBe(false);
      expect(isNotFoundError(undefined)).toBe(false);
      expect(isNotFoundError(null)).toBe(false);
    });
  });

  describe('cache isolation', () => {
    it('different configs watching the same file maintain separate baselines', async () => {
      const dir = makeTempDir();
      const filePath = path.join(dir, 'shared.txt');
      writeFileSync(filePath, 'initial');

      const config1 = { globs: ['*.txt'], cwd: dir };
      const config2 = { globs: ['shared.*'], cwd: dir };

      // Baseline for config1
      const baseline1 = await source.observe(config1, { now: new Date() });

      // Modify the file
      writeFileSync(filePath, 'modified');

      // Config2's first poll should be baseline (no observation), not
      // inherit config1's fingerprint and falsely report a change
      const result = await source.observe(config2, { now: new Date() });
      expect(result.observations).toHaveLength(0);

      // Config1 should detect the change since it has a previous baseline
      const result1 = await source.observe(config1, {
        previousState: baseline1.nextState,
        now: new Date(),
      });
      expect(result1.observations).toHaveLength(1);
    });
  });
});

// --- End-to-end escalation proof (issue #151) --------------------------------
//
// A file-fingerprint monitor authored with `urgency: normal..high` over a
// watched directory: deleting the file causes the source to emit
// `salience: 'high'`, and the runtime clamps it to the escalated effective
// urgency `high` within the `normal..high` band. A `modified` change on the
// same band materializes at `normal` (the band floor — no salience emitted).
//
// This proves RANGE urgency is now reachable end-to-end with a bundled source.
//
// Fake timers are used to advance time between ticks so the monitor's 1s
// poll interval (set in the MONITOR.md fixture) is satisfied without real
// wall-clock waiting.
//
// @see docs/specs/003-source-plugins.md §3.4 (file-fingerprint salience policy)
// @see docs/specs/002-runtime-delivery.md §4.1 (clamp formula)
describe('file-fingerprint end-to-end: salience escalation through the runtime (issue #151)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Create a MONITOR.md for file-fingerprint with an explicit throttle notify
   * so the observation emits immediately (avoids the 15s high-urgency debounce
   * settle when we're asserting materialized urgency, not notify timing).
   */
  function createFingerprintMonitorDir(
    rootDir: string,
    watchDir: string,
    urgency: string,
  ): string {
    const monitorDir = path.join(
      rootDir,
      '.claude',
      'monitors',
      'watch-salience',
    );
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---
name: Watch salience
watch:
  type: file-fingerprint
  globs:
    - '*.txt'
  cwd: ${JSON.stringify(watchDir)}
  interval: '1s'
urgency: ${urgency}
notify:
  strategy: throttle
  suppress-for: 1h
---
When files change, act on it.
`,
      'utf-8',
    );
    return path.join(rootDir, '.claude', 'monitors');
  }

  it('deleted file on a normal..high monitor materializes at urgency: high (escalated)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

    const rootDir = mkdtempSync(path.join(tmpdir(), 'fp-e2e-'));
    tempDirs.push(rootDir);
    const watchDir = mkdtempSync(path.join(tmpdir(), 'fp-e2e-watch-'));
    tempDirs.push(watchDir);

    const watchedFile = path.join(watchDir, 'important.txt');
    writeFileSync(watchedFile, 'content', 'utf-8');

    const monitorsDir = createFingerprintMonitorDir(
      rootDir,
      watchDir,
      'normal..high',
    );

    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    registry.register(source);
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-fp-e2e-deleted',
        workspacePath: rootDir,
      }),
    );

    // Tick 1: baseline run — stateful source records fingerprints, emits nothing.
    const baselineTick = await runtime.tick(monitorsDir, rootDir);
    expect(baselineTick.emittedEventIds).toHaveLength(0);

    // Advance past the 1s poll interval so the monitor is due on tick 2.
    vi.advanceTimersByTime(2_000);

    // Delete the file — the source will emit salience: 'high' on the next observe().
    rmSync(watchedFile);

    // Tick 2: deleted file → salience: 'high' → clamp('high', 'normal', 'high') = 'high'.
    const deleteTick = await runtime.tick(monitorsDir, rootDir);
    expect(deleteTick.emittedEventIds).toHaveLength(1);

    const unread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    // clamp(salience:'high', lo:'normal', hi:'high') === 'high' — escalated within band.
    expect(unread[0]?.urgency).toBe('high');
  });

  it('modified file on a normal..high monitor materializes at urgency: normal (band floor, no salience)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

    const rootDir = mkdtempSync(path.join(tmpdir(), 'fp-e2e-'));
    tempDirs.push(rootDir);
    const watchDir = mkdtempSync(path.join(tmpdir(), 'fp-e2e-watch-'));
    tempDirs.push(watchDir);

    const watchedFile = path.join(watchDir, 'content.txt');
    writeFileSync(watchedFile, 'initial', 'utf-8');

    const monitorsDir = createFingerprintMonitorDir(
      rootDir,
      watchDir,
      'normal..high',
    );

    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    registry.register(source);
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);

    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-fp-e2e-modified',
        workspacePath: rootDir,
      }),
    );

    // Tick 1: baseline.
    const baselineTick = await runtime.tick(monitorsDir, rootDir);
    expect(baselineTick.emittedEventIds).toHaveLength(0);

    // Advance past the 1s poll interval so the monitor is due on tick 2.
    vi.advanceTimersByTime(2_000);

    // Modify (not delete) the file — source emits no salience.
    writeFileSync(watchedFile, 'changed', 'utf-8');

    // Tick 2: modified → no salience → clamp(band.lo:'normal', 'normal', 'high') = 'normal'.
    const modifyTick = await runtime.tick(monitorsDir, rootDir);
    expect(modifyTick.emittedEventIds).toHaveLength(1);

    const unread = runtime.listEvents({
      sessionId: session.id,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    // clamp(salience:undefined → band.lo:'normal', 'normal', 'high') === 'normal' — no escalation.
    expect(unread[0]?.urgency).toBe('normal');
  });
});
