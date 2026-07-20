/**
 * NOTE: This test is excluded from the default parallel vitest run
 * (vitest.config.ts) and runs only via vitest.serial.config.ts so that the
 * spawned daemon process is not CPU-starved by concurrent test workers.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '@agentmonitors/core';
import { openLogFd, spawnDetachedDaemon } from './detached-spawn.js';
import { daemonAvailable, callDaemon } from './daemon-ipc.js';

// TODO (Plan C): add a UAT that proves the daemon survives PARENT-PROCESS EXIT,
// not just survival of the spawn call. The in-process test below proves
// daemonAvailable() returns true while the test process is still running, but
// it does not prove the daemon keeps running after the parent exits (the real
// requirement for hook-based usage). That will be exercised by the real
// SessionEnd hook in Plan C, or by a subprocess UAT that spawns a short-lived
// "booter" process, waits for the booter to exit, then polls the socket.

describe('spawnDetachedDaemon', () => {
  it('boots a daemon that survives the spawning call and answers on the socket', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-spawn-'));
    const socket = path.join(ws, 'd.sock');
    const db = path.join(ws, 'i.db');
    try {
      spawnDetachedDaemon({
        monitorsDir: path.join(ws, '.claude', 'monitors'),
        workspacePath: ws,
        socket,
        db,
        pollMs: 1000,
      });
      // poll until the daemon answers (it was spawned detached, not awaited)
      const start = Date.now();
      let up = false;
      while (Date.now() - start < 14000) {
        if (await daemonAvailable(socket)) {
          up = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);
    } finally {
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        /* ignore */
      }
      rmSync(ws, { recursive: true, force: true });
    }
  }, 20_000);
});

// POSIX permission modes are meaningless on win32; skip the whole suite there.
describe.skipIf(process.platform === 'win32')(
  'openLogFd mode (round-4 review 3611294358)',
  () => {
    let originalUmask: number;
    let tmpDir: string;

    beforeEach(() => {
      // The whole point of this policy is to ignore the ambient umask — set an
      // explicit permissive one (the common developer/CI default) so a
      // regression that fell back to plain `mkdirSync`/`openSync` would be
      // caught rather than accidentally passing under an already-strict
      // ambient umask.
      originalUmask = process.umask(0o022);
      tmpDir = mkdtempSync(path.join(tmpdir(), 'agentmon-logfd-'));
    });

    afterEach(() => {
      process.umask(originalUmask);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Extract the permission bits (mode & 0o777) of a path via lstat. */
    function modeOf(target: string): number {
      return lstatSync(target).mode & 0o777;
    }

    it('creates a fresh log file 0600 and its missing parent dir 0700 under the default (nested) path', () => {
      const logPath = path.join(tmpDir, '.claude', 'daemon', 'daemon.log');

      const fd = openLogFd(logPath, true);
      closeSync(fd);

      expect(modeOf(logPath)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(path.dirname(logPath))).toBe(PRIVATE_DIR_MODE);
      // The intermediate ancestor `mkdirSync` created is private too — not
      // just the immediate parent.
      expect(modeOf(path.join(tmpDir, '.claude'))).toBe(PRIVATE_DIR_MODE);
    });

    it('creates a fresh log file 0600 and its missing parent dir 0700 under a custom (flat) path', () => {
      const logPath = path.join(tmpDir, 'custom.log');

      // A MISSING custom parent is still created owner-only — we are the one
      // creating it, so there is no pre-existing mode to preserve. Only a
      // pre-existing custom parent is left alone (see the next two tests).
      const fd = openLogFd(logPath, false);
      closeSync(fd);

      expect(modeOf(logPath)).toBe(PRIVATE_FILE_MODE);
      expect(modeOf(path.dirname(logPath))).toBe(PRIVATE_DIR_MODE);
    });

    it('tightens a pre-existing world-readable parent dir and log file under the default path (migration from an earlier version)', () => {
      const parent = path.join(tmpDir, 'legacy');
      const logPath = path.join(parent, 'daemon.log');
      mkdirSync(parent, { recursive: true });
      chmodSync(parent, 0o755);
      writeFileSync(logPath, 'previous run output\n');
      chmodSync(logPath, 0o644);
      expect(modeOf(parent)).toBe(0o755);
      expect(modeOf(logPath)).toBe(0o644);

      const fd = openLogFd(logPath, true);
      closeSync(fd);

      expect(modeOf(parent)).toBe(PRIVATE_DIR_MODE);
      expect(modeOf(logPath)).toBe(PRIVATE_FILE_MODE);
      // Tightening is a chmod, not a rewrite — the daemon's earlier output
      // must survive the mode migration.
      expect(readFileSync(logPath, 'utf-8')).toBe('previous run output\n');
    });

    it('leaves a pre-existing custom --log parent mode untouched, while still tightening the log file (round-5 review 3611604829)', () => {
      // A custom `--log` parent is not necessarily Agent-Monitors-owned — it
      // could be a repo checkout or a shared logs directory a collaborator
      // also needs group access to. Reproduces the exact regression: a 0755
      // workspace root must NOT become 0700 just because `--log` points a
      // file inside it.
      const parent = path.join(tmpDir, 'workspace-root');
      const logPath = path.join(parent, 'daemon.log');
      mkdirSync(parent, { recursive: true });
      chmodSync(parent, 0o755);
      writeFileSync(logPath, 'previous run output\n');
      chmodSync(logPath, 0o644);
      expect(modeOf(parent)).toBe(0o755);

      const fd = openLogFd(logPath, false);
      closeSync(fd);

      // The custom parent's mode is completely unchanged...
      expect(modeOf(parent)).toBe(0o755);
      // ...but the log FILE itself is still secured and its prior content
      // preserved, exactly as the default-location case above.
      expect(modeOf(logPath)).toBe(PRIVATE_FILE_MODE);
      expect(readFileSync(logPath, 'utf-8')).toBe('previous run output\n');
    });

    it('appends rather than truncating a pre-existing log across repeated detached boots', () => {
      const logPath = path.join(tmpDir, 'daemon.log');

      const first = openLogFd(logPath, true);
      writeFileSync(first, 'first boot\n');
      closeSync(first);

      const second = openLogFd(logPath, true);
      writeFileSync(second, 'second boot\n');
      closeSync(second);

      expect(readFileSync(logPath, 'utf-8')).toBe('first boot\nsecond boot\n');
      expect(modeOf(logPath)).toBe(PRIVATE_FILE_MODE);
    });

    it('refuses a symlink pointing at a not-yet-existing target, creating nothing (dangling link)', () => {
      // The nastier variant of the same vector: with a DANGLING link the old
      // `openSync(logPath, 'a')` would CREATE the target through the link,
      // planting a new file wherever it pointed rather than merely appending
      // to an existing one. O_NOFOLLOW must refuse before anything is made.
      const target = path.join(tmpDir, 'not-yet-there.txt');
      const logPath = path.join(tmpDir, 'dangling-daemon.log');
      symlinkSync(target, logPath);

      expect(() => openLogFd(logPath, false)).toThrow(/symlink/i);

      expect(existsSync(target)).toBe(false);
    });

    it('still opens and secures an ordinary regular file (O_NOFOLLOW does not break the normal path)', () => {
      // Positive counterpart to the refusals: the symlink guard must not
      // regress the case every real run takes.
      const logPath = path.join(tmpDir, 'regular.log');
      writeFileSync(logPath, 'existing\n');
      chmodSync(logPath, 0o666);

      const fd = openLogFd(logPath, false);
      writeFileSync(fd, 'appended\n');
      closeSync(fd);

      expect(modeOf(logPath)).toBe(PRIVATE_FILE_MODE);
      expect(readFileSync(logPath, 'utf-8')).toBe('existing\nappended\n');
    });

    it('refuses to append through a symlinked log path under the default location, and leaves the target untouched (round-6 review 3611641504)', () => {
      // Reproduces the regression: `restrictExistingPathMode` correctly
      // no-ops on a symlink, but the old plain `openSync(logPath, 'a')`
      // still followed it, appending daemon output into whatever the link
      // pointed at without ever touching that target's mode.
      const target = path.join(tmpDir, 'target.log');
      writeFileSync(target, 'not the daemon log\n');
      chmodSync(target, 0o644);
      const logPath = path.join(tmpDir, 'daemon.log');
      symlinkSync(target, logPath);

      expect(() => openLogFd(logPath, true)).toThrow(/symlink/i);

      // The symlink target must be neither written to nor have its mode
      // changed — the identity check must fail closed before either
      // side effect.
      expect(readFileSync(target, 'utf-8')).toBe('not the daemon log\n');
      expect(modeOf(target)).toBe(0o644);
    });

    it('refuses to append through a symlinked log path under a custom --log parent (round-6 review 3611641504)', () => {
      const parent = path.join(tmpDir, 'custom-parent');
      mkdirSync(parent, { recursive: true });
      const target = path.join(tmpDir, 'target.log');
      writeFileSync(target, 'not the daemon log\n');
      chmodSync(target, 0o644);
      const logPath = path.join(parent, 'daemon.log');
      symlinkSync(target, logPath);

      expect(() => openLogFd(logPath, false)).toThrow(/symlink/i);

      expect(readFileSync(target, 'utf-8')).toBe('not the daemon log\n');
      expect(modeOf(target)).toBe(0o644);
    });
  },
);
