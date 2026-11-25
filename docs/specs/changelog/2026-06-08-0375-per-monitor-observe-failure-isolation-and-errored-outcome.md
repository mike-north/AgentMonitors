## 2026-06-08 — Per-monitor `observe()` failure isolation and `errored` outcome

- The runtime now **isolates per-monitor failures in `tick()`**: if a source's `observe()` throws
  or rejects, the failure is caught, an `errored` observation-history row is recorded, and the tick
  continues to the next due monitor. A single buggy source can no longer abort the entire tick and
  starve all other monitors ([002 §`observation_history`](../002-runtime-delivery.md)).
- The same isolation is applied to the **watch path** (`consumeWatch()`): an `ingest()` failure on
  one yielded observation records an `errored` history row and the watcher continues consuming
  subsequent observations. The outer catch (for errors from the async iterator itself) is unchanged.
- **State preservation on failure**: `ingest()` is not called for a failing monitor, which means
  `setMonitorState()` is never reached. The persisted `sourceState` is left exactly as it was after
  the last successful tick, so the next tick's diff spans from the last good baseline rather than
  from an empty state — no subsequent delta is dropped.
- **New `ObservationOutcome` member**: `'errored'` is added to the
  `ObservationOutcome` union (`libs/core/src/runtime/types.ts`) and the drizzle enum in
  `libs/core/src/inbox/schema.ts`. The raw SQL in `libs/core/src/inbox/db.ts` uses `result TEXT NOT
NULL` with no CHECK constraint and needed no change.
- Minor `@agentmonitors/core` changeset (new public `ObservationOutcome` member + runtime guarantee).
- Issue: [#46](https://github.com/mike-north/AgentMonitors/issues/46).

