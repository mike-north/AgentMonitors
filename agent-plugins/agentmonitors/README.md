# agentmonitors (Claude Code plugin)

Drop-in monitoring for agentic coding. Install this plugin once into Claude Code; thereafter you
turn monitoring on per project by dropping markdown monitor files into `.claude/monitors/` and
enabling activation locally. See [`docs/specs/006-agent-integration.md` §5.6](../../docs/specs/006-agent-integration.md)
for the full contract.

## What it wires

This plugin connects the Claude Code lifecycle to the `agentmonitors` CLI:

| Hook event         | Command(s)                    | Notes                                                                         |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------- |
| `SessionStart`     | `agentmonitors session start` | Also surfaces the post-compact recap in the same process (no chaining needed) |
| `UserPromptSubmit` | `agentmonitors hook deliver`  |                                                                               |
| `SessionEnd`       | `agentmonitors session end`   |                                                                               |

It also registers the **channel MCP** (`agentmonitors channel serve`, see
[`.mcp.json`](./.mcp.json)) and a bundled **`setup-monitors`** skill that walks you through enabling
a project.

## Prerequisites

The `agentmonitors` binary must be on `PATH`. Install it globally:

```bash
npm i -g @agentmonitors/cli
```

## Enable monitoring in a project

Ask Claude to run the `setup-monitors` skill, or do it by hand:

1. Create a gitignored `.claude/agentmonitors.local.md` containing `enabled: true` (without it,
   `session start` quick-exits and nothing runs).
2. Scaffold a monitor: `agentmonitors init my-monitor --type file-fingerprint`.
3. Ensure `.gitignore` ignores `.claude/*.local.*` (and optionally `.claude/monitors/*`).

## Distribution

This plugin is published as content in the repo's colocated
[aipm](https://www.npmjs.com/package/@ai-plugin-marketplace/cli) marketplace
(`.claude-plugin/marketplace.json`, generated and freshness-checked by `aipm validate`). It is not a
separately licensed npm package; it ships under the AgentMonitors repository terms.
