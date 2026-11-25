/** Compose the runtime with bundled sources and optional daemon command ownership. */
import {
  AgentMonitorRuntime,
  type CommandProcessOwner,
  RuntimeStore,
  claudeCodeAdapter,
  createDb,
} from '@agentmonitors/core';
import { readLocalState } from './local-state.js';
import { registerCoreSources } from './sources.js';
import { resolveDbPath } from './db-path.js';
import { resolveSocketPath } from './daemon-ipc.js';
import { SourceRegistry } from '@agentmonitors/core';

/** Applying policy belongs to store construction, never session/socket coordination. */
function parseClaimTtlMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // The coordination representation retains the original complete field line.
  const value = Number(raw.slice(raw.indexOf(':') + 1).trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      'claim-ttl-ms must be a positive safe integer in milliseconds',
    );
  }
  return value;
}

/**
 * Compose one store with the target workspace's persisted claim policy. Every
 * daemon and offline reader uses this boundary, including callers outside the
 * workspace. Validate policy before opening SQLite. @internal
 */
export function createRuntime(
  dbPath = resolveDbPath(),
  commandOwner?: CommandProcessOwner,
  shutdownSignal?: AbortSignal,
  workspacePath = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd(),
): AgentMonitorRuntime {
  const claimTtlMs = parseClaimTtlMs(readLocalState(workspacePath).claimTtlMs);
  const db = createDb(dbPath);
  const registry = new SourceRegistry();
  registerCoreSources(registry, commandOwner, shutdownSignal);
  return new AgentMonitorRuntime(
    new RuntimeStore(db, claimTtlMs === undefined ? {} : { claimTtlMs }),
    registry,
    [claudeCodeAdapter],
  );
}

export { resolveDbPath, resolveSocketPath };
