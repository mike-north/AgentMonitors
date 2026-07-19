import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ensurePrivateDir,
  PRIVATE_FILE_MODE,
  restrictExistingPathMode,
} from '@agentmonitors/core';

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

export interface SpawnedDaemon {
  /**
   * The child's pid, or `undefined` when the OS never assigned one (a spawn
   * that failed synchronously — vanishingly rare; the async `error` case
   * below is the common failure mode and is reported via {@link spawnError}
   * instead).
   */
  pid: number | undefined;
  /**
   * Resolves with the spawn error if the child's `error` event fires (e.g.
   * `ENOENT`/`EACCES` — the OS never actually started the process), or never
   * settles if the child spawns successfully. Lets a caller waiting for the
   * daemon to answer on its socket (issue #389 review finding 2) race this
   * against that wait to fail fast and report the REAL cause, rather than
   * waiting out the full readiness timeout and pointing at a log file the
   * daemon never got a chance to write.
   */
  spawnError: Promise<Error>;
}

/**
 * Spawn `agentmonitors daemon run` as a DETACHED background process so it
 * outlives the short-lived hook (or foreground command) that booted it. stdio
 * is discarded — or appended to {@link SpawnDaemonOptions.logPath} — and the
 * child is unref'd so the parent can exit immediately.
 */
export function spawnDetachedDaemon(
  options: SpawnDaemonOptions,
): SpawnedDaemon {
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
    // failure (e.g. ENOENT, EACCES) surfaces to stderr rather than being
    // swallowed — AND so a caller can await `spawnError` to react to it (issue
    // #389 review finding 2), instead of only ever seeing it as an unrelated
    // console line.
    const spawnError = new Promise<Error>((resolve) => {
      child.on('error', (e) => {
        console.error(`Failed to spawn daemon: ${e.message}`);
        resolve(e);
      });
    });
    child.unref();
    return { pid: child.pid, spawnError };
  } finally {
    // The child holds its own duplicated descriptor; the parent's copy must be
    // released or a short-lived parent would leak it for its remaining life.
    if (logFd !== undefined) closeSync(logFd);
  }
}

/**
 * Open the detached daemon's log for appending under Agent Monitors' owner-only
 * runtime-data policy (002 §3.1), NOT the ambient umask.
 *
 * The log captures the daemon's stdout/stderr — workspace paths, socket paths,
 * and monitor failure messages — so under a common `umask 022` a plain
 * `openSync(path, 'a')` would create it `0644` and leave it readable by every
 * other local user. `PRIVATE_FILE_MODE` has no group/other bits, so a
 * permissive umask has nothing to strip and the file comes out owner-only from
 * birth.
 *
 * The parent directory is created (or tightened, if it already exists looser)
 * via {@link ensurePrivateDir} — the same AgentMon-owned-location helper every
 * other runtime-data directory uses (session dirs, the socket directory), so
 * this creation site can't drift from that policy. The log file itself IS
 * tightened when it already exists — it is ours, we are about to append the
 * daemon's diagnostics to it, and a looser file left by an earlier version (or
 * by a run before this policy existed) must not stay world-readable.
 *
 * Exported (this package has no api-extractor rollup) purely so its mode
 * regression tests can call it directly instead of round-tripping through a
 * real detached daemon spawn (round-4 review 3611294358).
 */
export function openLogFd(logPath: string): number {
  ensurePrivateDir(path.dirname(logPath));
  restrictExistingPathMode(logPath, PRIVATE_FILE_MODE);
  return openSync(logPath, 'a', PRIVATE_FILE_MODE);
}
