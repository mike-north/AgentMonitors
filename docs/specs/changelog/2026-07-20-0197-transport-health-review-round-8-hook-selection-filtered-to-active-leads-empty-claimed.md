## 2026-07-20 — Transport-health review round 8: hook selection filtered to active leads, empty `claimedEventIds` is untrustworthy, stale docs/tests (006 §12.3/§12.7, 005 §15) — Refs #425

An eighth review round against the head that closed round 7 found one remaining false green, one
remaining unsafe remediation branch, and documentation/tests that had fallen behind round-6/7's
production fixes:

- **`hook` selection returned every same-workspace record, including closed/non-lead sessions'
  (blocker).** After the round-6-follow-up keyed `hook` per session, `selectHeartbeats` still
  returned every heartbeat matching the workspace rather than narrowing to active leads first, the
  way `channel` already did. A direct probe with one healthy active-lead record plus one
  closed-session record bound to an obsolete socket produced `socket-mismatch`,
  `hook.healthy: false`, `reach: 'none'`, and `deliverable: false` for a workspace where the only
  currently-open session was working fine. Selection now prefers records naming an ACTIVE lead,
  falling back to every same-workspace record only when none match — mirroring `channel`'s pattern
  — so an inactive session's record can no longer poison the active aggregate. See 006 §12.3.
- **An empty `claimedEventIds` array on a suppressing hold was accepted as "trustworthy but empty"
  (blocker).** `hasValidClaimedEventIds` only checked `Array.isArray` and element types, so `[]`
  passed and fell into the scoped-remediation branch, where an empty `ids` list renders
  `--event-ids` as omitted — silently falling back to the unscoped, blanket
  `agentmonitors events ack --session <id>` the round-6 fix exists to avoid.
  `classifyReminderHold` only ever returns an `already-claimed`/`coalesced-until-ack` hold when at
  least one event is claimed, so a real hold from this build always names at least one id; an empty
  array reaching `doctor` can only be malformed or hand-built and is now routed to
  `delivery-diagnosis-unavailable`, the same as a missing field. `settle-window`'s legitimate empty
  array never reaches this check — only the two suppressing reasons do. See 006 §12.7 / 005 §15.
- **Stale documentation and tests still described the superseded workspace-keyed hook model.**
  006 §12.3's selection description, 005 §15's `hook-lead-uncovered` table row, source JSDoc on
  `TransportProblemCode`/`computeTransportHealth`, and comments/test names in
  `transport-health.test.ts` and `transport-health.integration.test.ts` all still said hook records
  were "single" or "workspace-keyed", contradicting the per-session `heartbeatKey` behavior already
  shipped. Corrected throughout.
- **A stray comment still claimed `readTransportHeartbeats` performs opportunistic GC** in
  `isHeartbeatStale`'s future-timestamp branch, despite reads being deliberately pure since the
  round-7 write-path-only GC fix. Corrected to reference `reapExpiredHeartbeats`.
- **A test called the two-argument pre-fix `readTransportHeartbeats(now)` signature**, which no
  longer exists (reads take no arguments) — a TypeScript compile failure that would have prevented
  the whole suite from running. Fixed to call the current zero-argument signature.
- **The website skill guide and the original changeset text still named the unscoped
  `agentmonitors events ack --session <id>`** as the `reminders-suppressed` remediation, contradicting
  the scoped `--event-ids`/`--socket` command the round-6 fix and the changeset's own "Review fixes"
  section already document. Corrected both.

