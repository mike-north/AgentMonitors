import { readLocalState, type LocalState } from './local-state.js';
import { workspacePaths } from './workspace-paths.js';
import { resolveDbPath } from './db-path.js';

/**
 * Resolve the SQLite database path a workspace's daemon binds to (or should
 * be read from) — the single source of truth every workspace-aware command
 * uses, so a daemon started directly (`agentmonitors daemon run`/`once`, as
 * the Getting Started guide instructs) and one lazily booted by a Claude Code
 * hook (`session start`) always agree with `doctor`'s diagnosis (issue #335).
 *
 * Priority mirrors {@link resolveManualDaemonSocketPath}'s socket resolution:
 * `AGENTMONITORS_DB` wins outright (tests/overrides); otherwise an enabled
 * workspace uses its persisted `.claude/agentmonitors.local.md` `db:` value,
 * or — when nothing has persisted one yet, e.g. before any daemon has run —
 * the derived per-workspace db ({@link workspacePaths}); a not-enabled
 * workspace has no project-scoped daemon to isolate to, so it falls back to
 * the shared global default.
 */
export function resolveWorkspaceDbPath(
  workspace: string,
  state?: LocalState,
): string {
  // Env wins outright — checked before local state is even read, so the
  // override path does no filesystem I/O (a default-parameter initializer
  // would run first and defeat that).
  if (process.env['AGENTMONITORS_DB']) return process.env['AGENTMONITORS_DB'];
  const localState = state ?? readLocalState(workspace);
  if (localState.enabled) {
    return localState.db ?? workspacePaths(workspace).db;
  }
  return resolveDbPath();
}
