## 2026-10-30 — Retry admission rejects detectable hidden intrinsic state (002 outbox, 004 §3.4) — Refs #483

Prototype identity alone does not establish a plain record. Intrinsic checks now reject boxed
primitives, Map/Set and weak variants, buffers/views, promises, native errors, and other brands
Node exposes even after their prototypes are replaced. Nineteen built-in regression cases cover
both Object.prototype and null prototypes, requiring a domain error and no sibling writes.
Clarify the public caller precondition: only ordinary data records/arrays and the typed timestamp
are supported. Early validation rejects detectable violations; it cannot authenticate erased
object provenance or private state without an exposed intrinsic brand. Unsupported hidden-state
objects must be normalized by their source, not inferred to be supported from validation success.

