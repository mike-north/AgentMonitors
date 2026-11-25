## 2026-06-01 — Channel transport, stage 2 (two-way ack)

- `agentmonitors channel serve` is now two-way: it declares `capabilities.tools` and exposes the
  **`agentmon_ack`** tool (`apps/cli/src/channel-ack.ts`), which routes through `events.ack` for the
  bound session — the bound session id is the "outbound gate" (006 §4.3). Tool arguments are
  validated defensively at the MCP boundary (`parseAckArgs`, unit-tested). Session resolution is
  shared between the poll loop and the ack tool. Marked [006 §4.3](../006-agent-integration.md)
  implemented; updated roadmap G7 (remaining: plugin packaging + manual UAT). CLI-only; no changeset.

