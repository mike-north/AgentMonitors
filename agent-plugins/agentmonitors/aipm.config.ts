import { defineConfig } from '@ai-plugin-marketplace/core';

export default defineConfig({
  version: '0.0.1',
  // Claude-only: aipm v0.3.0 does not generate Codex hooks (out of scope), and
  // only Claude Code has the channel transport — a non-Claude target would ship
  // no working delivery path. Claude-only is the honest v1.
  targets: ['claude'],
  description:
    'Drop-in monitoring for agentic coding — author a MONITOR.md and get told when watched things change. Wires the AgentMon lifecycle hooks and the channel MCP into Claude Code.',
  keywords: ['agentmonitors', 'monitoring', 'channel', 'mcp', 'hooks'],
});
