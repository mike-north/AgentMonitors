/**
 * A file observation and its checkpoint must describe the same sampled bytes
 * (003 §3.2). Controlled read completion exposes truncate/write and atomic-save
 * races without depending on filesystem notification timing or sleeps.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import source from './index.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];
afterEach(() => {
  vi.mocked(readFile).mockClear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

/** A real baseline lets every refusal prove that the old checkpoint remains usable. */
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'am-file-read-'));
  roots.push(root);
  const file = path.join(root, 'watched.txt');
  const config = { globs: ['watched.txt'], cwd: root };
  writeFileSync(file, 'one');
  const baseline = await source.observe(config, { now: new Date() });
  const context = { now: new Date(), previousState: baseline.nextState };
  return { root, file, config, context };
}

for (const transition of ['truncate/write', 'atomic replacement'] as const) {
  it(`refuses a file changed during its read: ${transition}`, async () => {
    const f = await fixture();
    writeFileSync(f.file, '');
    vi.mocked(readFile).mockImplementationOnce(async () => {
      // Return the sampled empty bytes only after completing the concurrent
      // writer. The original double read hashes '' and snapshots 'two'.
      if (transition === 'atomic replacement') {
        const temporary = path.join(f.root, 'replacement');
        writeFileSync(temporary, 'two');
        renameSync(temporary, f.file);
      } else {
        writeFileSync(f.file, 'two');
      }
      return Buffer.from('');
    });
    await expect(source.observe(f.config, f.context)).rejects.toThrow(
      'File changed while reading',
    );
    const recovered = await source.observe(f.config, f.context);
    expect(recovered.observations.map((o) => o.snapshotText)).toEqual(['two']);
    const hash = createHash('sha256').update('two').digest('hex');
    expect(recovered.nextState).toEqual({ fingerprints: { [f.file]: hash } });
    expect(recovered.observations[0]?.snapshot).toMatchObject({
      currentHash: hash,
    });
    const repeated = await source.observe(f.config, {
      now: new Date(),
      previousState: recovered.nextState,
    });
    expect(repeated.observations).toEqual([]);
  });
}

it('samples changed contents once for both snapshot and checkpoint', async () => {
  const f = await fixture();
  writeFileSync(f.file, 'two');
  vi.mocked(readFile).mockClear();
  const batch = await source.observe(f.config, f.context);
  expect(batch.observations.map((o) => o.snapshotText)).toEqual(['two']);
  expect(readFile).toHaveBeenCalledTimes(1);
});

it('preserves a stable empty file as a legitimate change, without repeating it', async () => {
  const f = await fixture();
  writeFileSync(f.file, '');
  const batch = await source.observe(f.config, f.context);
  expect(batch.observations.map((o) => o.snapshotText)).toEqual(['']);
  const repeated = await source.observe(f.config, {
    now: new Date(),
    previousState: batch.nextState,
  });
  expect(repeated.observations).toEqual([]);
});
