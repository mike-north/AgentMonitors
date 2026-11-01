---
'@agentmonitors/core': minor
'@agentmonitors/source-api-poll': minor
'@agentmonitors/source-command-poll': minor
'@agentmonitors/source-file-fingerprint': minor
'@agentmonitors/source-incoming-changes': minor
'@agentmonitors/source-schedule': minor
---

Commit each finite poll span, its ordered retry suffix, and source/notify checkpoints together before optional interpretation. Preserve committed recipient-cache state when admission rolls back.

Breaking source-plugin migration (pre-1.0): `watch()` now yields finite `ObservationResult` batches,
not individual observations, and `ObservationContext.checkpoint` is removed. Yield
`{ observations: [...], nextState }` so all covered observations and the source checkpoint commit
together before interpretation or the next iterator pull. Empty batches support baseline-only
updates. Failed admission stops the iterator and preserves the old baseline; legacy bare yields
are rejected. Poll signatures are unchanged.

The five bundled source packages publish the same source contracts through their exported types and
default source values. Their minor releases carry this breaking type migration too, even though
their own implementations use polling and require no runtime changes.
