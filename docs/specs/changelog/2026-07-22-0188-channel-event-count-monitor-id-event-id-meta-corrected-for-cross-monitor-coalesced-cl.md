## 2026-07-22 — Channel `event_count`/`monitor_id`/`event_id` meta corrected for cross-monitor-coalesced claims (006 §4.2) — Refs #441, #456

For a `DeliveryClaim` with `coalescedReminder` set (issue #441 cross-monitor coalescing), the channel
renderer's single-event routing branch (`claim.events.length === 1`) previously still fired,
reporting `monitor_id`/`event_id` for that one surfaced high event and an `event_count` of `1` —
under-reporting the actual claimed set, which also includes the coalesced normal-urgency rows
`claimDelivery` claims alongside it. An MCP consumer following the "call `agentmon_ack` with their
`event_id` values" contract would scope its ack to that single event, leaving the coalesced normal
rows claimed-but-unacknowledged and durably muting the session's normal reminders (002 §9.2's
`normalPending.length === unreadNormal.length` gate never re-fires while they sit claimed). A new
`DeliveryClaim.coalescedNormalCount` field records how many normal rows were folded in; the channel
renderer now gates per-event routing on `claim.events.length === 1 && !claim.coalescedReminder`, and
reports `event_count` as `events.length + coalescedNormalCount` whenever `coalescedReminder` is
present. The hook-deliver transport has no equivalent meta/debug surface, so the same trap does not
exist there. §4.2's meta table now documents both corrections.

