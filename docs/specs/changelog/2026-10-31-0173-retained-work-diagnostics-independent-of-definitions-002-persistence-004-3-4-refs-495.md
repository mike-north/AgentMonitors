## 2026-10-31 — Retained-work diagnostics independent of definitions (002 persistence, 004 §3.4) — Refs #495

Require retry metadata in every core explain outcome, preserving the actual definition/scheduling
failure. Doctor keeps outboxes without unambiguous parsed definitions in explicit orphan groups,
including duplicate ids, without inventing current monitor metadata. Specify exact workspace scope,
metadata-only discovery beyond the per-monitor row bound, deterministic ordering, private-envelope
exclusion and read-only behavior. Normalize legacy failure text at the diagnostic projection without
rewriting stored evidence. CLI/socket adoption, including orphan date revival, remains #496.

