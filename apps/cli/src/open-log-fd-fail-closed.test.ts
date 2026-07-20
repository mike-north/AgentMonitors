/**
 * Regression coverage for `openLogFd`'s fail-closed policy when the final
 * descriptor `fchmod` cannot secure the `--detach` log to owner-only
 * (spec 002 §3.1; round-7 PR #450 review 3611731176).
 *
 * This lives in its own file — deliberately NOT one of the daemon-spawn
 * files that run serially via `vitest.serial.config.ts` (which shares one
 * module registry across its files, `isolate: false`, for daemon-process CPU
 * fairness). A `vi.mock('node:fs')` only intercepts modules that resolve
 * `node:fs` *after* the mock is registered; under that shared registry, an
 * earlier daemon-spawn file that already imported `@agentmonitors/core`
 * (which itself imports `node:fs`) would keep the real, unmocked binding for
 * the rest of the run regardless of `vitest.serial.config.ts`'s file-list
 * order (confirmed: array order there is not the execution order). This
 * file runs under the default, per-file-isolated parallel suite instead —
 * it does no daemon I/O, so it needs no serial treatment — giving its mock
 * a guaranteed-fresh module registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// `fchmodSync` cannot be forced to fail via a real EPERM/EACCES in this
// environment (we own every file we create in CI and in local sandboxes), so
// this mocks just enough of `node:fs` to force exactly one `fchmodSync` call
// to throw, while every other call goes through the real implementation.
const { fchmodSyncMock, closeSyncMock } = vi.hoisted(() => ({
  fchmodSyncMock: vi.fn(),
  closeSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fchmodSyncMock.mockImplementation(actual.fchmodSync);
  closeSyncMock.mockImplementation(actual.closeSync);
  return { ...actual, fchmodSync: fchmodSyncMock, closeSync: closeSyncMock };
});

const { openLogFd } = await import('./detached-spawn.js');

// POSIX permission modes (and this fail-closed policy) are meaningless on
// win32; the whole suite is skipped there, matching detached-spawn.test.ts.
describe.skipIf(process.platform === 'win32')(
  'openLogFd fail-closed fchmod (round-7 review 3611731176)',
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'agentmon-logfd-failclosed-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      fchmodSyncMock.mockClear();
      closeSyncMock.mockClear();
    });

    it('fails closed and closes the descriptor when the log cannot be made owner-only, instead of warning and continuing', () => {
      // Leave `logPath` MISSING so `restrictExistingPathMode`'s own
      // (unrelated, best-effort, warn-and-continue) pre-open tightening
      // no-ops — it only acts on an existing path — and the queued throw is
      // consumed by exactly the fd-based `fchmodSync` that `openLogFd`
      // itself performs after `open()`, not by that earlier call.
      const logPath = path.join(tmpDir, 'unsecurable.log');
      const eperm = Object.assign(
        new Error('EPERM: operation not permitted, fchmod'),
        { code: 'EPERM' },
      );
      fchmodSyncMock.mockImplementationOnce(() => {
        throw eperm;
      });

      expect(() => openLogFd(logPath, false)).toThrow(
        /could not be made owner-only.*EPERM/is,
      );

      // Consumed by exactly the one fd-based fchmod `openLogFd` performs —
      // confirming the throw came from the intended call, not a leftover
      // real failure or a call this test didn't account for.
      expect(fchmodSyncMock).toHaveBeenCalledTimes(1);
      // The opened descriptor must not leak: `closeSync` is called exactly
      // once (by the catch branch) before the error propagates — this is
      // the fd-leak half of the original round-7 finding.
      expect(closeSyncMock).toHaveBeenCalledTimes(1);
    });
  },
);
