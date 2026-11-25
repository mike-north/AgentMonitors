## 2026-06-10 — Activation plugin via a colocated aipm marketplace; `channel-plugin/` folded in

Activation now ships as a single installable Claude Code plugin (`agentmonitors`) in a colocated
[aipm](https://www.npmjs.com/package/@ai-plugin-marketplace/cli) marketplace embedded in this repo
(`agent-plugins/`, with `aipm.repo.ts` relocating `pluginsRoot` off the package `plugins/` glob).
The plugin wires the host lifecycle to the already-built CLI verbs — `SessionStart` →
`agentmonitors session start` then `agentmonitors hook deliver`, `UserPromptSubmit` →
`agentmonitors hook deliver`, `SessionEnd` → `agentmonitors session end` — and bundles the channel
MCP and a `setup-monitors` skill. Install once; thereafter a project opts in with project-local
state (no reinstall per monitor). Documented in [006 §5.6](./006-agent-integration.md).

- **Folded + retired `channel-plugin/`.** The standalone root `channel-plugin/` is removed; its
  `.mcp.json` (server key `agentmonitors`, preserving the `<channel source="agentmonitors">` tag)
  now lives at `agent-plugins/agentmonitors/.mcp.json` inside the activation plugin. The 2026-06-01
  entry below remains as a historical record of the original standalone packaging.
- **`PreToolUse`/`Stop` deliberately unwired** (they ignore `additionalContext`); `PostToolUse` left
  as a documented future tunable (per-tool firing → too many daemon round-trips for v1).
- **Targets: `claude` only.** aipm v0.3.0 does not generate Codex hooks and only Claude Code has the
  channel transport, so a non-Claude target would ship no working delivery path.
- **Hooks authored as host-native `hooks/hooks.json`.** aipm v0.3.0's Claude hooks transform only
  models `PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`, so the lifecycle events
  (`SessionStart`/`SessionEnd`) are authored directly as a Claude-native `hooks/hooks.json`
  referenced from the plugin manifest, rather than via aipm's YAML→JSON generation.
- CLI/plugin-content only — no published-package behavior change, so no changeset.

