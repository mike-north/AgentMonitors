---
'@agentmonitors/core': patch
---

Fix: rollup not-due window flush now applies `net` baseline strategy and records audit history

A `notify.strategy: rollup` monitor flushes its accumulated batch through two paths in the runtime
tick. The **due** path (source poll interval elapsed) routes through `ingest()`, which applies the
`baseline-strategy: net` collapse (002 §1.1.7) and records a `triggered` `observation_history` row
(002 §10.7). The **not-due** path — the window fires on a tick where the source interval has _not_
elapsed, which is the _normal_ operating mode for a rollup monitor with `watch.interval` relaxed to
match the delivery window (002 §4.4) — was a separate, drifted re-implementation that did neither.

Effect of the bug: a `rollup` + `net` daily-digest monitor delivered the full play-by-play (N
events) instead of one net delta on every windowed flush, and the delivery was invisible to the
audit trail (`monitor explain` / `agentmonitors … history` reported "nothing triggered").

Both paths now route through a single shared span-materialization helper, so the `net` collapse and
the `triggered` audit row are applied identically and can never drift again. `incremental` (default)
behavior, the once-per-minute window guard, and the due-path behavior are unchanged.
