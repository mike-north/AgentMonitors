import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import source from './index.js';

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
