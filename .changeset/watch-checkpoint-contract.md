---
'@agentmonitors/core': minor
---

Add the watch-mode source-state checkpoint contract (spec 002 §2.4). `ObservationContext` gains an
optional `checkpoint?: (nextState: unknown) => Promise<void>` callback, supplied only on the
`watch()` path (never `observe()`). A long-lived `watch()` source calls it to durably write back its
advancing change-detection state into the monitor's persisted `sourceState`, so a mid-watch daemon
crash reconciles from the last checkpointed baseline rather than re-emitting already-delivered
changes.

The runtime serializes checkpoint writes with observation ingestion per-watcher: a checkpoint whose
durable write is in flight when an observation arrives completes before that observation is ingested
(the G14 durable-write-before-ingest ordering). A checkpoint is a state write only — it never
materializes or delivers an observation — and a checkpoint whose write fails logs a warning and does
not abort the watcher.
