## 2026-11-03 — Bound monitor and daemon inputs before validation (001, 002, 005) — Refs #530

Specify monitor byte/tag/derive limits and daemon byte/collection/depth/aggregate
budgets. Reject before element validation or runtime mutation with a bounded,
machine-classified error; preserve ordinary validation and session isolation.
Raw-socket tests against a spawned daemon cover unterminated and fragmented input,
valid boundaries, liveness, and unchanged sessions. These guards do not remediate
SDK Zod v3 compatibility code or replace dependency upgrades.

