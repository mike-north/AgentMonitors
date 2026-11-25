/** Workspace socket discovery and honest diagnostics for manual daemon requests. */
import { DaemonConnectionError, resolveSocketPath } from './daemon-ipc.js';
import { reportError } from './output.js';
import { readLocalState } from './local-state.js';
import { workspacePaths } from './workspace-paths.js';

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
 * 3. The enabled workspace's persisted `.claude/agentmonitors.local.md` socket,
 *    or — when nothing has persisted one yet (e.g. a daemon started directly
 *    via `agentmonitors daemon run` rather than lazily booted by a Claude Code
 *    hook) — the derived per-workspace socket ({@link workspacePaths}), which
 *    `daemon run`/`daemon once` now also bind to by default (issue #335).
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
  if (state.enabled) {
    return resolveSocketPath(state.socket ?? workspacePaths(workspace).socket);
  }
  return undefined;
}

/**
 * The mutation and read-only inspection that can establish its eventual result.
 * @internal
 */
export interface ManualDaemonMutation {
  readonly action: string;
  readonly checkCommand: string;
}

/**
 * Report only what the transport established. A written request may still take
 * effect, so missing replies use exit 3 and never suggest starting a daemon.
 * Connection diagnostics always use stderr; application errors retain the
 * command's existing format and exit 1. Mutation context is absent for reads.
 * @internal
 */
export function reportManualDaemonError(
  error: unknown,
  json: boolean,
  mutation?: ManualDaemonMutation,
  socketPath?: string,
): void {
  if (!(error instanceof DaemonConnectionError)) {
    reportError(error instanceof Error ? error.message : String(error), json);
    return;
  }
  if (!error.requestSent) {
    reportError(NO_WORKSPACE_DAEMON_MESSAGE, false);
    return;
  }
  const message = mutation
    ? `${mutation.action} outcome unknown: the daemon received the request but no reply arrived (${error.message}). It may already have been applied, or may still be applied. Check with \`${mutation.checkCommand}\` before running it again.`
    : `Request to the AgentMon daemon at ${resolveSocketPath(socketPath)} got no reply (${error.message}); the daemon is running but did not answer.`;
  reportError(message, false);
  process.exitCode = 3;
}
