# Channel probe (throwaway experiment)

Answers the open question in [`docs/specs/006-agent-integration.md`](../../docs/specs/006-agent-integration.md)
§4.4 / §9: **when Claude Code spawns a stdio channel MCP server, what does it provide?**
Specifically — is `CLAUDE_PROJECT_DIR` set, what is the server's `cwd`, and does `roots/list`
work? The answer decides whether the real channel transport can bind to a workspace.

This is not product code. It is a diagnostic channel server that reports its own environment.

## Setup

```bash
cd experiments/channel-probe
npm install            # pulls @modelcontextprotocol/sdk only
```

## Run the real test (needs Claude Code v2.1.80+)

The `.mcp.json` here registers the probe with an **absolute** path, so cwd doesn't affect
whether the script is found. Start a Claude Code session that loads it with the development
flag (custom channels aren't on the allowlist):

```bash
# from any project you want to test as the "workspace"
claude --dangerously-load-development-channels server:agentmon-probe
```

If you see "blocked by org policy", channels are disabled for your org and the probe can't run
(which is itself a useful data point for the can't-assume-channels constraint).

Once the session is up, three independent readouts are available — check whichever works:

1. **Findings file (most reliable, no channel needed):**
   ```bash
   cat "$TMPDIR/agentmon-channel-probe.json"   # or /tmp/agentmon-channel-probe.json
   ```
   Written at server startup, so it answers the `cwd` / `CLAUDE_PROJECT_DIR` question even if
   the channel notification or tool path fails.

2. **The `probe` tool:** in the session, ask Claude to *"call the probe tool and show the
   result"* — returns the same snapshot plus a `roots/list` attempt.

3. **The channel push:** ~1.5s after the session starts, a `<channel source="agentmon-probe">`
   event should arrive carrying the snapshot. If it renders, the channel transport path is
   confirmed end-to-end.

## What to look for

| Question | Where the answer is | Why it matters |
| --- | --- | --- |
| Is `CLAUDE_PROJECT_DIR` set, and to what? | `CLAUDE_PROJECT_DIR` in the findings | the primary workspace-binding signal (006 §4.4) |
| What is the server's `cwd`? | `cwd` in the findings | the fallback / sanity check |
| Does `roots/list` work, and what does it return? | `roots` in the tool result / channel push | the alternative workspace signal |
| Is there any session id anywhere? | `claudeEnv` keys | confirms (or refutes) the "no session id" finding |
| Does a `<channel>` event actually render? | readout #3 | validates the transport surface itself |

Report the findings JSON back and we promote 006 §4.4 from *target* to *current* (or revise it).

## Teardown

Throwaway. Delete `experiments/channel-probe/` (and the `agentmon-channel-probe.json` findings
files) when done; nothing depends on it.
