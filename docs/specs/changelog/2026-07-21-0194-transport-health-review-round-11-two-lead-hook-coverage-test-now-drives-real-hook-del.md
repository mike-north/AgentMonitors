## 2026-07-21 — Transport-health review round 11: two-lead hook coverage test now drives real `hook deliver` (006 §12.3, 005 §15) — Refs #425

Round 10's positive two-covered-lead case still seeded both hook heartbeats with
`seedHeartbeat`, a hand-written JSON record keyed by the caller-supplied `hostSessionId` — it never
called `writeTransportHeartbeat` or invoked real `hook deliver`. That proves
`computeTransportHealth`'s aggregation logic (given two per-session records, coverage is complete),
but it cannot catch a regression in the WIRING the test exists to protect: if `hook deliver` stopped
forwarding `session_id` from its `UserPromptSubmit` stdin payload into `hostSessionId`, if
`heartbeatKey` regressed to per-workspace keying, or if `sanitizeKey`'s hash suffix collided for two
real session ids, every assertion in the hand-seeded case would stay green while the production path
silently broke. The test now opens both lead sessions and runs the real `agentmonitors hook deliver`
against each, with a `UserPromptSubmit` payload naming its own `hostSessionId` on stdin, then asserts
`doctor` reports full hook coverage and a deliverable, exit-0 verdict.

