## 2026-07-12 — 006 §6.1: "Operating without MCP" formalized and proven (006 §6.1, §9) — Refs #270

NP-CH (006 §2) already asserted that channels must be additive, never a dependency, but the hooks-only
mode itself was not named, and the claim that hooks + CLI form a _complete_ substitute for the
`agentmon_ack` MCP tool was undemonstrated. Added §6.1 "Operating without MCP", marked **current**,
stating the guarantee in one paragraph and pointing at the new proof:

- `apps/cli/src/commands/cli.integration.test.ts` — describe block `hooks-only delivery parity
(issue #270)` drives the full lifecycle (daemon boot via `session start`, monitor fire, delivery
  claim via `hook deliver`, acknowledgement via `events ack`, confirmation via `events list`), each
  step fed a real Claude Code hook stdin payload, with zero import/start/reference of the
  channel/MCP code path (`apps/cli/src/commands/channel.ts`).
- `apps/cli/src/commands/channel-hooks-ipc-parity.test.ts` — a separate static check (never imports
  or executes `channel.ts`; reads its source text only) confirming the `agentmon_ack` tool handler
  and the channel's outbound push route through the identical daemon-IPC client functions
  (`acknowledgeEventsClient`, `claimDeliveryClient`) that the hooks-only `events ack`/`hook deliver`
  CLI commands already call — the structural basis for the capability-parity claim.

§9 (Validation Implications) gained a matching bullet for the new proof. No behavior changed; this
is documentation + test coverage of an existing invariant (NP-CH), not a new capability.

