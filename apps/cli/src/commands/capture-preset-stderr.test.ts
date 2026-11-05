/** Prove capture is a byte-bounded tail on disk before the parent reads it. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it.each([0, 4096, 4097, 8 * 1024 * 1024])(
  'retains the exact tail and total byte count for %i bytes',
  (size) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'preset-tail-'));
    try {
      const stderr = path.join(dir, 'stderr');
      const total = path.join(dir, 'total');
      const input = Buffer.alloc(size, 'x');
      if (size > 4096) input.write('PRIVATE_TAIL_SENTINEL', size - 32);
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, 'fixtures/capture-preset-stderr.ts'),
          stderr,
          total,
        ],
        { input, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(statSync(stderr).size).toBe(Math.min(size, 4096));
      expect(readFileSync(stderr)).toEqual(
        input.subarray(-Math.min(size, 4096)),
      );
      expect(readFileSync(total, 'utf8')).toBe(String(size));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
