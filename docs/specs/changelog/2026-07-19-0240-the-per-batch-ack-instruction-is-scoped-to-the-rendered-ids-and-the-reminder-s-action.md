## 2026-07-19 — The per-batch ack instruction is scoped to the rendered ids, and the reminder's action step is transport-owned (002 §9.2, 006 §5.1.1/§4.2.1) — Refs #438, #434, PR #445 review

Two follow-on defects found reviewing the change directly above, both re-introducing the
event-loss-during-batching class this project's review priorities rank first, via instruction text
rather than code.

**1. The per-batch ack instruction was a blanket "ack everything unread" (BLOCKER).** `agentmonitors
events ack --session <id>` with no `--event-ids` acknowledges EVERY unread event for the session,
across every urgency band — but a capped `high`-urgency delivery genuinely defers events beyond the
4000-char cap (they stay pending and re-deliver next context event, 006 §5.5), and a `post-compact`
recap's rendered `events` (up to 10, 002 §9.4) can be a strict subset of the FULL unread set the recap
decision actually claims at commit time. A compliant agent that ran the delivered instruction verbatim
after handling only the rendered batch would silently acknowledge — and thereby permanently drop from
ordinary redelivery — events it never saw.

Resolved by scoping the instruction to exactly the ids THIS render included:
`agentmonitors events ack --session <id> --event-ids <id1>,<id2>` (comma-separated, matching the CLI's
own flag syntax). Because the header's own length now varies with how many ids it names, which
depends on how many blocks fit under it, every sizing path (`packEventsUnderCap`,
`resolveHookClaimFit`, `renderHookDelivery`) resolves the resulting fixed point by iterative narrowing
until the header is self-consistent with what it actually renders. The reminder-only path (a
`normal`/`low` claim) is unaffected: it only ever fires when EVERY unread event of its own band is
unclaimed, so there is no narrower id list within the band to scope to there.

**2. The runtime's reminder message baked in one transport's CLI verb (BLOCKER).** `reminderMessage()`
embedded the concrete `agentmonitors events list`/`events ack` commands directly in the shared,
transport-neutral message — but the channel transport pushes that string verbatim into its
`<channel>` tag body, while a channel-connected agent acknowledges through the `agentmon_ack` MCP tool
(006 §4.3), not the CLI. This put conflicting acknowledge instructions on the channel surface: a
channel agent following the pushed CLI command would fail (no binary/socket), leaving the
coalesced-until-ack mute in place — the exact defect #434 exists to fix, reintroduced on the second
transport.

Resolved at the seam this PR's parent change established: `reminderMessage()` now returns only the
bare semantic fact — `"Monitored changes are pending."` — and each transport appends its OWN concrete
action step. The hook transport names `agentmonitors events list`/`events ack` directly, now with an
explicit `--socket <path>` (see below); the channel transport points at its `agentmon_ack` tool
instead, offering the `events list` recovery command only as a fallback for inspecting detail.

**3. Reminder recovery commands omitted `--socket`, unlike the truncation markers in the same
payload.** The #442 truncation/recovery markers embed the resolved `--socket <path>` specifically
because `events list`/`events ack` resolve their daemon socket env-first and can hit a stale or wrong
daemon; the reminder action step omitted it. Both transports' reminder action steps now carry the same
explicit `--socket <path>` clause.

**4. The channel's reminder branch was the one render path without a content ceiling.** Every other
`channel-render.ts` branch bounds its output at `MAX_CHANNEL_CONTENT` (defense-in-depth since #442);
the reminder branch did not. Latent today (the reminder is short) but now closed for consistency.

Updated 002 §9.2 (message contract + a new note on why the reminder is not id-scoped), 006 §5.1.1
(scoped ack instruction + transport-owned reminder action step) and §4.2.1 (channel's reminder
rendering + ceiling).

