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
  validateScope,
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

  describe('workspace-relative path resolution (issue #193)', () => {
    it('resolves relative globs from context.workspacePath instead of process cwd', async () => {
      const workspacePath = makeTempDir();
      const otherCwd = makeTempDir();
      mkdirSync(path.join(workspacePath, 'watched'), { recursive: true });
      const filePath = path.join(workspacePath, 'watched', 'note.md');
      writeFileSync(filePath, 'hello');

      const originalCwd = process.cwd();
      process.chdir(otherCwd);
      try {
        const result = await source.observe(
          { globs: ['watched/**/*.md'] },
          { now: new Date(), workspacePath },
        );

        const next = result.nextState as {
          fingerprints: Record<string, string>;
        };
        expect(Object.keys(next.fingerprints)).toEqual([filePath]);
        expect(result.outcome).toBeUndefined();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('resolves relative cwd from context.workspacePath', async () => {
      const workspacePath = makeTempDir();
      mkdirSync(path.join(workspacePath, 'docs'), { recursive: true });
      const filePath = path.join(workspacePath, 'docs', 'readme.md');
      writeFileSync(filePath, 'hello');

      const result = await source.observe(
        { globs: ['*.md'], cwd: 'docs' },
        { now: new Date(), workspacePath },
      );

      const next = result.nextState as { fingerprints: Record<string, string> };
      expect(Object.keys(next.fingerprints)).toEqual([filePath]);
    });

    it('honors absolute cwd and absolute globs unchanged', async () => {
      const workspacePath = makeTempDir();
      const absoluteRoot = makeTempDir();
      mkdirSync(path.join(workspacePath, 'docs'), { recursive: true });
      mkdirSync(path.join(absoluteRoot, 'docs'), { recursive: true });
      const cwdFile = path.join(absoluteRoot, 'docs', 'absolute-cwd.md');
      const globFile = path.join(absoluteRoot, 'docs', 'absolute-glob.md');
      writeFileSync(path.join(workspacePath, 'docs', 'workspace.md'), 'wrong');
      writeFileSync(cwdFile, 'cwd');
      writeFileSync(globFile, 'glob');

      const cwdResult = await source.observe(
        { globs: ['*.md'], cwd: path.join(absoluteRoot, 'docs') },
        { now: new Date(), workspacePath },
      );
      const globResult = await source.observe(
        { globs: [path.join(absoluteRoot, 'docs', 'absolute-glob.md')] },
        { now: new Date(), workspacePath },
      );

      const cwdNext = cwdResult.nextState as {
        fingerprints: Record<string, string>;
      };
      const globNext = globResult.nextState as {
        fingerprints: Record<string, string>;
      };
      expect(Object.keys(cwdNext.fingerprints).sort()).toEqual(
        [cwdFile, globFile].sort(),
      );
      expect(Object.keys(globNext.fingerprints)).toEqual([globFile]);
    });

    it('reports a distinct no-files-matched outcome for zero-match globs', async () => {
      const workspacePath = makeTempDir();

      const result = await source.observe(
        { globs: ['missing/**/*.md'] },
        { now: new Date(), workspacePath },
      );

      expect(result.observations).toHaveLength(0);
      expect(result.outcome).toBe('no-files-matched');
      expect(result.nextState).toEqual({ fingerprints: {} });
    });
  });

  // Ergonomic shorthand: a single pattern may be written as a bare string
  // (003 §3 — `globs` accepts a string or an array of strings).
  describe('globs string shorthand (003 §3)', () => {
    it('accepts a single glob written as a bare string and detects changes', async () => {
      const dir = makeTempDir();
      writeFileSync(path.join(dir, 'notes.md'), 'hello');

      // Baseline with the string form.
      const baseline = await source.observe(
        { globs: 'notes.md', cwd: dir },
        { now: new Date() },
      );
      expect(baseline.observations).toEqual([]);

      writeFileSync(path.join(dir, 'notes.md'), 'changed');
      const next = await source.observe(
        { globs: 'notes.md', cwd: dir },
        { previousState: baseline.nextState, now: new Date() },
      );
      expect(next.observations).toHaveLength(1);
      expect(next.observations[0]?.changeKind).toBe('modified');
    });

    it('treats the string form identically to a one-element array', async () => {
      const dir = makeTempDir();
      writeFileSync(path.join(dir, 'a.txt'), 'x');
      const asString = await source.observe(
        { globs: '*.txt', cwd: dir },
        { now: new Date() },
      );
      const asArray = await source.observe(
        { globs: ['*.txt'], cwd: dir },
        { now: new Date() },
      );
      // Same baseline behavior (no observations on first run for both forms).
      expect(asString.observations).toEqual(asArray.observations);
    });

    it('rejects an empty string', async () => {
      await expect(
        source.observe({ globs: '' }, { now: new Date() }),
      ).rejects.toThrow('globs');
    });

    it('rejects an empty array', async () => {
      await expect(
        source.observe({ globs: [] }, { now: new Date() }),
      ).rejects.toThrow('globs');
    });

    it('rejects a non-string, non-array globs value', async () => {
      await expect(
        source.observe({ globs: 42 }, { now: new Date() }),
      ).rejects.toThrow('globs');
    });
  });

  describe('scopeSchema accepts string or array globs (003 §3)', () => {
    it('documents the runtime observe interval knob', () => {
      const properties = source.scopeSchema['properties'] as Record<
        string,
        { description?: string; default?: string; type?: string }
      >;
      expect(properties['interval']).toMatchObject({
        type: 'string',
        default: '30s',
      });
      expect(properties['interval']?.description).toContain('30s');
      expect(properties['interval']?.description).toContain('watch.interval');
      expect(
        validateScope(
          { globs: 'notes.md', interval: '5s' },
          source.scopeSchema,
        ),
      ).toEqual([]);
    });

    it('accepts a bare string', () => {
      expect(validateScope({ globs: 'notes.md' }, source.scopeSchema)).toEqual(
        [],
      );
    });

    it('accepts an array of strings', () => {
      expect(
        validateScope({ globs: ['a.ts', 'b.ts'] }, source.scopeSchema),
      ).toEqual([]);
    });

    it('rejects a number', () => {
      expect(
        validateScope({ globs: 42 }, source.scopeSchema).length,
      ).toBeGreaterThan(0);
    });

    it('rejects an empty array', () => {
      expect(
        validateScope({ globs: [] }, source.scopeSchema).length,
      ).toBeGreaterThan(0);
    });

    it('rejects a missing globs field', () => {
      expect(validateScope({}, source.scopeSchema).length).toBeGreaterThan(0);
    });

    it('rejects a whitespace-only string pattern', () => {
      expect(
        validateScope({ globs: '   ' }, source.scopeSchema).length,
      ).toBeGreaterThan(0);
    });

    it('rejects an empty string in the array form', () => {
      expect(
        validateScope({ globs: [''] }, source.scopeSchema).length,
      ).toBeGreaterThan(0);
    });

    it('rejects a blank entry alongside a valid one in the array form', () => {
      expect(
        validateScope({ globs: ['a.ts', '   '] }, source.scopeSchema).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('parseScopeConfig error messages (003 §3)', () => {
    it('reports a dedicated "is required" error when globs is absent', async () => {
      await expect(source.observe({}, { now: new Date() })).rejects.toThrow(
        'scope.globs is required',
      );
    });
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
      expect(result.outcome).toBeUndefined();
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

// Proof for 003 §2.5 (snapshots-not-diffs): a BUNDLED source returns
// current-state snapshots + its own change-detection state (`nextState`); it
// does NOT pre-diff. The runtime is the sole producer of the delivery diff,
// computed against the consumer's stored baseline (002 §5.2). This drives a real
// bundled source through the real runtime and asserts each half of the contract.
//
// @see docs/specs/003-source-plugins.md §2.5
// @see docs/specs/002-runtime-delivery.md §5.2
describe('file-fingerprint × runtime: snapshots-not-diffs (003 §2.5)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the source returns a current-state snapshot, never a pre-diffed packet', async () => {
    const watchDir = makeTempDir();
    const filePath = path.join(watchDir, 'a.txt');
    writeFileSync(filePath, 'line one\nline two\n', 'utf-8');

    // Baseline run: stateful source records fingerprints, emits nothing.
    const baseline = await source.observe(
      { globs: ['*.txt'], cwd: watchDir },
      { now: new Date() },
    );
    expect(baseline.observations).toHaveLength(0);
    // The source carries its OWN change-detection state forward (§2.4/§2.5):
    // this is not a per-recipient baseline and not a diff.
    expect(baseline.nextState).toBeDefined();

    writeFileSync(filePath, 'line one\nline two CHANGED\n', 'utf-8');
    const next = await source.observe(
      { globs: ['*.txt'], cwd: watchDir },
      { previousState: baseline.nextState, now: new Date() },
    );

    expect(next.observations).toHaveLength(1);
    const obs = next.observations[0];
    // §2.5: the observation is the CURRENT whole-file state, not a delta. The
    // snapshot equals the full current file content — both old and new lines are
    // present, proving it is a snapshot rather than a "what changed" packet.
    expect(obs?.snapshotText).toBe('line one\nline two CHANGED\n');
    expect(obs?.snapshotText).toContain('line one'); // unchanged line still present
    // The source never produces a diff: the Observation contract has no diff
    // field, and the source must not smuggle one into the payload either.
    expect(obs).not.toHaveProperty('diffText');
    expect(obs).not.toHaveProperty('diff');
  });

  it('the runtime — not the source — computes the delivery diff against the baseline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));

    const rootDir = mkdtempSync(path.join(tmpdir(), 'fp-25-'));
    tempDirs.push(rootDir);
    const watchDir = mkdtempSync(path.join(tmpdir(), 'fp-25-watch-'));
    tempDirs.push(watchDir);

    const watchedFile = path.join(watchDir, 'doc.txt');
    writeFileSync(watchedFile, 'alpha\nbeta\n', 'utf-8');

    const monitorDir = path.join(rootDir, '.claude', 'monitors', 'snap-25');
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---
name: Snapshot 2.5
watch:
  type: file-fingerprint
  globs:
    - '*.txt'
  cwd: ${JSON.stringify(watchDir)}
  interval: '1s'
urgency: normal
---
When the file changes, act on it.
`,
      'utf-8',
    );
    const monitorsDir = path.join(rootDir, '.claude', 'monitors');

    const db = createDb(':memory:');
    const registry = new SourceRegistry();
    registry.register(source);
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'claude-snap-25',
        workspacePath: rootDir,
      }),
    );

    // Tick 1: stateful-source baseline. Emits nothing; the runtime has no stored
    // snapshot yet, so nothing to diff.
    await runtime.tick(monitorsDir, rootDir);

    // First change: the source emits the current snapshot. The runtime stores it
    // as the first baseline snapshot for this object. (No prior runtime snapshot
    // existed, so this first materialized event has no diff — the runtime's diff
    // baseline is its OWN snapshot store, distinct from the source's `nextState`.)
    vi.advanceTimersByTime(2_000);
    writeFileSync(watchedFile, 'alpha\nbeta v2\n', 'utf-8');
    await runtime.tick(monitorsDir, rootDir);

    // Second change: the source again emits the current whole-file snapshot; the
    // RUNTIME computes the diff against the snapshot it stored on the first
    // change — the source did not, and cannot, compute this consumer diff.
    vi.advanceTimersByTime(2_000);
    writeFileSync(watchedFile, 'alpha\nbeta v3\n', 'utf-8');
    await runtime.tick(monitorsDir, rootDir);

    const events = runtime.listEvents({ sessionId: session.id });
    expect(events).toHaveLength(2);
    // The latest event carries the runtime-produced diff, computed from the
    // runtime's own stored baseline (the v2 snapshot) against the v3 snapshot.
    const latest = events.find((e) => e.snapshotText === 'alpha\nbeta v3\n');
    expect(latest?.diffText).not.toBeNull();
    expect(latest?.diffText).toContain('v3');
    // … and the snapshot the runtime persisted is the source's current-state
    // whole, verbatim — not a delta.
    expect(latest?.snapshotText).toBe('alpha\nbeta v3\n');
  });
});
