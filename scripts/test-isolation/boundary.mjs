/**
 * Filesystem ownership shared by Vitest coordinators and standalone test
 * scripts. Guard failures are observable even on an early process.exit();
 * cleanup never removes or repairs any path belonging to the installation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installSocketNamespace } from './socket-namespace.mjs';
import {
  applyEnvironment,
  assertPathsUnchanged,
  createEnvironmentDirectories,
  isolatedEnvironment,
  realUserPaths,
  snapshotPaths,
} from './paths.mjs';

/**
 * Capture the actual host context before any path override. The short /tmp
 * spelling is an OS temp directory on POSIX and keeps default workspace sockets
 * below AF_UNIX limits on macOS, unlike its deep os.tmpdir() spelling.
 * @returns {{root: string, finish: () => void}} @internal
 */
export function createTestBoundary() {
  const roots = realUserPaths(process.env);
  const before = snapshotPaths(roots);
  const root = mkdtempSync(
    path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'am-'),
  );
  let finished = false;
  /** Check once and release the owned tree even when the check throws. */
  const finish = () => {
    if (finished) return;
    finished = true;
    process.removeListener('exit', onExit);
    try {
      assertPathsUnchanged(before, snapshotPaths(roots));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  /** Exit hooks cannot throw safely, but must turn a false success into failure. */
  const onExit = () => {
    try {
      finish();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once('exit', onExit);
  return { root, finish };
}

/**
 * Standalone packaging/install checks receive the same boundary as Vitest.
 * Importing a check's definitions has no environmental side effect: invoke
 * this only at its direct-entrypoint branch, before its main creates fixtures.
 * @param {() => Promise<void>} run @internal
 */
export async function withIsolatedTestEnvironment(run) {
  const boundary = createTestBoundary();
  const env = isolatedEnvironment(boundary.root);
  const inherited = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  createEnvironmentDirectories(env);
  applyEnvironment(env);
  installSocketNamespace();
  try {
    await run();
  } finally {
    try {
      boundary.finish();
    } finally {
      applyEnvironment(inherited);
    }
  }
}
