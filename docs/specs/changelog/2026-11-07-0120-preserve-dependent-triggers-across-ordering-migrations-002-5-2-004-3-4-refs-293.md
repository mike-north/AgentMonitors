## 2026-11-07 — Preserve dependent triggers across ordering migrations (002 §5.2, 004 §3.4) — Refs #293

Coordinate event and snapshot sequence rebuilds within their existing immediate
transaction. Suspend retained main-schema triggers across the pair and restore their
exact SQL only after both table names exist, including cross-table and third-table
dependencies. Preserve rows, logical references, indexes, public IDs, connection pragmas
and ordering policies. Already-current opens leave trigger definitions untouched.
Tests first reproduce both directions, quoted names and partial migrations; controls
and native DDL failures verify behavior, no replay, idempotence and complete rollback.

