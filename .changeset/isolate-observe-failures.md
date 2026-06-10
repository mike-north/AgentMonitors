---
'@agentmonitors/core': minor
---

Isolate per-monitor `observe()` failures in `tick()` and `consumeWatch()`: a source that throws or rejects no longer aborts the entire tick. The failing monitor records an `'errored'` observation-history row, its persisted `sourceState` is preserved (ingest is skipped, so no subsequent delta is dropped), and all other due monitors still run. Adds `'errored'` to the `ObservationOutcome` union.
