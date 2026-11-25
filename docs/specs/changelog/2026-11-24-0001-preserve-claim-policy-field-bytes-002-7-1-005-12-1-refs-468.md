## 2026-11-24 — Preserve claim policy field bytes (002 §7.1, 005 §12.1) — Refs #468

Coordination rewrites now retain the complete `claim-ttl-ms` field line, including indentation,
separator whitespace and trailing spaces/tabs. Trimming and interpretation occur only when runtime
composition applies policy. Other coordination fields retain their normalization. Local-state and
built-CLI lifecycle regressions assert exact field-line preservation.

