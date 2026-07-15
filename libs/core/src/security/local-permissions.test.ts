/**
 * Tests for the local-data permission model (issue #292).
 *
 * The whole point of these helpers is to force owner-only modes regardless of
 * the ambient umask, so every test runs under an explicit permissive umask
 * (`0o022`, the common developer/CI default) — without it, an already-restrictive
 * ambient umask could make the assertions pass trivially.
 *
 * @see https://man7.org/linux/man-pages/man2/open.2.html (O_NOFOLLOW)
 * @see https://man7.org/linux/man-pages/man2/umask.2.html
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensurePrivateDir,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  restrictExistingPathMode,
  withRestrictedUmask,
  writePrivateFileAtomic,
} from './local-permissions.js';

const isWindows = process.platform === 'win32';

/** Extract the permission bits (mode & 0o777) of a path via lstat. */
function modeOf(target: string): number {
  return lstatSync(target).mode & 0o777;
}

// POSIX permission modes are meaningless on win32; skip the whole suite there.
describe.skipIf(isWindows)('local-permissions', () => {
  let tmpDir: string;
  let originalUmask: number;

  beforeEach(() => {
    // Set an explicit permissive umask so a raw mkdir/writeFile would otherwise
    // produce world-readable 0755/0644 artifacts. Capture the previous value.
    originalUmask = process.umask(0o022);
    tmpDir = mkdtempSync(path.join(tmpdir(), 'am-perms-'));
  });

  afterEach(() => {
    process.umask(originalUmask);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ensurePrivateDir', () => {
    it('creates a new directory (and ancestors) owner-only under a permissive umask', () => {
      const dir = path.join(tmpDir, 'data', 'workspace');
      ensurePrivateDir(dir);
      expect(modeOf(dir)).toBe(PRIVATE_DIR_MODE);
      // The ancestor it created is private too.
      expect(modeOf(path.join(tmpDir, 'data'))).toBe(PRIVATE_DIR_MODE);
    });

    it('tightens an existing world-readable directory (migration on startup)', () => {
      const dir = path.join(tmpDir, 'legacy');
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      expect(modeOf(dir)).toBe(0o755);

      ensurePrivateDir(dir);
      expect(modeOf(dir)).toBe(PRIVATE_DIR_MODE);
    });

    it('is idempotent', () => {
      const dir = path.join(tmpDir, 'idem');
      ensurePrivateDir(dir);
      ensurePrivateDir(dir);
      expect(modeOf(dir)).toBe(PRIVATE_DIR_MODE);
    });
  });

  describe('restrictExistingPathMode', () => {
    it('tightens an existing world-readable file to owner-only', () => {
      const file = path.join(tmpDir, 'db');
      writeFileSync(file, 'x');
      chmodSync(file, 0o644);
      expect(modeOf(file)).toBe(0o644);

      restrictExistingPathMode(file, PRIVATE_FILE_MODE);
      expect(modeOf(file)).toBe(PRIVATE_FILE_MODE);
    });

    it('does not throw for a missing path', () => {
      expect(() =>
        restrictExistingPathMode(
          path.join(tmpDir, 'nope', 'missing'),
          PRIVATE_FILE_MODE,
        ),
      ).not.toThrow();
    });

    it('refuses to chmod through a symlink (does not follow attacker-controlled links)', () => {
      // The classic symlink attack: a hostile user plants a symlink where we
      // expect our own file, hoping our chmod widens/narrows a file we do not
      // own. We must neither follow nor "fix" the link.
      const target = path.join(tmpDir, 'target');
      writeFileSync(target, 'secret');
      chmodSync(target, 0o644);

      const link = path.join(tmpDir, 'link');
      symlinkSync(target, link);

      restrictExistingPathMode(link, PRIVATE_FILE_MODE);

      // The link's target must be untouched...
      expect(statSync(target).mode & 0o777).toBe(0o644);
      // ...and the symlink itself is not turned into anything else.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });
  });

  describe('writePrivateFileAtomic', () => {
    it('writes the file owner-only inside an owner-only directory', () => {
      const file = path.join(tmpDir, 'sessions', 's1', 'hook-state.json');
      writePrivateFileAtomic(file, '{"ok":true}');

      expect(readFileSync(file, 'utf-8')).toBe('{"ok":true}');
      expect(modeOf(file)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(path.dirname(file))).toBe(PRIVATE_DIR_MODE);
      // No temp file left behind.
      expect(() => statSync(`${file}.tmp`)).toThrow();
    });

    it('re-tightens the file when overwriting an existing looser one', () => {
      const file = path.join(tmpDir, 'state.json');
      writePrivateFileAtomic(file, 'a');
      chmodSync(file, 0o644);

      writePrivateFileAtomic(file, 'b');
      expect(readFileSync(file, 'utf-8')).toBe('b');
      expect(modeOf(file)).toBe(PRIVATE_FILE_MODE);
    });
  });

  describe('withRestrictedUmask', () => {
    it('restores the previous umask afterward', () => {
      const before = process.umask(0o022);
      process.umask(before);

      withRestrictedUmask(() => {
        // Inside the callback the umask is restrictive (0o077).
        const inside = process.umask(0o077);
        expect(inside).toBe(0o077);
        process.umask(0o077);
      });

      const after = process.umask(0o022);
      expect(after).toBe(0o022);
    });

    it('restores the previous umask even if the callback throws', () => {
      expect(() =>
        withRestrictedUmask(() => {
          throw new Error('boom');
        }),
      ).toThrow('boom');

      const after = process.umask(0o022);
      expect(after).toBe(0o022);
    });

    it('returns the callback result', () => {
      expect(withRestrictedUmask(() => 42)).toBe(42);
    });
  });
});
