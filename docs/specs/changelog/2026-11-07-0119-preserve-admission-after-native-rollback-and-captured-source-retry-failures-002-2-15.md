## 2026-11-07 — Preserve admission after native rollback and captured-source retry failures (002 §2/§15; 004 §3.4) — Refs #497

Distinguish savepoint-local ABORT from SQLite ending the owning admission transaction. Rethrow the
original materialization error before fallback retry/checkpoint writes when the native transaction
is no longer active, preserving the complete replay baseline, held work and prior committed rows/cache.
Require real later-sibling rollback tests with fresh and held spans, a nonempty prior recipient cache,
forced-due reopen replay, and an ABORT suffix-retention control. Route retries for old debounce/rollup
envelopes through their captured source after a source-type edit; preserve captured instructions,
urgency, content and timestamps without transforming the source baseline. Transaction ownership
remains package-private and the published API is unchanged.

