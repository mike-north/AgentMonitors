## 2026-11-12 — Real-process ingress kill/fault acceptance (004 §3.4.2) — Refs #568

Require real bundled CLI processes, on-disk SQLite, loopback `api-poll` input and filesystem-backed
watch ingestion under immediate, debounce and rollup pacing. Driver discovery enumerates SQL
write occurrences during acceptance, held release, retry admission and retry drain; each is
faulted before execution and killed after execution, with restart assertions for exactly-once
ordered events, complete persistence and unread recipient projections. Fixed clocks and event
barriers replace synchronization sleeps, and cleanup confirms owned-process termination.

The file source has no shipped `watch()` yet, so the fixture explicitly adds a test-only native
filesystem watcher around its real observation implementation. Watch faults use their existing
`onError` surface; tick faults use `erroredObservations`. Extra audit-write cases preserve the
existing best-effort contract. Discovery covers executed paths, not all possible plugin branches;
existing invalid-envelope, capacity/loss and policy-edit regressions remain required. Retry
re-arm/skip cases are a linked TODO for #584 and do not block this suite.
The manual socket regression also checks the canonical resolved socket, with an explicit
overlong data root, so an isolated verification home exercises the existing fallback contract
instead of failing on an unnormalized test expectation. Published behavior is unchanged.

