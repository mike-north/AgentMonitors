import { defineRepoConfig } from '@ai-plugin-marketplace/core';

// The repo's `plugins/` directory is taken by the published `source-*` packages,
// so the agent-plugin marketplace lives under `agent-plugins/` instead.
export default defineRepoConfig({
  pluginsRoot: 'agent-plugins',
  distDir: 'agent-plugins/dist',
});
