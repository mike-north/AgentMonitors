---
'@agentmonitors/core': minor
---

Rewire `net` collapse and Interpret onto the per-recipient seam (roadmap G10 PR-B, 002 §1.1.7/§1.1.8)

The `net` baseline collapse and the Interpret stage now span **per recipient** off each recipient's
own baseline cursor, completing the right-of-seam stages of the post-processing pipeline (G10
complete).

- **`net` is a per-recipient decision at claim time.** The shared `monitor_events` chain now records
  **every** observation in order, regardless of `baseline-strategy` (the incremental substrate). When
  a recipient claims its unclaimed catch-up span, a `net` monitor delivers only the **newest** event
  per `objectKey` — its delta recomputed against that recipient's cursor → endpoint — and records the
  older intermediates **claimed-but-suppressed**: retained and explainable via `monitor explain`,
  excluded from delivery, never a silent drop. `incremental` (default) delivers all in order. So a
  recipient that was away across several separate windows now gets the correct single net delta against
  **its own** baseline, where before it got one row per window.

- **Interpret runs once per distinct per-recipient delta.** Two recipients at divergent baselines
  invoke the user's AI tool twice (one per distinct delta, verdict recorded per session); identical
  baselines invoke it once and fan the verdict.

- **Public types.** `MonitorEventRecord` gains `baselineStrategy` and `MonitorDeliveryProjection`
  gains an optional `netSuppressed` flag. New durable columns (`monitor_events.baseline_strategy`,
  `session_event_state.net_suppressed_at`) migrate additively; legacy rows are treated as
  `incremental` / never-suppressed.

Backward compatible: a `net` monitor with a single (or co-registered, never-missing) session behaves
exactly as before — `net` ≡ `incremental` in the degenerate single-observation span. The shared event
chain keeping every intermediate is the only externally-visible change (`events list` shows N rows for
a `net` catch-up span; the per-recipient delivery still collapses to one).
