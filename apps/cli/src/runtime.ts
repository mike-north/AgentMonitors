/** Compose the runtime with bundled sources and optional daemon command ownership. */
import {
  AgentMonitorRuntime,
  type CommandProcessOwner,
  RuntimeStore,
  claudeCodeAdapter,
  createDb,
} from '@agentmonitors/core';
import { registerCoreSources } from './sources.js';
import { resolveDbPath } from './db-path.js';
import { resolveSocketPath } from './daemon-ipc.js';
import { SourceRegistry } from '@agentmonitors/core';

/** Compose one store and source registry, with optional daemon command ownership. @internal */
export function createRuntime(
  dbPath = resolveDbPath(),
  commandOwner?: CommandProcessOwner,
  shutdownSignal?: AbortSignal,
): AgentMonitorRuntime {
  const db = createDb(dbPath);
  const registry = new SourceRegistry();
  registerCoreSources(registry, commandOwner, shutdownSignal);
  return new AgentMonitorRuntime(new RuntimeStore(db), registry, [
    claudeCodeAdapter,
  ]);
}

export { resolveDbPath, resolveSocketPath };
