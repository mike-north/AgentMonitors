## 2026-07-21 — Every public surface consistently describes the no-`--event-ids`/no-`event_ids` ack as excluding ALL currently leased rows, plural (005 §11.2, 006 §4.3) — Refs #438, #434, PR #445 review round 12

Round 10 added the leased-row exception to `acknowledgeSession`'s default "ack everything unread"
path, but the shipped wording across the CLI's `--event-ids` help, the `agentmon_ack` MCP tool
description (`channel-ack.ts`'s `ACK_TOOL`), `channel serve`'s server `instructions`, and the public
005/006 docs and website pages said "except **one** row" / "**a** row" — singular. That undersells
the actual behavior: `AgentMonitorRuntime.acknowledgeSession`'s exclusion set comes from
`reservedEventIds(sessionId)`, which returns every candidate held by every live reservation for the
session, so more than one row can be excluded from a single no-argument ack at once (e.g. two
concurrent channel pushes each mid-surfacing a different event). `channel serve`'s advertised MCP
server `instructions` previously omitted the exception entirely, telling a channel-connected agent
that the no-argument form acknowledges all unread with no carve-out.

Corrected every surface that described this exception (or omitted it) to describe **all currently
leased rows** rather than a single row: `service.ts`'s `acknowledgeSession` doc comment,
`channel-ack.ts`'s `ACK_TOOL` description and `AckArgs` doc comment, `commands/events.ts`'s
`--event-ids` help text, `commands/channel.ts`'s MCP server `instructions`, 005 §11.2's `events ack`
exception paragraph and the `channel serve` behavior note, 006 §4.3's example tool schema, and the
website's CLI reference and agent-integration capability table (with a footnote pointing at the
exception).

