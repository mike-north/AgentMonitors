## 2026-07-18 — Snapshots ordered deterministically under second-resolution timestamp ties (002 §5.2, §15) — Refs #293

`monitor_snapshots.created_at` is stored at epoch-**second** precision, so several snapshots for one
`(workspace_path, monitor_id, object_key)` written in the same second (an ordinary same-tick burst)
tie on `created_at`. `latestSnapshot()` previously ordered ONLY by `created_at DESC` and could
return the **oldest** tied row as "latest", corrupting the shared diff chain — a direct `v1, v2, v3`
reproduction returned `v1`. This is the same ordering problem `monitor_events` already solved with a
monotonic ULID.

- **§5.2 — snapshots now have a total materialization order.** The runtime MUST resolve "the latest
  stored snapshot" to the **most recently materialized** row under identical timestamps. Satisfied by
  a monotonic ULID snapshot `id` (strictly increasing in insertion order) and `ORDER BY created_at
DESC, id DESC` — the `(created_at, id)` tie-break the events table already uses. No schema
  migration: `id` was already a ULID column; only its generator and the query's secondary sort key
  changed.
- **§15 `monitor_snapshots`** appendix row annotated: `id` is a monotonic ULID; `created_at` is
  epoch seconds with ties broken by `id`.
- **User-visible newest-first listings** that sort by second-precision `created_at` — `events list` /
  `monitor explain` event rows and the observation-history audit trail — apply the same `id`
  tie-break so their within-second order is stable (observation-history `id` also switched to a
  monotonic ULID for this).

This is a clarification + correctness fix; the intended contract (newest snapshot is the diff
predecessor) was always implied by §5.2 but not stated, and the implementation violated it under
ties.

