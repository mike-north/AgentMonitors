import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  claudeCodeAdapter,
  createDb,
} from '@agentmonitors/core';
import { resolveDbPath } from './db-path.js';
import { registerCoreSources } from './sources.js';

export function createRuntime(dbPath?: string): AgentMonitorRuntime {
  const db = createDb(resolveDbPath(dbPath));
  const registry = new SourceRegistry();
  registerCoreSources(registry);
  const store = new RuntimeStore(db);
  return new AgentMonitorRuntime(store, registry, [claudeCodeAdapter]);
}
