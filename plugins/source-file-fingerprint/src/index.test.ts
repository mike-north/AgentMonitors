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

    const result = await source.observe({ globs: ['*.txt'], cwd: dir });
    expect(result).toHaveLength(0);
  });

  it('detects file changes on subsequent runs', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'a.txt');
    writeFileSync(filePath, 'hello');

    await source.observe({ globs: ['*.txt'], cwd: dir });

    writeFileSync(filePath, 'world');
    const result = await source.observe({ globs: ['*.txt'], cwd: dir });

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toContain('a.txt');
    const snap = result[0]?.snapshot as {
      previousHash: string;
      currentHash: string;
    };
    expect(snap.previousHash).not.toBe(snap.currentHash);
  });

  it('returns no observations when files have not changed', async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'stable.txt'), 'same content');

    await source.observe({ globs: ['*.txt'], cwd: dir });
    const result = await source.observe({ globs: ['*.txt'], cwd: dir });

    expect(result).toHaveLength(0);
  });

  it('throws on missing globs config', async () => {
    await expect(source.observe({})).rejects.toThrow('globs');
  });

  describe('cache isolation', () => {
    it('different configs watching the same file maintain separate baselines', async () => {
      const dir = makeTempDir();
      const filePath = path.join(dir, 'shared.txt');
      writeFileSync(filePath, 'initial');

      const config1 = { globs: ['*.txt'], cwd: dir };
      const config2 = { globs: ['shared.*'], cwd: dir };

      // Baseline for config1
      await source.observe(config1);

      // Modify the file
      writeFileSync(filePath, 'modified');

      // Config2's first poll should be baseline (no observation), not
      // inherit config1's fingerprint and falsely report a change
      const result = await source.observe(config2);
      expect(result).toHaveLength(0);

      // Config1 should detect the change since it has a previous baseline
      const result1 = await source.observe(config1);
      expect(result1).toHaveLength(1);
    });
  });
});
