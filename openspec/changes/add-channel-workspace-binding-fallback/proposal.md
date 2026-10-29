## Why

The channel transport binds only by the inherited `CLAUDE_CODE_SESSION_ID`. That variable is observed
but **not** part of Claude Code's documented MCP environment contract (the MCP reference documents only
`CLAUDE_PROJECT_DIR` and `roots/list`), so a future host version that stops setting it would leave
`channel serve` connected but permanently silent (today it logs to stderr and does not poll). The spec
already names the robustness hedge: fall back to binding by the documented workspace signals, and
degrade safely — never claim on behalf of an ambiguous session — when the workspace has more than one
lead session.

Source: 006 §4.4 (binding strategy item 2, "Single-lead-session assumption"), 006 §9 (validation
bullet on workspace binding), 006 §10 (resolved binding questions and the open synthetic-session
question). No GitHub issue is filed for the fallback yet.

## What Changes

- When no host session id is available, `channel serve` resolves the workspace `W` from
  `CLAUDE_PROJECT_DIR` (or MCP `roots/list`) and binds to the lead session(s) projected for `W`.
- With exactly one active lead in `W`, workspace binding behaves exactly like session binding.
- With multiple concurrent leads in `W`, the channel surfaces the workspace's unread but never claims on
  behalf of an ambiguous session; the per-session hook transport remains the accurate surface.
- Session binding (`CLAUDE_CODE_SESSION_ID`) stays the preferred path whenever it is present.

Principles: relies on PP4 (session-aware delivery), BP2 (claim ≠ ack), PP1 (no event loss), NP-CH
(channel stays additive). Does not resolve an existing contradiction; it hardens an
observed-not-contracted dependency.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `delivery/channel-transport`: adds workspace-binding fallback and multi-lead degradation
  requirements; the existing "Channel without a host session id does not poll" requirement is
  replaced by the fallback.

## Impact

- `apps/cli/src/commands/channel.ts` (binding, poll loop), daemon IPC for listing a workspace's lead
  sessions and a non-claiming unread read (`daemon/ipc`), `apps/cli/src/channel-render.ts` (a
  surface-only render for the ambiguous case).
- Published behavior of `@agentmonitors/cli` changes → changeset.
- `apps/website` channel docs.
