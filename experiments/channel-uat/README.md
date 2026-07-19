# Channel UAT (automated end-to-end)

Proves the **channel transport** ([`006-agent-integration.md`](../../docs/specs/006-agent-integration.md)
§4) end to end: does `agentmonitors channel serve` actually resolve its bound session, poll the
daemon, claim a settled delivery, render it, and **push** a `<channel>` notification to the host?

Channels are a Claude Code research-preview feature, so a real Claude session can't run in CI — and
on an org where channels are disabled it can't run at all. But the component under test is the
channel server, not Claude. So this harness plays the role of the MCP host itself: it connects to
`channel serve` over stdio with the real MCP SDK client and asserts the push. No Claude, no
channels org-enablement, fully scriptable.

This is a UAT harness, not product code.

## What it does

1. Scaffolds a temp workspace with a `file-fingerprint` monitor.
2. Starts a real `agentmonitors daemon run` on a private socket + db.
3. Spawns `agentmonitors channel serve` as an MCP server and connects to it as a client, passing the
   same `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PROJECT_DIR` Claude Code would inject (binding confirmed
   by [`../channel-probe`](../channel-probe)). The server opens its bound session against the daemon.
4. Mutates the watched file → the daemon's next tick materializes an event and projects it into the
   bound (lead) session.
5. Asserts the channel server pushes `notifications/claude/channel` for it.

## Setup & run

```bash
cd experiments/channel-uat
npm install                      # @modelcontextprotocol/sdk only
pnpm --filter @agentmonitors/cli build   # (from repo root) build the CLI the harness drives

node uat.mjs                     # normal urgency → coalesced reminder push (fast)
node uat.mjs high                # high urgency → concrete-event push (after the ~15s settle)
```

Exit `0` = the channel pushed; exit `1` = no push within the timeout (or a setup error). The
received notification is printed to stdout.

### Observed results

`normal` — a coalesced reminder:

```json
{ "content": "Monitored changes are pending. Run `agentmonitors events list --session <id> --unread` to see them, then `agentmonitors events ack --session <id>` once handled.",
  "meta": { "lifecycle": "turn-interruptible", "mode": "delivery", "event_count": "1", "urgency": "normal" } }
```

(`event_count` on a reminder claim reports the session's pending unread total the reminder refers to —
it is never `0`, since a reminder is only ever pushed when at least one event is pending; 006 §4.2.)

`high` — the concrete event, after the 15s high-urgency settle:

```json
{ "content": "1. File changed: …/watched.txt",
  "meta": { "lifecycle": "turn-interruptible", "mode": "delivery", "event_count": "1",
            "urgency": "high", "monitor_id": "watch-files", "event_id": "01KT…" } }
```

## Running against a real Claude session (optional)

To drive the *actual* Claude Code host instead of this harness, install the `agentmonitors`
activation plugin (which bundles the channel MCP at
[`../../agent-plugins/agentmonitors/.mcp.json`](../../agent-plugins/agentmonitors/.mcp.json)) — that
path is gated on a channels-enabled org.
