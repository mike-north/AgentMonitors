import { defineWorkspace } from '@ai-plugin-marketplace/core';

/**
 * Marketplace metadata for this repo. Its presence opts the repo into generated
 * marketplace registries (`.claude-plugin/marketplace.json`) instead of
 * hand-authored JSON. Because this marketplace exposes a single Claude-targeted
 * plugin, the toolkit emits the repo-root Claude marketplace registry for it.
 */
export default defineWorkspace({
  marketplace: {
    name: 'agentmonitors',
    owner: { name: 'Mike North' },
    description:
      'Drop-in monitoring for agentic coding — author a MONITOR.md and get told when watched things change.',
  },
});
