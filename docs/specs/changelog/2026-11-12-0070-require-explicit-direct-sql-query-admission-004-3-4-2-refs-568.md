## 2026-11-12 — Require explicit direct-SQL query admission (004 §3.4.2) — Refs #568

Direct `exec()` and native `pragma()` calls now require a named query-PRAGMA allowlist,
no assignment and driver read-only metadata. Other PRAGMAs and direct maintenance
statements are refused even when SQLite reports `readonly=true`: a single-table
`optimize` can persist statistics under that flag. Tick/watch regressions exercise
both optimizer entrypoints, unknown and setting PRAGMAs, maintenance and admitted
queries. Published runtime behavior is unchanged.

