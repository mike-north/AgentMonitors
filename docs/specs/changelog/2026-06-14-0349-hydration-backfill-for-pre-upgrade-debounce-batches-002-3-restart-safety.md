## 2026-06-14 — Hydration backfill for pre-upgrade debounce batches (002 §3, restart-safety)

`hydrateStoredObservationEnvelope` now backfills a missing `effectiveUrgency` field (present on envelopes serialized before the range-urgency upgrade) by recomputing it from `effectiveObservationUrgency(monitor, observation)`. Without this, the first daemon restart after upgrade would materialize an invalid (undefined) urgency row. Degrades cleanly when the hydrated monitor snapshot itself lacks `urgencyMax`: returns the base urgency via `URGENCY_BY_RANK[NaN] ?? lo`.

