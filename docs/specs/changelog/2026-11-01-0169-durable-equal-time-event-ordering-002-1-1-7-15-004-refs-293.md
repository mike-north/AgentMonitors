## 2026-11-01 — Durable equal-time event ordering (002 §1.1.7/§15, 004) — Refs #293

Event queries and claimed cursor advancement retain persisted observation time as their
primary order and use a private SQLite AUTOINCREMENT sequence for equal-time ties.
Independent process-local ULID order no longer chooses an older net endpoint. Public
IDs and event shapes are unchanged. The pure collapse decision preserves canonical
query tie order; the mutating boundary reloads authoritative records in that order,
including mixed-urgency concatenations, and rejects unknown/duplicate candidate IDs
before mutation. Legacy migration preserves event fields and logical delivery references.

Tests exercise genuine two-process adverse IDs, preview/capped claim/cursor agreement,
mixed-band candidates, unequal observed times, rollback, migration, maintenance and
concurrent opens. Snapshot materialization order remains a separate sequence; history
and source frontiers are unchanged.

