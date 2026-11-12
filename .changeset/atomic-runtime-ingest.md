---
'@agentmonitors/core': minor
'@agentmonitors/source-api-poll': minor
'@agentmonitors/source-command-poll': minor
'@agentmonitors/source-file-fingerprint': minor
'@agentmonitors/source-incoming-changes': minor
'@agentmonitors/source-schedule': minor
---

Commit each finite poll span, its ordered retry suffix, and source/notify checkpoints together before optional interpretation. Preserve committed recipient-cache state when admission rolls back.

When the retry outbox cannot hold a failed observation's whole ordered suffix, because the monitor's outbox is full or a value cannot be stored (such as a BigInt payload), that observation is recorded as `errored` with the reason. Its siblings still materialize and the source checkpoint advances, so the monitor keeps making progress. A rollup window clears its held batch only in the same commit as the flushed observations. A flush that fails leaves the window held and reports the error.

Breaking source-plugin migration (pre-1.0): `watch()` now yields finite `ObservationResult` batches,
not individual observations, and `ObservationContext.checkpoint` is removed. Yield
`{ observations: [...], nextState }` so all covered observations and the source checkpoint commit
together before interpretation or the next iterator pull. Empty batches support baseline-only
updates. Failed admission stops the iterator and preserves the old baseline; legacy bare yields
are rejected. Poll signatures are unchanged.

The five bundled source packages publish the same source contracts through their exported types and
default source values. Their minor releases carry this breaking type migration too, even though
their own implementations use polling and require no runtime changes.
