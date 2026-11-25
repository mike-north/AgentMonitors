## 2026-07-18 — A mid-truncated single oversized channel event no longer claims a later-poll re-delivery it cannot make (006 §5.5) — Refs #442

Corrects a false recovery-path claim introduced by the round-4 fix directly below. When a single
event's own block exceeds the ceiling even alone, `renderChannelEvent` mid-truncates it and appends a
marker to signpost the omission — but by the time that render runs, `runChannelDeliveryCycle` has
already reserved and is about to COMMIT the claim (`first_notified_at` gets set on success). Because
`pendingEventsForSession()` only returns rows whose `first_notified_at` is still `NULL` (002 §7), that
committed row can never appear in a later poll's settled-high preview again — the omitted tail does
NOT "surface on a later poll," contradicting what `CHANNEL_DEFERRED_MARKER` told the agent.

- **Two distinct markers now exist**, disambiguating two different situations that were previously
  conflated under one string:
  - `CHANNEL_DEFERRED_MARKER` — unchanged: appended when some settled-high events were left OUT of
    this claim entirely (never reserved). Those rows genuinely stay pending and re-deliver on a later
    poll.
  - `CHANNEL_TRUNCATED_MARKER` — new: appended only in the single-event mid-truncation branch, where
    the event IS committed by this cycle. It points at the durable, still-unread copy of the full body
    (`agentmonitors events list --unread`) instead of promising a re-delivery that cannot happen —
    claiming a delivery never acknowledges it (BP2 / SP4), so the full body remains recoverable there.
- No change to reserve/commit/release semantics, the ceiling itself (`MAX_CHANNEL_CONTENT`), or the
  packing behavior for the multi-event deferral case.

