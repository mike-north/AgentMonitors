/**
 * Degrade-gracefully tests for the local-permission helpers (issue #292 review).
 *
 * Tightening the mode of an artifact we do not own must **not** throw — it warns
 * once per path per process and continues, so a daemon asked to write into a
 * shared, group-writable directory (e.g. `session open --hook-state-path` into a
 * dir owned by another uid) keeps running rather than dying inside its socket
 * data handler.
 *
 * There is no portable way for a single-uid test to own a file and yet be denied
 * a `chmod` on it, so we simulate the denial by mocking only the final chmod
 * syscalls (`fchmodSync`/`chmodSync`) to throw `EPERM`. The real `lstat`/`open`
 * preamble still runs, so the symlink-safe path is exercised exactly as in
 * production.
 *
 * @see https://man7.org/linux/man-pages/man2/fchmod.2.html (EPERM: not owner)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function denyChmod(): never {
  throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
}

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    fchmodSync: vi.fn(denyChmod),
    chmodSync: vi.fn(denyChmod),
  };
});

// Imported after the mock is registered (vitest hoists `vi.mock`), so the module
// under test binds to the mocked `fchmodSync`/`chmodSync`; every other fs call
// (lstat/open/writeFile/mkdir/rename) passes through to the real implementation.
const { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } =
  await import('node:fs');
const { tmpdir } = await import('node:os');
const path = (await import('node:path')).default;
const {
  PRIVATE_FILE_MODE,
  resetVerifiedPathCachesForTest,
  restrictExistingPathMode,
  writePrivateFileAtomic,
} = await import('./local-permissions.js');

const isWindows = process.platform === 'win32';

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

describe.skipIf(isWindows)(
  'local-permissions degrade-gracefully (issue #292)',
  () => {
    let tmpDir: string;
    let originalUmask: number;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      originalUmask = process.umask(0o022);
      tmpDir = mkdtempSync(path.join(tmpdir(), 'am-degrade-'));
      // Fresh per-process caches so the "warn once" dedup and the verified-dir
      // cache start empty for each case.
      resetVerifiedPathCachesForTest();
      stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
      process.umask(originalUmask);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not throw and leaves the mode unchanged when the chmod is denied (EPERM)', () => {
      const file = path.join(tmpDir, 'not-ours');
      writeFileSync(file, 'x', { mode: 0o644 });
      expect(modeOf(file)).toBe(0o644);

      expect(() =>
        restrictExistingPathMode(file, PRIVATE_FILE_MODE),
      ).not.toThrow();

      // The fchmod was denied, so the mode is left as-is (best-effort).
      expect(modeOf(file)).toBe(0o644);
      // One structured warning naming the path and the errno code.
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [message] = stderrSpy.mock.calls[0] as [string];
      expect(message).toContain(file);
      expect(message).toContain('EPERM');
    });

    it('warns only once per path per process', () => {
      const file = path.join(tmpDir, 'repeat');
      writeFileSync(file, 'x', { mode: 0o644 });

      restrictExistingPathMode(file, PRIVATE_FILE_MODE);
      restrictExistingPathMode(file, PRIVATE_FILE_MODE);
      restrictExistingPathMode(file, PRIVATE_FILE_MODE);

      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it('still writes the file atomically even when tightening is denied', () => {
      const file = path.join(tmpDir, 'sessions', 's1', 'hook-state.json');

      // The whole write must succeed (contents land on disk) even though the dir
      // and file chmods are denied — a daemon must not crash writing hook state
      // into a directory it cannot chmod.
      expect(() => writePrivateFileAtomic(file, '{"ok":true}')).not.toThrow();
      expect(readFileSync(file, 'utf-8')).toBe('{"ok":true}');
      // Denied chmods warned (dir + temp file), but the write completed.
      expect(stderrSpy).toHaveBeenCalled();
    });
  },
);
