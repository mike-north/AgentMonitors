---
'@agentmonitors/cli': patch
'agentmonitors': patch
---

`channel serve` (the MCP server the `agentmonitors` plugin's `.mcp.json` spawns with no flags) now
resolves its daemon socket the same per-workspace-aware way every other workspace-aware command
does (`session`, `events`, `hook`, `daemon`) — an explicit `--socket` or `AGENTMONITORS_SOCKET`
still wins outright, but otherwise an **enabled** workspace resolves its persisted-or-derived
per-workspace socket instead of the bare global default.

Previously, `channel serve` spawned exactly as the plugin spawns it — with no `--socket` flag —
resolved a _different_ socket than the one a `session start`-lazy-booted daemon binds to for an
enabled workspace, so the channel transport silently never delivered a push (issue #358). Hook-state
delivery was unaffected.
