## 2026-11-12 — Retained work drains before newer source input; retry recipients ordered by registration position (002 §2/§2.4/§2.5/§2.6/§2.7/§4.6/§15; 004 §3.4; 005) — Refs #567

Add 002 §2.7. Work the runtime accepted but has not materialized now completes before its monitor
accepts anything newer. Each tick drains the monitor's retry outbox, oldest admission first, after
the source-config preflight and before edit reconciliation, deferred poll results, rollup window
flushes and `observe()`. A watcher drains before its first pull and after each batch; at startup,
retained work it cannot drain keeps its admission gate closed until a tick drains it. While any row
remains the monitor pauses: a failed attempt is reported with an `errored` history row and a tick
`erroredObservations` entry, a backing-off row as a `skippedMonitors` entry at its next attempt, and
a terminal row on every tick until it is re-armed. Held notify work waits behind retained work,
because such a hold is always newer: ordering takes precedence over the timeliness of held work.
That includes the held flush on a tick whose source call fails (§2.6): the drain runs first and a
monitor with retained work does not call its source, so that flush never runs ahead of a pending,
failing or terminal retry, and a terminal retry keeps the hold held until it is re-armed. §2.6
states the same order from its side, and 004 §3.4 lists the regression. A span is therefore only
admitted into an empty outbox. Sessions now reserve a position in the
materialization order when first registered (`agent_sessions.registration_sequence`, additive
migration), and a completed retry projects only into sessions positioned before its admission,
so a session opened in the same second is still ordered correctly. Rows written before positions
existed fall back as described in §2.7. Previously a retry waited on its backoff while newer input
was admitted ahead of it, and a late retry projected into every matching session.
A watcher that has just reported a failed attempt waits for the row's persisted next attempt, or for the first retry delay when the failure could not be recorded, so a row left due is never re-attempted in a tight loop (008 §8).

