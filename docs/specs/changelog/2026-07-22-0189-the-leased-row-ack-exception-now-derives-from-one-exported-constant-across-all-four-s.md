## 2026-07-22 — The leased-row ack exception now derives from one exported constant across all four surfaces (006 §4.3) — Refs #438, #434, PR #445 review round 14

Round 13 (below) made the ack tool result text, `ACK_TOOL`'s description, and its `event_ids` schema
hint consistent, and added a parity test pinning them to a shared substring. It missed a fourth,
independent literal describing the same exception: `channel serve`'s own MCP `instructions` string
(`commands/channel.ts`, `runChannelServe`), which is what a channel-connected agent actually reads
before ever calling the tool.

`channel-ack.ts` now exports `LEASED_ROW_EXCEPTION`, the single wording for the "in-flight delivery
lease" carve-out; `buildAckResultText`, `ACK_TOOL.description`, `ACK_TOOL.inputSchema.properties
.event_ids.description`, and `commands/channel.ts`'s exported `CHANNEL_SERVER_INSTRUCTIONS` all
interpolate it rather than each spelling out its own copy, so the four can no longer drift the way
the schema hint once did. Updated 006 §4.3's example tool schema to match the unified wording. The
parity test in `channel-ack.test.ts` now asserts all four surfaces against the exported constant
directly, including the channel server's `instructions`.

