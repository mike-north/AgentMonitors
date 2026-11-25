## 2026-11-12 — Require environment-only restart ownership (008 §4.2; 004 §3.5.1a) — Refs #478

Only actual inherited environment evidence may authorize command cleanup. The macOS system
reader cannot distinguish argv from environment, so it records same-user PID abstentions and
leaves them untouched; automatic cleanup is currently available on Linux. Ownership queries
request only the supplied PIDs, with no host-wide environment scan at signal time. A matching
zombie/dead owner no longer counts as live or protects a cleanup anchor; unavailable owner
terminal evidence produces an abstention. Regressions cover argv-only nonces, zombie owners,
PID-scoped queries and a bounded scan count with 100 survivors. Unchanged ownership uncertainty is recorded once, and a pass with no signals does not rescan it.
Linux cleanup and macOS abstentions are asserted separately without extending readiness or command deadlines.

