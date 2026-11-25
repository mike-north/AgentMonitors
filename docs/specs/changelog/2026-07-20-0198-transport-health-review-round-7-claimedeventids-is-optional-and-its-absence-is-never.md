## 2026-07-20 — Transport-health review round 7: `claimedEventIds` is optional and its absence is never an ack-all fallback (006 §12.7, 005 §15) — Refs #425

A review pass against the round-6 head found two related defects in the reminders-suppressed
remediation, plus documented a hook-keying fix from a round-6 follow-up commit that had not yet
reached the specs:

- **`HookDeliveryHold.claimedEventIds` was required on the already-published `@agentmonitors/core`
  public type (blocker).** The round-6 work added it as a required field with no accompanying
  changeset. Worse, it didn't reflect reality: a `HookDeliveryDiagnosis` crosses the daemon IPC
  boundary, so it can arrive from a build that predates the field, serializing a hold with no
  `claimedEventIds` key at all despite the compile-time type. It is now optional, with a core
  changeset.
- **A hold with a missing/malformed `claimedEventIds` silently became an ack-all fallback (blocker).**
  `.flatMap((entry) => entry.hold.claimedEventIds)` contributed a literal `undefined` per such hold
  (flatMap keeps a non-array return value as one element rather than dropping it), and
  `Array.prototype.join` rendered that as an empty string — producing a malformed, blank
  `--event-ids  --socket ...` flag. That is worse than the documented "omit the flag" fallback for a
  genuinely empty `[]` (a valid, deliberate signal from `settle-window`), because it looks like a
  safe, scoped command while actually being broken. Such a session is now reported via
  `delivery-diagnosis-unavailable` instead — never folded into `reminders-suppressed`'s scoped
  command, and never a bare, unscoped `agentmonitors events ack --session <id>` either, which would
  reintroduce the exact blanket-acknowledgement defect round 6 fixed. See 006 §12.7 / 005 §15.
- **006 §12.3 still described `hook` as workspace-keyed and overwritten per prompt**, which a
  round-6 follow-up commit (keying both transports by host session id when known, to fix a
  permanent false RED where two active leads sharing one workspace-wide hook record could never
  both read as covered) had already made stale. Corrected to describe per-session keying for both
  transports, while keeping the (still-true) distinction that only `channel` does session-id-first,
  cross-workspace _matching_ — `hook` has no cross-workspace identity to misresolve, so its
  selection stays same-workspace-only and returns every matching record rather than one
  representative.

