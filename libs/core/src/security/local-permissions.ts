/**
 * Local-data permission model (issue #292).
 *
 * Agent Monitors persists snapshots, event bodies, diffs, source state, hook
 * state, and IPC coordination artifacts on the local machine. Those artifacts
 * can contain private source/API/command data, and the IPC socket is
 * unauthenticated. On a multi-user host with permissive home/XDG directory
 * modes, another local user could otherwise read the database or connect to the
 * socket. This module centralizes the owner-only permission invariant so every
 * creation site enforces it identically — see `docs/specs/002-runtime-delivery.md`
 * §3.1 and `docs/specs/000-principles.md` (BP4).
 *
 * The trust boundary is the current OS user: directories are `0700`, files are
 * `0600`. Modes are meaningless on Windows, so the helpers degrade to no-ops
 * there (the callers still create the paths, just without POSIX mode
 * enforcement).
 *
 * **Degrade gracefully on artifacts we do not own.** Tightening is best-effort:
 * where the artifact exists but is owned by another uid (e.g. a caller pointed a
 * hook-state path into a shared, group-writable directory), the `chmod` fails
 * with `EPERM`/`EACCES`. That is not fatal — the pre-hardening code needed only
 * write permission — so the helpers emit one structured stderr warning per path
 * per process and continue rather than throwing (spec 002 §3.1).
 */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Owner-only directory mode (`rwx------`). */
export const PRIVATE_DIR_MODE = 0o700;

/** Owner-only file mode (`rw-------`). */
export const PRIVATE_FILE_MODE = 0o600;

const isWindows = process.platform === 'win32';

/**
 * Narrow an unknown thrown value to a Node `ErrnoException` (an error carrying a
 * `code` string such as `ENOENT`/`EPERM`). Shared so every `code`-based catch in
 * core and the CLI uses one type-safe guard instead of an unchecked cast.
 */
export function isErrnoException(
  error: unknown,
): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * `lstat` a path, returning `null` (not throwing) when it does not exist. Any
 * other error propagates. Shared by the tighten helpers so the "missing path is
 * a no-op" rule is expressed in exactly one place.
 */
function lstatOrNull(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Paths we have already warned about failing to tighten. Keeps the best-effort
 * degrade path (below) to one stderr line per path per process, so a monitor
 * that writes a not-ours artifact every tick does not spam the log.
 */
const bestEffortWarnedPaths = new Set<string>();

/**
 * Emit a single structured warning when we could not tighten a path we do not
 * own (`EPERM`/`EACCES`), then remember it so we never warn about it again this
 * process. The caller continues without throwing (issue #292 review).
 */
function warnBestEffortTightenFailure(
  targetPath: string,
  mode: number,
  err: NodeJS.ErrnoException,
): void {
  if (bestEffortWarnedPaths.has(targetPath)) return;
  bestEffortWarnedPaths.add(targetPath);
  process.stderr.write(
    `Warning: could not restrict permissions on ${targetPath} to 0${mode.toString(8)} (${String(err.code)}); ` +
      `it is not owned by the current user, so its mode is left unchanged.\n`,
  );
}

/**
 * True for the errno codes that mean "the artifact is not ours to chmod" — the
 * best-effort degrade path swallows these; anything else is a real fault and
 * re-thrown.
 */
function isNotOwnedErrno(err: unknown): err is NodeJS.ErrnoException {
  return (
    isErrnoException(err) && (err.code === 'EPERM' || err.code === 'EACCES')
  );
}

/**
 * Tighten the mode of an existing path to `mode`, refusing to follow a symlink.
 *
 * This is the "tighten existing artifacts on startup" path (issue #292): a
 * database, socket directory, or hook-state file created by an earlier version
 * under a permissive umask keeps its world-readable mode until it is chmod'd.
 * Re-applying the owner-only mode on every startup migrates those artifacts
 * forward without a destructive rewrite.
 *
 * Symlink safety: we `lstat` first and refuse to act on a symlink, then re-open
 * with `O_NOFOLLOW` and `fchmod` the resulting descriptor. Opening the fd and
 * chmod-ing *it* (rather than the path) closes the lstat→chmod TOCTOU window, so
 * an attacker who swaps the path for a symlink between the two steps cannot
 * redirect our chmod onto a file we do not own.
 *
 * Best-effort: when the path exists but belongs to another user (`EPERM`/
 * `EACCES`), it emits one warning per path per process and returns rather than
 * throwing — tightening someone else's artifact is not our job, and failing to
 * would be a functional regression (pre-#292 callers needed only write access).
 *
 * No-ops (never throws) when the path is missing, is a symlink, is neither a
 * regular file nor a directory, or on Windows.
 */
export function restrictExistingPathMode(
  targetPath: string,
  mode: number,
): void {
  if (isWindows) return;

  const linkStat = lstatOrNull(targetPath);
  if (linkStat === null) return;

  // Never chmod through a symlink — neither follow it nor "fix" it.
  if (linkStat.isSymbolicLink()) return;
  // Only regular files and directories carry the modes we manage. Sockets are
  // tightened by their owning module (they cannot be opened via `open`).
  if (!linkStat.isFile() && !linkStat.isDirectory()) return;

  let fd: number;
  try {
    fd = openSync(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    // ELOOP → the final component became a symlink after our lstat; ENOENT → it
    // vanished. Either way there is nothing safe left to tighten.
    if (
      isErrnoException(err) &&
      (err.code === 'ELOOP' || err.code === 'ENOENT')
    )
      return;
    throw err;
  }

  try {
    fchmodSync(fd, mode);
  } catch (err) {
    if (isNotOwnedErrno(err)) {
      warnBestEffortTightenFailure(targetPath, mode, err);
    } else {
      throw err;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Paths for which {@link ensurePrivateDir} has already created-and-tightened the
 * directory this process. Spec 002 §3.1 requires tightening once per *startup*
 * (a startup is one process); the daemon then writes hook state per lead session
 * per tick, so re-running `lstat`/`open`/`fchmod` on the same session directory
 * every write is wasted work. The cache collapses that to one verification per
 * path per process.
 */
const verifiedPrivateDirs = new Set<string>();

/**
 * Ensure `dirPath` exists as an owner-only (`0700`) directory, creating any
 * missing ancestors with the same mode and tightening the leaf if it already
 * exists with a looser mode.
 *
 * `mkdirSync`'s `mode` is masked by the process umask on creation, but `0700`
 * has no group/other bits for a permissive umask to remove, so newly created
 * directories come out `0700` regardless of umask. The follow-up
 * {@link restrictExistingPathMode} covers the already-exists case, which
 * `mkdirSync` leaves untouched.
 *
 * The result is cached per process (see {@link verifiedPrivateDirs}) so
 * steady-state writes into an already-verified directory skip the
 * `lstat`/`open`/`fchmod` cycle. Tests that simulate a *second* startup in one
 * process must call {@link resetVerifiedPathCachesForTest} to re-exercise the
 * tighten-on-startup path.
 *
 * Intended for Agent-Monitors-owned locations under the user's home/XDG data
 * root (the per-workspace data directory, session directories, socket
 * directory). Not for untrusted shared locations such as a world-writable
 * `/tmp` — those require ownership verification, which lives with the socket
 * fallback in the CLI.
 */
export function ensurePrivateDir(dirPath: string): void {
  if (verifiedPrivateDirs.has(dirPath)) return;
  mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  restrictExistingPathMode(dirPath, PRIVATE_DIR_MODE);
  verifiedPrivateDirs.add(dirPath);
}

/**
 * Run `fn` with the process umask set to `0o077` so any file the callback (or a
 * native library it drives, e.g. SQLite's WAL/SHM sidecars) creates comes out
 * owner-only, then restore the previous umask.
 *
 * The umask is process-global, so this must only wrap *synchronous* work with
 * no interleaving I/O from other logical operations. On Windows the umask is not
 * meaningful; the callback runs with no change.
 */
export function withRestrictedUmask<T>(fn: () => T): T {
  if (isWindows) return fn();
  const previous = process.umask(0o077);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

/** Options for {@link writePrivateFileAtomic}. */
export interface WritePrivateFileAtomicOptions {
  /**
   * Distinguishes the temp file used during the write, appended between
   * `filePath` and the trailing `.tmp` (e.g. `.<pid>` so two writers racing
   * on the same target don't create — and rename — the same temp path).
   * Defaults to no suffix (`<filePath>.tmp`).
   */
  tempSuffix?: string;
}

/**
 * Atomically write `contents` to `filePath` with owner-only (`0600`) mode,
 * ensuring the containing directory is owner-only (`0700`) first.
 *
 * Writes to a sibling temp file (any pre-existing file or planted symlink at
 * that deterministic path is removed first, then the temp is created `0600`
 * with `O_EXCL` so a symlink is never followed) and renames it into place, so
 * a reader never observes a partial file. Used for hook-state files, which may
 * reveal pending-work titles.
 */
export function writePrivateFileAtomic(
  filePath: string,
  contents: string,
  options?: WritePrivateFileAtomicOptions,
): void {
  ensurePrivateDir(path.dirname(filePath));
  const tmpPath = `${filePath}${options?.tempSuffix ?? ''}.tmp`;
  // The temp path is deterministic, so treat whatever sits there as hostile:
  // remove it (rm does not follow symlinks) and recreate with `O_EXCL`, which
  // refuses to follow a symlink planted between the two calls. A plain
  // `writeFileSync(tmpPath, ...)` would follow a symlink pre-planted while the
  // directory was still permissive (pre-migration) and overwrite its target.
  // `O_EXCL` creation also applies `mode` directly, so no stale-tmp re-tighten
  // is needed.
  rmSync(tmpPath, { force: true });
  const fd = openSync(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  try {
    writeFileSync(fd, contents, { encoding: 'utf-8' });
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  // No post-rename re-tighten of `filePath`: `rename` preserves the source
  // inode's mode, and the temp inode is guaranteed `0600` by the `writeFileSync`
  // mode plus the re-tighten above (no realistic umask strips owner bits from
  // `0600`). Tightening the final path would therefore be a provable no-op, so
  // skipping it removes one `lstat`/`open`/`fchmod` cycle from a hot write path
  // (per lead session per tick, plus per `hook deliver`).
}

/**
 * Chmod a just-bound Unix domain socket to owner-only (`0600`) so other local
 * users cannot connect even where the platform enforces socket permission bits
 * for `connect(2)`. The socket's owner-only *containing directory* is the
 * primary guard; this is defense-in-depth.
 *
 * A socket cannot be opened via `open(2)`, so we cannot use the `O_NOFOLLOW`
 * fd path {@link restrictExistingPathMode} uses. Instead we `lstat` and only
 * `chmod` when the path is genuinely a socket (never a symlink an attacker
 * swapped in) — the owner-only parent directory (guaranteed by the daemon's
 * socket-dir setup) is what actually closes the residual chmod-follows-symlink
 * window here. Best-effort on `EPERM`/`EACCES` (warns once, continues). No-op on
 * Windows / missing paths.
 */
export function restrictSocketMode(socketPath: string): void {
  if (isWindows) return;
  const st = lstatOrNull(socketPath);
  if (st === null) return;
  if (!st.isSocket()) return;
  try {
    chmodSync(socketPath, PRIVATE_FILE_MODE);
  } catch (err) {
    if (isNotOwnedErrno(err)) {
      warnBestEffortTightenFailure(socketPath, PRIVATE_FILE_MODE, err);
      return;
    }
    throw err;
  }
}

/**
 * Test-only: clear the per-process caches ({@link verifiedPrivateDirs} and the
 * best-effort warning dedup set) so a test that simulates a *second* daemon
 * startup within one process — real startups are separate processes, each with
 * a fresh cache — re-exercises the tighten-on-startup migration and warning
 * paths. Deliberately **not** re-exported from the package entry point, so it
 * stays out of the public API surface; co-located tests import it from this
 * module directly.
 */
export function resetVerifiedPathCachesForTest(): void {
  verifiedPrivateDirs.clear();
  bestEffortWarnedPaths.clear();
}
