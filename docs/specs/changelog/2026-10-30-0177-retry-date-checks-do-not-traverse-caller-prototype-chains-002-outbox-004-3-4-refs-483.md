## 2026-10-30 — Retry Date checks do not traverse caller prototype chains (002 outbox, 004 §3.4) — Refs #483

Replace `instanceof Date` with intrinsic Date detection during passive-data validation. A non-proxy
object may inherit a proxy whose prototype trap changes its data and repairs its prototype during
`instanceof`, causing altered data to be accepted. Intrinsic brand checks and direct prototype
identity checks reject this unsupported domain without executing traps. Regression coverage
includes payloads, root envelopes, routes, arrays, timestamps, indirect proxy ancestors, and
revoked proxy prototypes, with no sibling writes.

