import { DaemonConnectionError, resolveSocketPath } from './daemon-ipc.js';
import { readLocalState } from './local-state.js';

// Names `agentmonitors doctor` alongside the daemon-run fix-it command (issue
// #331): a bare "no daemon" message doesn't say whether anything else is
// wrong (project not enabled, no monitors, invalid definitions) — doctor is
// the single command that answers all of that in one pass.
export const NO_WORKSPACE_DAEMON_MESSAGE =
  'No daemon running for this workspace - start it with `agentmonitors daemon run` (or it starts automatically when a Claude Code session opens), then run `agentmonitors doctor` for the full workspace-health picture.';

/**
 * Resolve the socket used by interactive/manual daemon commands.
 *
 * Precedence is:
 * 1. An explicit command flag.
 * 2. AGENTMONITORS_SOCKET, handled by callDaemon's existing resolver.
 * 3. The enabled workspace's persisted `.claude/agentmonitors.local.md` socket.
 * 4. The existing global default socket, handled by callDaemon.
 *
 * Returning undefined for cases 2 and 4 deliberately preserves the existing
 * callDaemon fallback behavior instead of duplicating global socket logic here.
 */
export function resolveManualDaemonSocketPath(
  explicitSocket?: string,
  workspacePath?: string,
): string | undefined {
  if (explicitSocket)
    return resolveSocketPath(explicitSocket, { explicit: true });
  if (process.env['AGENTMONITORS_SOCKET']) return undefined;

  const workspace =
    workspacePath ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  const state = readLocalState(workspace);
  if (state.enabled && state.socket) return resolveSocketPath(state.socket);
  return undefined;
}

/**
 * Convert only transport-level daemon failures into the manual-command
 * remediation. Daemon-side application errors remain visible to the user.
 */
export function manualDaemonErrorMessage(error: unknown): string {
  if (isManualDaemonConnectionError(error)) {
    return NO_WORKSPACE_DAEMON_MESSAGE;
  }
  return error instanceof Error ? error.message : String(error);
}

export function isManualDaemonConnectionError(error: unknown): boolean {
  return error instanceof DaemonConnectionError;
}
