## 2026-11-08 — Read retry diagnosis after asynchronous discovery (002, 004) — Refs #495

Clarify that explain reads retained-work metadata after its asynchronous monitor scan, before
any definition-error return or later persisted diagnosis. A same-runtime admission completed during
discovery must remain visible alongside the event prefix, rather than producing a successful
materialization diagnosis with an omitted suffix. Require deterministic real-parser interleaving
and no-interleaving controls across valid, missing, invalid, duplicate and unschedulable definitions,
with native rows and opaque state preserved. This does not establish a cross-process snapshot,
change timestamps, or add automatic retry admission to the diagnostic primitives.

