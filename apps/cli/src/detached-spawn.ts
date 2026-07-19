import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface SpawnDaemonOptions {
  monitorsDir: string;
  workspacePath: string;
  socket: string;
  db: string;
  pollMs?: number;
  reapAfterMs?: number;
  /**
   * Append the detached daemon's stdout+stderr to this file instead of
   * discarding them (issue #389 P1). Hook-driven boots leave this unset — the
   * daemon's log is noise there — but a user who ran `daemon run --detach`
   * explicitly asked for a background daemon and needs somewhere to look when
   * it misbehaves. The file (and its parent directory) is created if missing.
   */
  logPath?: string;
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
 * outlives the short-lived hook (or foreground command) that booted it. stdio
 * is discarded — or appended to {@link SpawnDaemonOptions.logPath} — and the
 * child is unref'd so the parent can exit immediately.
 *
 * Returns the child's pid, or `undefined` when the OS never assigned one
 * (a spawn that failed asynchronously; the `error` listener below reports it).
 */
export function spawnDetachedDaemon(
  options: SpawnDaemonOptions,
): number | undefined {
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

  // Open the log in APPEND mode so repeated detached boots for one workspace
  // accumulate rather than truncating the previous run's crash output.
  const logFd =
    options.logPath === undefined ? undefined : openLogFd(options.logPath);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio:
        logFd === undefined ? 'ignore' : ['ignore', logFd, logFd, 'ignore'],
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
    return child.pid;
  } finally {
    // The child holds its own duplicated descriptor; the parent's copy must be
    // released or a short-lived parent would leak it for its remaining life.
    if (logFd !== undefined) closeSync(logFd);
  }
}

function openLogFd(logPath: string): number {
  mkdirSync(path.dirname(logPath), { recursive: true });
  return openSync(logPath, 'a');
}
