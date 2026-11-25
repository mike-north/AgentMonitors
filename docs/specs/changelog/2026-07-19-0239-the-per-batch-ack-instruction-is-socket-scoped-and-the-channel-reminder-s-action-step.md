## 2026-07-19 — The per-batch ack instruction is socket-scoped, and the channel reminder's action step no longer offers a blanket-ack shortcut (002 §9.2, 006 §5.1.1) — Refs #438, #434, PR #445 review round 2

Two more follow-on defects found on round 2 of reviewing the same change, both in the same
delivered-instruction-text family as round 1 (below).

**1. The high/recap ack instruction omitted `--socket` (BLOCKER).** Round 1 fixed the reminder action
step's `events list`/`events ack` recovery commands to carry an explicit `--socket <path>` (finding 3,
below) but left the SEPARATE per-batch ack instruction — `When handled, acknowledge: agentmonitors
events ack --session <id> --event-ids <id1>,<id2>` — socket-less, reasoning it was "merely advisory."
But `agentmonitors events ack` resolves its daemon socket env-first
(`resolveManualDaemonSocketPath`, issue #335), the identical class of bug issue #358 already
identified for the truncation-recovery markers: a copy-pasted ack run under a stale
`$AGENTMONITORS_SOCKET` silently scopes the acknowledge to the WRONG daemon, leaving the real
session's events unread and unmuted while the recipient believes it acknowledged them. Resolved by
threading the same resolved `socketPath` already carried by every other marker in the hook transport
into the ack instruction too: `agentmonitors events ack --session <id> --socket <path> --event-ids
<id1>,<id2>`.

**2. The channel reminder's action step offered `agentmon_ack` as an "OR" alternative to inspecting
details, not a prerequisite (BLOCKER).** The prior wording — "Call the agentmon_ack tool, or run
`events list` ... for details." — reads as two independent, equally valid paths. But `agentmon_ack`
called with no `event_ids` acknowledges EVERY unread event for the session across every urgency band
(`channel-ack.ts`'s `ACK_TOOL`/`parseAckArgs`: omitting `event_ids` means "all unread") — the exact
blanket-ack shape finding 1 of round 1 already fixed for the hook transport's per-batch instruction. The
most literal reading of the "or" phrasing — call `agentmon_ack` bare, with no arguments — silently
acknowledges unseen, cross-band work the recipient never inspected (e.g. a `low`-urgency reminder's
bare ack call also clears unread `high`-urgency events). Resolved by sequencing the two steps instead
of presenting them as alternatives: list this session's unread events FIRST, THEN call `agentmon_ack`
naming only the `event_id` values of the ones actually handled — never the bare, no-argument form.

Updated 002 §9.2 (clarified that neither reminder action step is id-scoped, and how each transport's
step differs) and 006 §5.1.1 (socket-scoped ack instruction; corrected channel reminder wording,
inspection as a prerequisite not an alternative).

