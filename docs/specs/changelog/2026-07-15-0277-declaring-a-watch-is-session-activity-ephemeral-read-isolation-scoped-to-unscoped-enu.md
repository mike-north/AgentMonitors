## 2026-07-15 — Declaring a watch is session activity; ephemeral read-isolation scoped to unscoped enumeration (002 §6.2 / 007 §4.4, §4.6) — Refs #312

Two clarifications to the ephemeral-monitor contract, both surfaced while hardening the
per-session dormancy path against event loss.

- **002 §6.2 / 007 §4.4 — declaring a watch resets the dormancy clock (behavior change).**
  Per-session dormancy previously advanced a session's `lastActiveAt` only on `claimDelivery` and
  recap. A session that declared an ephemeral monitor and then blocked on one long, hook-silent
  tool call (exactly what a watch is declared to wait for) could therefore cross the dormancy
  window with no activity signal and have its just-declared watch reaped mid-wait — silently
  losing the finishing event. Declaring an ephemeral monitor is now itself session activity and
  advances `lastActiveAt`. Additionally, the dormancy trigger considers a session's effective
  last-activity to be `max(lastActiveAt, newest active ephemeral declaredAt)`: a session with an
  ephemeral monitor declared **within** the dormancy window is not treated as dormant, so its
  watches survive at least one window past the declaration. A crashed session stops declaring, so
  its newest declaration ages out and cleanup still bounds. **Open (deferred):** whether a live
  session should hold its watches for an arbitrarily long blocking wait — longer than one dormancy
  window — is an unresolved spec decision, tracked as a follow-up to #312.
- **007 §4.6 — ephemeral read-isolation binds unscoped enumeration only (decision).** The read
  half of ephemeral isolation applies to **unscoped** (session-less) enumeration, not to a
  `monitorId`-targeted read that names a specific ephemeral id. A `monitorId`-targeted
  observation-history read is an operator-level diagnostic (`monitor explain` / `doctor`), not a
  session-isolated surface: knowing the full `ephemeral:<sessionId>/<ulid>` id is itself operator
  knowledge, and under the local single-operator trust model (PP10) it MAY return that monitor's
  observation-history audit rows across session boundaries. The **events** surface is stricter by
  design — an ephemeral event body carries the declaring session's private free-text instruction,
  so `events list` excludes ephemeral rows on any session-less read, including one naming the id.

