## 2026-07-15 — Add the channel-transport manual UAT recipe (006 §4) — Refs #277

The channel transport's "Status: implemented" note has named an outstanding manual UAT
(channels are research-preview, not CI-able) since it shipped, but no written recipe existed —
"did the channel path regress" depended on whoever remembered how to test it by hand.

- **006 §4 — clarified (current), one-line pointer added.** The UAT-gating note now links
  [`docs/uat/channel-transport.md`](../uat/channel-transport.md), a numbered, copy-runnable recipe
  covering setup, the `<channel>` push and its field schema (§4.2), cross-transport dedup (§4.5),
  in-session acknowledgement via `agentmon_ack` (§4.3) verified through `events list`, and a
  blocked-channel step proving hooks-only delivery with a silent no-op (§6/NP-CH). No behavior
  changed; this is documentation-only.
- **Not a spec change — discovered while grounding the recipe in the real code.** `channel serve`,
  spawned with no `--socket` flag exactly as the plugin's `.mcp.json` spawns it, does not resolve
  the same per-workspace socket a `session start`-lazy-booted daemon binds to for an enabled
  project (it falls back to the stale global-default socket, where nothing is listening), so the
  channel push silently never arrives in the real, unmodified plugin flow. Filed as #358 with a
  confirmed repro and suggested fix; the UAT recipe documents a pre-seed workaround so the rest of
  the recipe (ack, dedup, blocked-channel) remains fully runnable in the meantime.

