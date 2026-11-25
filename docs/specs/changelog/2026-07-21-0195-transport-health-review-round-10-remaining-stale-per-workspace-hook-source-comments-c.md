## 2026-07-21 — Transport-health review round 10: remaining stale per-workspace hook source comments, coverage-collapse test gap (006 §12.3, 005 §15) — Refs #425

Round 9's "two stale comments" claim was itself incomplete: it fixed the two TEST comments it named,
but three SOURCE comments describing the superseded per-workspace hook model were still present and
contradicted `heartbeatKey`'s per-session contract (006 §12.3) — `TransportHeartbeat.hostSessionId`'s
JSDoc said only `channel` is session-scoped, `heartbeatKey`'s own doc comment described hook as
"per-workspace... each invocation overwrites the last", and a `doctor.ts` comment referred to "the
per-workspace hook record". All three are reworded to describe the per-session record every active
lead now leaves. A fourth comment, in `transport-health.test.ts`'s cross-workspace matching test,
correctly stated hook has "no per-session identity of its own" for the OLD model but was never
updated when the storage keying changed; it now says hook records ARE per-session while
`selectHeartbeats` still matches candidates by same-workspace only (the two are independent facts,
and the test's assertions were already correct).

Separately, `transport-health.integration.test.ts`'s `seedHeartbeat` fixture wrote every hook record
to a literal `hook-workspace.json`, regardless of `hostSessionId` — so the suite could never seed two
active leads' hook heartbeats and have both survive; a wiring regression that collapsed real
`hook deliver` invocations back onto a single shared record would have left every test in the file
green. The fixture now keys hook records by host session id, matching the real registry, and a new
positive case seeds two active leads' hook heartbeats and asserts both survive with a fully
deliverable, exit-0 verdict.

