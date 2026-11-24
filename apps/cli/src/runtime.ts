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
  const { claimTtlMs } = readLocalState(workspacePath);
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
