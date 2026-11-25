## 2026-11-12 — Hold-acceptance refusals under span admission (002 §4.7, §`observation_history`, 004 §3.3) — Refs #570, #497

Restate §4.7 on span admission (§2). A refusal's `errored` row is written inside the span's
admission transaction, before the batch row, together with the state write that advances the
baseline past it; a rollback undoes both, and nothing is reported for it. The refusal is reported
(tick `erroredObservations`, watcher `onError`) only after that transaction commits and the span
has materialized, and a throwing callback is ignored. A refusal is not a drop: it carries no drop
identity, is not outstanding loss, and never sets `notRetainedCount`; the batch row counts
`notHeld` and `notRetainedCount` separately. Name the paths into a hold: poll and watch span
admission, the deferred poll handoff and escalation. An edit drain, startup reconciliation and a
not-due rollup window check add no envelope to a hold.

