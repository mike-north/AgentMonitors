## 2026-11-05 — Preserve native Shape input rejection (001 §5.1) — Refs #542

Extend the pre-normalization guard to the verified historical non-mapping family:
`Date`, `Map`, `Set`, and objects with callable `then` and `catch`. Synchronous
validation returns failure for native Promises rather than throwing, and async
validation rejects them without awaiting a resolved mapping. Preserve the existing
admission of other objects, mapping/default/CEL behavior, public input/output types,
and preprocessing composition surface; do not impose a plain-object restriction.

