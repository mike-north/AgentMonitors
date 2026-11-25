## 2026-10-30 — Retry serialization rejects lossy values before admission (002 outbox, 004 §3.4) — Refs #483

The supported retry-envelope domain now explicitly excludes negative zero and customized Date
instances, which JSON otherwise silently normalizes. The only Date leaf, `observedAt`, must be a
valid Date with Date.prototype and no own properties; ISO strings are rejected rather than
hydrated into a different input type. The timestamp is serialized explicitly without invoking
caller hooks. All failures are serialization-domain errors before any batch member is persisted.
New tests also prove two-item count and aggregate-byte overflow leave every sibling unwritten,
including a sibling in another route. Capacity admission logic is unchanged.

