## 2026-11-01 — CLI retained-work diagnostics across IPC and definition failures (002, 004, 005) — Refs #496

Adopt optional orphan groups alongside current-monitor summaries in doctor text/JSON. Preserve
original definition errors while adding failing retained-work checks and actionable record IDs.
Reconstruct all retry Dates through real socket clients and normalize legacy error controls/length
while projecting only safe metadata. Older daemons may omit both attached summaries and orphan
groups. Explain retains retry-only fallback reports. Tests use actual JSONL sockets, the built CLI,
and legacy SQLite rows to verify metadata privacy, exactly-once scope, and diagnostic nonmutation.
Remediation does not claim an available retry command or automatic retry adoption.

