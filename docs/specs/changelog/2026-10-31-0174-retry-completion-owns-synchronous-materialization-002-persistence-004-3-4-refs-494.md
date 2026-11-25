## 2026-10-31 — Retry completion owns synchronous materialization (002 persistence, 004 §3.4) — Refs #494

Replace the generic completion callback with concrete event data so asynchronous caller work cannot
escape the transaction. Require pending state and matching observation route before writes; atomically
commit event/projections/cursors/snapshot plus retry removal and preserve the projection cache on rollback.
Document typed missing-identity/invalid-transition errors, single-line failure updates, and upward-rounded
second-resolution deadlines. Tests reproduce terminal bypass, callback escape, early due admission and
unsafe Unicode separators, then verify real database faults and on-disk lifecycle recovery. A runtime-backed
regression also requires completion to honor the normal monitor-ID fallback for omitted object keys
while preserving explicit keys, including the empty string.

