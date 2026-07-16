import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface SpawnDaemonOptions {
  monitorsDir: string;
  workspacePath: string;
  socket: string;
  db: string;
  pollMs?: number;
  reapAfterMs?: number;
}

/**
 * Absolute path to this CLI's built entrypoint (the bin).
 *
 * At runtime (in the bundled dist/index.cjs), this file IS dist/index.cjs —
 * so `__filename` directly gives the path. We derive it from `import.meta.url`
 * which tsup shims to `__filename` in the CJS bundle.
 *
 * During tests (vitest runs TypeScript source), import.meta.url points to the
 * source file at `src/detached-spawn.ts`, so we walk up one directory from
 * `src/` to reach the package root and then into `dist/index.cjs`.
 */
export function cliEntry(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // Distinguish bundled context (file is in dist/) from source context (in src/)
  const isBundle = path.basename(path.dirname(thisFile)) === 'dist';
  if (isBundle) {
    // thisFile IS dist/index.cjs (everything is bundled into one file)
    return thisFile;
  }
  // Source context (vitest): src/detached-spawn.ts → go up to package root
  const packageRoot = path.resolve(path.dirname(thisFile), '..');
  return path.join(packageRoot, 'dist', 'index.cjs');
}

/**
 * Spawn `agentmonitors daemon run` as a DETACHED background process so it
 * outlives the short-lived hook that booted it. stdio is fully ignored and the
 * child is unref'd so the parent can exit immediately.
 */
export function spawnDetachedDaemon(options: SpawnDaemonOptions): void {
  const args = [
    cliEntry(),
    'daemon',
    'run',
    options.monitorsDir,
    '--workspace',
    options.workspacePath,
    '--socket',
    options.socket,
    '--poll-ms',
    String(options.pollMs ?? 30000),
  ];

  if (options.reapAfterMs !== undefined) {
    args.push('--reap-after-ms', String(options.reapAfterMs));
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENTMONITORS_DB: options.db,
      AGENTMONITORS_SOCKET: options.socket,
    },
  });
  // Attach the error listener BEFORE unref so that an async OS-level spawn
  // failure (e.g. ENOENT, EACCES) surfaces to stderr rather than being swallowed.
  child.on('error', (e) => {
    console.error(`Failed to spawn daemon: ${e.message}`);
  });
  child.unref();
}
