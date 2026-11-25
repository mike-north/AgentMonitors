## 2026-11-12 — Verify admitted SQLite reads preserve database files (004 §3.4.2) — Refs #568

Prepared statements now apply query admission at execution, including pre-existing
handles and iterator advancement/finalization. Table-valued PRAGMAs outside the
query allowlist are refused inside SELECTs. Every admitted read compares complete
main-file/WAL bytes around synchronous execution; unexpected effects fail with
SQL and call-site diagnostics. Same-size overwrite regressions exercise every
entrypoint, and a separate-process WAL reader verifies the fixture ownership and
reader-lock boundary. Published runtime behavior is unchanged.

