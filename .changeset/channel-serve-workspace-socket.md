---
'@agentmonitors/cli': patch
'agentmonitors': patch
---

`channel serve` (the MCP server the `agentmonitors` plugin's `.mcp.json` spawns with no flags) now
resolves the same per-workspace socket `session start` binds to for an **enabled** workspace,
instead of the bare global default. Because `channel serve` is spawned automatically like a hook
(never typed by hand), its precedence for this is deliberately different from `session`/`events`/
`hook`/`daemon`: an explicit `--socket` still wins outright, but the enabled workspace's socket now
wins over `AGENTMONITORS_SOCKET` too — a stale env var left over from a different workspace must
never cross-connect the channel to that workspace's daemon. A not-enabled workspace is unaffected:
it still falls back to `AGENTMONITORS_SOCKET`, then the global default.

Previously, `channel serve` spawned exactly as the plugin spawns it — with no `--socket` flag —
resolved a _different_ socket than the one a `session start`-lazy-booted daemon binds to for an
enabled workspace, so the channel transport silently never delivered a push (issue #358). Hook-state
delivery was unaffected.
