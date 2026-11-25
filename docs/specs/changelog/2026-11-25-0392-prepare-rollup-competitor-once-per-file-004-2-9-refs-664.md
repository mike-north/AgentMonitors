## 2026-11-25 — Prepare the rollup competitor once per file (004 §2.9) — Refs #664

The rollup admission suite compiles its private competitor fixture and current core source once
before its cases. Each competing process executes the resulting JavaScript against real SQLite.
The subprocess bound stays at 15 seconds, nested within each competing case's explicit budget;
compilation has a separate hook budget. This fixture-only preparation leaves package build
ownership and shared output directories unchanged. Existing admission assertions and the
four-concurrent-copy, 50-round load check validate the boundary.

