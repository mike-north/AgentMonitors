import {
  AgentMonitorRuntime,
  RuntimeStore,
  claudeCodeAdapter,
  createDb,
} from '@mike-north/core';
import { registerCoreSources } from './sources.js';
import { resolveDbPath } from './db-path.js';
import { resolveSocketPath } from './daemon-ipc.js';
import { SourceRegistry } from '@mike-north/core';

export function createRuntime(dbPath = resolveDbPath()): AgentMonitorRuntime {
  const db = createDb(dbPath);
  const registry = new SourceRegistry();
  registerCoreSources(registry);
  return new AgentMonitorRuntime(new RuntimeStore(db), registry, [
    claudeCodeAdapter,
  ]);
}

export { resolveDbPath, resolveSocketPath };
