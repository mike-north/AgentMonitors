## 2026-08-13 — Event materialization is one atomic durable unit (002 §5, 004 §3.4) — Refs #295, #481

The shared event row, matching lead-session projections, first-recipient cursor seeds, and snapshot
now commit in one immediate SQLite transaction. A failure at any write rolls the whole observation
back, so the runtime cannot retain a partial event without its cursor, projection, or snapshot.
Optional Interpret work remains outside this deterministic transaction and begins only after it
commits. Focused failure-injection tests now enforce the rollback boundary.

