---
'@agentmonitors/core': minor
---

Commit each finite poll span, its ordered retry suffix, and source/notify checkpoints together before optional interpretation. Preserve committed recipient-cache state when admission rolls back.

Breaking source-plugin migration (pre-1.0): `watch()` now yields finite `ObservationResult` batches,
not individual observations, and `ObservationContext.checkpoint` is removed. Yield
`{ observations: [...], nextState }` so all covered observations and the source checkpoint commit
together before interpretation or the next iterator pull. Empty batches support baseline-only
updates. Failed admission stops the iterator and preserves the old baseline; legacy bare yields
are rejected. Poll signatures are unchanged.
