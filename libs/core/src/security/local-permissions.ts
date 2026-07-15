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
 * No-ops (never throws) when the path is missing, is a symlink, is neither a
 * regular file nor a directory, or on Windows.
 */
export function restrictExistingPathMode(
  targetPath: string,
  mode: number,
): void {
  if (isWindows) return;

  let linkStat: Stats;
  try {
    linkStat = lstatSync(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  // Never chmod through a symlink — neither follow it nor "fix" it.
  if (linkStat.isSymbolicLink()) return;
  // Only regular files and directories carry the modes we manage. Sockets are
  // tightened by their owning module (they cannot be opened via `open`).
  if (!linkStat.isFile() && !linkStat.isDirectory()) return;

  let fd: number;
  try {
    fd = openSync(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP → the final component became a symlink after our lstat; ENOENT → it
    // vanished. Either way there is nothing safe left to tighten.
    if (code === 'ELOOP' || code === 'ENOENT') return;
    throw err;
  }

  try {
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

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
 * Intended for Agent-Monitors-owned locations under the user's home/XDG data
 * root (the per-workspace data directory, session directories, socket
 * directory). Not for untrusted shared locations such as a world-writable
 * `/tmp` — those require ownership verification, which lives with the socket
 * fallback in the CLI.
 */
export function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  restrictExistingPathMode(dirPath, PRIVATE_DIR_MODE);
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

/**
 * Atomically write `contents` to `filePath` with owner-only (`0600`) mode,
 * ensuring the containing directory is owner-only (`0700`) first.
 *
 * Writes to a sibling temp file (created `0600`, then re-tightened in case a
 * stale temp file predated this code) and renames it into place, so a reader
 * never observes a partial file. Used for hook-state files, which may reveal
 * pending-work titles.
 */
export function writePrivateFileAtomic(
  filePath: string,
  contents: string,
): void {
  ensurePrivateDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, contents, {
    encoding: 'utf-8',
    mode: PRIVATE_FILE_MODE,
  });
  restrictExistingPathMode(tmpPath, PRIVATE_FILE_MODE);
  renameSync(tmpPath, filePath);
  restrictExistingPathMode(filePath, PRIVATE_FILE_MODE);
}

/**
 * Tighten the mode of a plain (already-created) file to owner-only (`0600`),
 * without managing its directory. Used where the containing directory is *not*
 * Agent-Monitors-owned and must keep its existing mode (e.g. the
 * `.claude/agentmonitors.local.md` coordination file, whose `.claude` parent
 * belongs to the host tool). Delegates to {@link restrictExistingPathMode}, so
 * it is symlink-safe and a no-op on Windows / missing paths.
 */
export function restrictFileMode(filePath: string): void {
  restrictExistingPathMode(filePath, PRIVATE_FILE_MODE);
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
 * swapped in). No-op on Windows / missing paths.
 */
export function restrictSocketMode(socketPath: string): void {
  if (isWindows) return;
  let st: Stats;
  try {
    st = lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!st.isSocket()) return;
  chmodSync(socketPath, PRIVATE_FILE_MODE);
}
