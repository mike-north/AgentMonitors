/** Prove capture is a byte-bounded tail on disk before the parent reads it. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { probePresetFifo } from './fixtures/probe-preset-fifo.js';
import { PRESET_CAPTURE_COMMAND } from './fixtures/preset-capture-command.js';

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

it('finishes the actual FIFO reader after writer EOF while the command stays alive', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'preset-fifo-'));
  try {
    const result = await probePresetFifo(dir, PRESET_CAPTURE_COMMAND);
    expect(result.writtenBytes).toBe(4097);
    expect(result.totalBytes).toBe(4097);
    expect(result.tailBytes).toBe(4096);
    expect(result.completedWhileCommandAlive).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
