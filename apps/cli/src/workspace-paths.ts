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
 * Derive a stable, per-workspace data directory (and the db + socket inside it)
 * from the absolute workspace path. Two sessions in the same repo share one
 * daemon; two repos get isolated daemons. Mirrors the default data root used by
 * `resolveDbPath`/`resolveSocketPath`, namespaced by a hash of the workspace.
 */
export function workspacePaths(workspacePath: string): WorkspacePaths {
  const hash = createHash('sha256')
    .update(path.resolve(workspacePath))
    .digest('hex')
    .slice(0, 16);
  const dataRoot =
    process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share');
  const dir = path.join(dataRoot, 'agentmonitors', 'workspaces', hash);
  return {
    dir,
    db: path.join(dir, 'inbox.db'),
    // Keep the socket short: a 16-char hash under the data dir stays well under
    // the 100-char limit on most setups; resolveSocketPath's /tmp fallback still
    // applies if a deep home dir pushes it over.
    socket: path.join(dir, 'agentmonitors.sock'),
  };
}
