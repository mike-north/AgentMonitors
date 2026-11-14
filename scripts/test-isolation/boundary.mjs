import { setImmediate } from 'node:timers';
/**
 * Filesystem ownership shared by Vitest coordinators and standalone test
 * scripts. Guard failures are observable even on an early process.exit();
 * cleanup never removes or repairs any path belonging to the installation.
 * Runtime access assertions come from the adapter; its shared endpoint observer
 * reports differences without attributing them to tests or failing the run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertAttributedPathsUnchanged,
  inspectOpenFiles,
} from './attribution.mjs';
import {
  installSocketNamespace,
  assertNoRuntimeAccess,
} from './socket-namespace.mjs';
import { initializeNamespaceScope } from './namespace-scope.mjs';
import { observeRuntimeNamespace } from './runtime-namespace.mjs';
import { isRuntimePath } from './runtime-paths.mjs';
import {
  applyEnvironment,
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
  const runtime = observeRuntimeNamespace();
  const roots = realUserPaths(process.env).filter(
    (root) => !isRuntimePath(root, runtime.namespaces),
  );
  const startedAt = Date.now();
  const first = inspectOpenFiles();
  const before = snapshotPaths(roots);
  // Operators can restrict all coordinator/fixture writes to one owned temp tree.
  // Keep the short POSIX default for ordinary macOS Unix-socket paths.
  const root = mkdtempSync(
    path.join(
      process.env.AGENTMONITORS_TEST_TEMP_ROOT ??
        (process.platform === 'win32' ? tmpdir() : '/tmp'),
      'am-',
    ),
  );
  initializeNamespaceScope(root);
  let finished = false;
  /** Check once and release the owned tree even when the check throws. */
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    process.removeListener('exit', onExit);
    try {
      assertNoRuntimeAccess(root);
      const after = snapshotPaths(roots);
      assertAttributedPathsUnchanged(
        before,
        after,
        first,
        inspectOpenFiles(),
        startedAt,
      );
      runtime.finish();
    } finally {
      runtime.close();
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
    await new Promise(setImmediate);
    await run();
  } finally {
    try {
      await new Promise(setImmediate);
      boundary.finish();
    } finally {
      applyEnvironment(inherited);
    }
  }
}
