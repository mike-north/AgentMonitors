---
'@agentmonitors/core': minor
---

Add the scheduled-rollup Pace mode (`notify.strategy: rollup`)

A third notify strategy alongside `debounce` and `throttle`. A `rollup` monitor declares a required five-field cron `window` (and an optional IANA `timezone`, default `UTC`); the runtime accumulates every observation into a durable batch held in `monitor_state.notify_state` and delivers nothing between windows. On each tick it evaluates the `window` cron and, when the window fires with a non-empty batch, flushes the whole accumulation as a single composite delivery (one `monitor_events` row per accumulated observation) and clears the batch. An empty window produces no delivery. The accumulated batch survives a daemon restart.

`agentmonitors validate` accepts a `rollup` monitor with a `window` and rejects `strategy: rollup` missing `window`. Public API additions: `PendingRollupState` (exported) and the `rollup` member of `NotifyStrategy`. See docs/specs/001 §3.6 and 002 §4.4–§4.5.
