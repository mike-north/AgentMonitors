import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ensurePrivateDir,
  PRIVATE_DIR_MODE,
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
  /**
   * Whether {@link logPath} is Agent Monitors' own default location (the
   * workspace data dir), as opposed to a user-supplied `--log <path>`.
   *
   * A missing parent directory is created owner-only (`0700`) either way — we
   * are the one creating it, so there is no pre-existing mode to preserve.
   * What this flag actually gates is a pre-existing parent: the default
   * parent is Agent-Monitors-owned, so it is tightened (via
   * {@link ensurePrivateDir}) if it already exists looser. A custom `--log`
   * path may point into a directory the user owns for their own reasons (a
   * repo checkout, a shared logs directory), so a pre-existing custom parent
   * is left exactly as it is — the same treatment `ensureSocketDir` already
   * gives a user-chosen `--socket` directory. See {@link openLogFd}.
   *
   * Defaults to `false` (treat as a custom path) when {@link logPath} is set
   * without this flag, so a caller that forgets to pass it gets the safer,
   * non-tightening behavior rather than silently chmod-ing a directory it
   * does not own.
   */
  logPathIsDefault?: boolean;
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
    options.logPath === undefined
      ? undefined
      : openLogFd(options.logPath, options.logPathIsDefault ?? false);
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
 * birth. The log FILE is always secured this way — tightened if it already
 * exists, created `0600` if it does not — regardless of whether `logPath` is
 * the default location or a custom `--log` path: it is ours either way, and we
 * are about to append the daemon's diagnostics to it.
 *
 * The PARENT directory gets different treatment depending on `isDefaultLocation`
 * (round-5 review 3611604829) — mirroring `ensureSocketDir`'s existing split
 * between the Agent-Monitors-owned default socket directory and a
 * user-chosen `--socket` one:
 *
 * - A MISSING parent (any missing ancestor) is always created owner-only
 *   (`0700`) either way — we are the one creating it, so there is no
 *   pre-existing mode to preserve, default location or not.
 * - An EXISTING parent is only tightened when `isDefaultLocation` is true
 *   (the Agent-Monitors-owned workspace data dir). A pre-existing CUSTOM
 *   `--log` parent — possibly a directory the user owns for their own
 *   reasons, e.g. a repo checkout or a shared logs directory — is left
 *   exactly as it is; silently removing its group/other access would be a
 *   functional regression, not a hardening.
 *
 * Exported (this package has no api-extractor rollup) purely so its mode
 * regression tests can call it directly instead of round-tripping through a
 * real detached daemon spawn (round-4 review 3611294358).
 */
export function openLogFd(logPath: string, isDefaultLocation: boolean): number {
  const parent = path.dirname(logPath);
  if (isDefaultLocation) {
    // Creates a missing parent 0700 AND tightens an existing looser one.
    ensurePrivateDir(parent);
  } else {
    // `mkdirSync({ recursive: true })` is a no-op — and critically does NOT
    // chmod — when `parent` already exists, so a pre-existing custom parent's
    // mode is left completely untouched. A MISSING one is still created
    // owner-only: we are its creator either way.
    mkdirSync(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  restrictExistingPathMode(logPath, PRIVATE_FILE_MODE);
  return openSync(logPath, 'a', PRIVATE_FILE_MODE);
}
