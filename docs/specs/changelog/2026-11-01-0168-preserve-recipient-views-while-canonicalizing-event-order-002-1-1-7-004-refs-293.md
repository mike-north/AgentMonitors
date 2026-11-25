## 2026-11-01 — Preserve recipient views while canonicalizing event order (002 §1.1.7, 004) — Refs #293

The event-order boundary retains raw shared input representation and refreshes explicit
non-shared delta views from the requested session projection. Optional lifecycle state
is refreshed independently: its presence does not change a shared diff into a recipient
delta. Incremental and single-net results preserve
recipient deltas/lifecycle state; stale deltas after re-anchoring no longer fall back to
shared history. Supplied text and another recipient's state never become authoritative.
Tests first reproduced view loss and stale-delta fallback, then verify both raw and
recipient representations. Immutable event ordering/artifacts remain database-owned.

