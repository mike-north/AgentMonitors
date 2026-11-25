## 2026-11-12 — Classify direct SQLite PRAGMA writes (004 §3.4.2) — Refs #568

Ingress discovery now guards both direct SQL execution and the native PRAGMA entrypoint
using the driver's statement read-only metadata. Writable PRAGMAs must fail with SQL
and call-site diagnostics; read-only queries remain allowed. Direct SQL without a single
preparable statement fails closed rather than admitting an unclassified trailing write.
Independent tick/watch regressions cover both PRAGMA entrypoints and a write-effect
checkpoint PRAGMA without an assignment.

