# AgentMon channel plugin

A Claude Code **channel** that surfaces AgentMon monitor deliveries in your session and lets you
acknowledge them. It runs `agentmonitors channel serve` as a stdio MCP server (see
[005 §13](../docs/specs/005-cli-reference.md) and [006 §4](../docs/specs/006-agent-integration.md)).

- **Outbound:** settled high-urgency deliveries arrive as `<channel source="agentmonitors" …>` events.
- **Inbound:** call the `agentmon_ack` tool with the `event_id`s you've handled (or none, to ack all
  unread).

The MCP server name in [`.mcp.json`](./.mcp.json) (`agentmonitors`) is what becomes the
`<channel source="agentmonitors">` tag.

## Prerequisites

1. **Claude Code v2.1.80+** with channels enabled for your org (channels are a research preview; see
   <https://code.claude.com/docs/en/channels>).
2. **The `agentmonitors` CLI on `PATH`.** It is not yet published, so build and link it from this repo:
   ```bash
   pnpm install && pnpm build
   pnpm --filter @mike-north/cli exec npm link   # or add apps/cli/dist to PATH
   ```
   (For local testing without a global link, point the `.mcp.json` `command`/`args` at the built
   binary instead — `"command": "node", "args": ["<repo>/apps/cli/dist/index.cjs", "channel", "serve"]`.)
3. **A running daemon** on the same socket the channel resolves (`$AGENTMONITORS_SOCKET` or the
   default), with at least one monitor:
   ```bash
   agentmonitors daemon run .claude/monitors --workspace "$PWD"
   ```

## Use it

During the research preview, custom channels aren't on the allowlist, so load it with the
development flag (this plugin's server is named `agentmonitors`):

```bash
claude --dangerously-load-development-channels server:agentmonitors --mcp-config channel-plugin/.mcp.json
```

If a high-urgency monitor fires while the session is open, it arrives as a `<channel>` event. Ask
Claude to call `agentmon_ack` once it has handled the work to clear the unread state.

If you see "blocked by org policy", channels aren't enabled for your org — the hook-state delivery
path still works regardless (the channel is purely additive; see
[006 §7](../docs/specs/006-agent-integration.md)).

## Status

Stages 1–2 (one-way push + the `agentmon_ack` tool) are implemented; this plugin is the packaging
(stage 3). The end-to-end run above is a **manual UAT** — channels are research-preview and can't run
in CI.
