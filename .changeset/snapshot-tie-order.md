---
'@agentmonitors/core': patch
---

Order snapshots deterministically when second-resolution timestamps tie.

`monitor_snapshots.created_at` is stored at epoch-second precision, so several snapshots for one
`(workspace, monitor, object)` written in the same second all tied on `created_at`.
`latestSnapshot()` ordered only by `created_at DESC` and could return the **oldest** tied snapshot
as "latest", corrupting the shared diff chain (choosing an older predecessor repeats or omits
intermediate changes during bursts). A direct `v1, v2, v3` reproduction returned `v1`.

Snapshots now carry a monotonic ULID `id` (strictly increasing in insertion order), and
`latestSnapshot()` breaks ties with `ORDER BY created_at DESC, id DESC` — the same
`(created_at, id)` tie-break the `monitor_events` table already uses. The observation-history audit
trail and the newest-first event listings (`events list` / `monitor explain`) apply the same `id`
tie-break so their within-second order is stable. No schema migration: `id` was already a ULID
column.
