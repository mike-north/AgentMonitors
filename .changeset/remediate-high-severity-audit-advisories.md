---
'agentmonitors': patch
'@agentmonitors/cli': patch
'@agentmonitors/core': patch
---

Clear all 13 high-severity `pnpm audit --prod` findings. `@agentmonitors/core` now
declares `drizzle-orm@^0.45.2` (previously `^0.45.1`, below the patched release).
`@agentmonitors/cli`'s published bundle now embeds a patched `fast-uri` and `hono`
(pinned forward via a workspace `pnpm-workspace.yaml` override on the
`@modelcontextprotocol/sdk` dependency tree, since both were bundled at their
previously-resolved, vulnerable versions). No public API or behavior changes.
