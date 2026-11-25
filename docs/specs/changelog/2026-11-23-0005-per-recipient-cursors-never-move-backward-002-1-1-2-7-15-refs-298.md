## 2026-11-23 — Per-recipient cursors never move backward (002 §1.1.2, §7, §15) — Refs #298

A claim advanced the recipient's object cursor to the newest event in that claim, even when an
earlier claim had already surfaced a newer event (a `high` event claimed at `turn-interruptible`
before an older `normal` one at idle, or a recap of older unread rows). The cursor then moved
backward and the next delta replayed changes the recipient had already seen. 002 §1.1.2 now states
that a cursor moves only to an event later in the stable event order (`created_at`, then
`monitor_events.sequence`). The cursor stores that position in two additive columns (§15), filled on
upgrade from its baseline event and re-read from that event before each comparison while it is
retained. 002 §7 now states that `firstNotifiedAt` keeps the first claim time;
a repeat claim updates only the last-claim fields.

