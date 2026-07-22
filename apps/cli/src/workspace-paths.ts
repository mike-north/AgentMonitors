import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface WorkspacePaths {
  /** The per-workspace data directory. */
  dir: string;
  /** The per-workspace SQLite db path. */
  db: string;
  /** The per-workspace Unix socket path. */
  socket: string;
}

/**
 * Resolve the XDG-aware data root every workspace/transport/socket derivation
 * shares: `XDG_DATA_HOME` when set, else `~/.local/share`.
 *
 * This is the CANONICAL definition — `daemon-ipc.ts`'s socket-base resolution
 * and `transport-heartbeat.ts`'s registry location both import this rather
 * than re-deriving it, so the environment-mismatch detector that compares a
 * transport's reported data root against "what we resolve now" (in
 * `transport-health.ts`) can never silently diverge from its own copy — the
 * exact bug class it exists to catch.
 */
export function resolveDataRoot(): string {
  return (
    process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share')
  );
}

/**
 * Stable short hash for a workspace path, used to namespace per-workspace
 * data (the db/socket directory here, and the hook heartbeat's registry key
 * in `transport-heartbeat.ts`). Sliced to 16 hex characters: enough to be
 * collision-safe for the number of workspaces one machine ever has, short
 * enough to keep the derived socket path well under the AF_UNIX length limit.
 */
export function workspaceHash(workspacePath: string): string {
  return createHash('sha256')
    .update(path.resolve(workspacePath))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Derive a stable, per-workspace data directory (and the db + socket inside it)
 * from the absolute workspace path. Two sessions in the same repo share one
 * daemon; two repos get isolated daemons. Mirrors the default data root used by
 * `resolveDbPath`/`resolveSocketPath`, namespaced by a hash of the workspace.
 */
export function workspacePaths(workspacePath: string): WorkspacePaths {
  const hash = workspaceHash(workspacePath);
  const dir = path.join(resolveDataRoot(), 'agentmonitors', 'workspaces', hash);
  return {
    dir,
    db: path.join(dir, 'inbox.db'),
    // Keep the socket short: a 16-char hash under the data dir stays well under
    // the 100-char limit on most setups; resolveSocketPath's /tmp fallback still
    // applies if a deep home dir pushes it over.
    socket: path.join(dir, 'agentmonitors.sock'),
  };
}
