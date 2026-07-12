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

## Running hooks-only (no MCP)

The channel MCP server (`.mcp.json`, `agentmonitors channel serve`) is **entirely optional**. If
your environment disallows unblessed MCP servers (common on Team/Enterprise or in restricted
corporate setups), you can strip or disable `.mcp.json` and keep everything else — delivery
semantics are unchanged; see
[`docs/specs/006-agent-integration.md` §6.1](../../docs/specs/006-agent-integration.md) for the
proof and the full guarantee.

**To run hooks-only:** install/keep [`hooks/hooks.json`](./hooks/hooks.json) (the three commands in
the table above) and remove or block [`.mcp.json`](./.mcp.json) — e.g. via your Claude Code MCP
server allowlist/denylist, or by installing only the hooks half of this plugin. Nothing else
changes: the same monitors fire, the same events materialize, and the same
unread/claimed/acknowledged lifecycle applies.

**What actually changes:** only the in-session *acknowledge* affordance. With the channel enabled,
you can call the `agentmon_ack` MCP tool from inside the session. Without it, use the CLI directly —
same daemon call, different surface:

| With MCP (channel enabled)                          | Hooks-only (CLI equivalent)                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `<channel source="agentmonitors" ...>` push           | `agentmonitors hook deliver` (wired to `UserPromptSubmit`, already in `hooks.json`) |
| `agentmon_ack({ event_ids: [...] })` tool call         | `agentmonitors events ack --session <id> --event-ids <ids>`        |
| (no CLI equivalent needed — same tool call, all unread)| `agentmonitors events ack --session <id>` (omit `--event-ids` to ack all unread) |
| Inspecting what's pending from the `<channel>` tag     | `agentmonitors events list --session <id> --unread`                |

`<id>` is the AgentMon session id from `agentmonitors session list`. Both surfaces call the exact
same daemon IPC (`events.ack`, `hook.claim`) — see 006 §6.1 for the code-level proof.

## Distribution

This plugin is published as content in the repo's colocated
[aipm](https://www.npmjs.com/package/@ai-plugin-marketplace/cli) marketplace
(`.claude-plugin/marketplace.json`, generated and freshness-checked by `aipm validate`). It is not a
separately licensed npm package; it ships under the AgentMonitors repository terms.
