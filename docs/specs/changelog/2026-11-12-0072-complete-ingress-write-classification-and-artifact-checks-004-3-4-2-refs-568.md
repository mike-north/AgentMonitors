## 2026-11-12 — Complete ingress write classification and artifact checks (004 §3.4.2) — Refs #568

Interruption discovery now observes the full asynchronous tick and watch-consumption
lifecycles. Writes outside the admission inventory must match a named setup, exact
maintenance or injected-fault diagnostic exclusion; otherwise the suite fails with SQL
and call-site evidence. Shared snapshots are checked against source values and exact
workspace/monitor/object/event identities, and recipient cursors against baseline contents,
provenance and session identity. Extra acquisition writes, corrupted snapshot contents and
corrupted cursor baselines must fail acceptance. Retry re-arm/skip interruptions remain
tracked separately as #615.

