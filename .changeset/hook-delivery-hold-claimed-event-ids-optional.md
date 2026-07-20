---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Fix two review-round-7 defects in the delivery-transport health surface (#425):

- **`HookDeliveryHold.claimedEventIds` is now optional**, not required. The transport-health work
  in this release added it as a required field on this already-published `@agentmonitors/core`
  public interface with no accompanying changeset — a breaking addition that also didn't reflect
  reality: a `HookDeliveryDiagnosis` can arrive over the daemon IPC boundary from an older build
  that predates the field, serializing a hold with no `claimedEventIds` key at all despite the
  compile-time type.
- **`doctor`'s reminders-suppressed remediation no longer treats a missing `claimedEventIds` as an
  ack-all fallback.** Previously, a suppressing hold with no `claimedEventIds` contributed a
  literal `undefined` into the ids list, which rendered as a malformed, blank
  `--event-ids  --socket ...` flag — worse than the documented "omit the flag" fallback for a
  genuinely empty `[]`, since it looks like a safe, scoped command while actually being broken. A
  session whose suppression evidence can't be trusted this way is now reported via the existing
  `delivery-diagnosis-unavailable` code (with an upgrade-the-daemon remediation) instead, and
  correctly blocks `deliverable` like every other diagnosis-unavailable case.

See docs/specs/006-agent-integration.md §12 and docs/specs/spec-changelog.md.
