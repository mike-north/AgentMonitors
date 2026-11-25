## 2026-07-15 — `channel serve` resolves the per-workspace socket `session start` binds, ahead of a stale `AGENTMONITORS_SOCKET` (006 §4.1, 005 §13) — Refs #358

`channel serve` — the MCP server the `agentmonitors` plugin's `.mcp.json` spawns with no
flags — previously resolved its daemon socket directly (explicit `--socket` → `AGENTMONITORS_SOCKET`
→ the bare global default), never consulting an **enabled** workspace's persisted-or-derived
per-workspace socket the way every other workspace-aware command does
(`resolveManualDaemonSocketPath`, issue #335). So a `channel serve` process spawned exactly as the
plugin spawns it silently talked to a socket with no daemon listening, for the only supported
activation flow — the channel transport never pushed, though hook-state delivery (§3/§5) was
unaffected.

Fixed by giving `channel serve` its own socket resolution (`resolveChannelSocketPath` in
`apps/cli/src/commands/channel.ts`), **deliberately different** from `resolveManualDaemonSocketPath`:
an explicit `--socket` still wins outright, but an **enabled** workspace's persisted-or-derived
per-workspace socket now wins over `AGENTMONITORS_SOCKET` too — not just over the bare global
default. This is intentionally not the same precedence as the manually-typed `session`/`events`/
`hook`/`daemon` commands (where an explicitly-set env var is a deliberate interactive override and
correctly wins): `channel serve` has no interactive moment, so a stale `AGENTMONITORS_SOCKET` left
over from a different workspace must never win over the current, enabled workspace's own socket —
letting it do so would cross-connect the channel to another workspace's daemon (a session-isolation
break) or reproduce this issue's dead-socket symptom. A not-enabled workspace is unaffected: it still
falls back to `AGENTMONITORS_SOCKET`, then the global default, exactly as before. This mirrors the
isolation guarantee `hook deliver` already enforces (005 §12) by refusing to fall back past an
enabled workspace's own socket at all.

- **006 §4.1 — current.** The channel-server mechanism bullets now document the corrected,
  channel-serve-specific precedence (workspace socket before `AGENTMONITORS_SOCKET`) and why it
  differs from `resolveManualDaemonSocketPath`.
- **005 §13 — current.** `channel serve`'s `--socket` flag documentation and `--help` text now match
  the actual (fixed) resolution order, including the isolation rationale.
- **docs/uat/channel-transport.md** — the known-issue callout is updated to reflect the fix; step
  3's pre-seed workaround remains documented (harmless to keep) per the recipe's own guidance.

