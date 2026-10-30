# Reminder forward progress

Tracking: #524. Base: origin/main e1bafcfa. Scope: normal/low notification starvation when an older event remains
claimed but unacknowledged. User authorized closing this gap on 2026-10-30. No merge is permitted
without independent adversarial review of the final revision.

The old behavior is intentional in 002 §9 and existing tests, so this is a deliberate policy revision,
not a claim that #434 was incompletely implemented. #468 claim expiry remains separate.

## Acceptance

A new pending event B receives a reminder at its eligible lifecycle even if older A stays unread and
claimed. A is not re-claimed or auto-acknowledged. Preserve urgency/lifecycle boundaries, session
isolation, high settle coalescing and reservation deduplication. A same-band live lease temporarily
serializes reminders; it must resolve on commit, release or expiry, never require acknowledgment.

## Evidence

- Before implementation, `reminder-progress.test.ts`: 7 failed, 4 passed, demonstrating starvation
  for hook/channel, normal/low, reservation commit and high settle coalescing.
- After implementation, the same 11 cases passed; targeted diagnostic suites passed (51 tests).
- Existing tests codifying old suppression are updated alongside the deliberate spec change.
- Full core suite: 41 files, 617 tests passed.
- Full workspace build passed (7 projects); full `pnpm check` passed with existing lint warnings.
- Core API report check passed unchanged.
- Targeted CLI rendering, health and real-daemon reminder/lease integration: 30 tests passed,
  279 unrelated cases skipped by the explicit name filter.
- Initial full check overlapped an API-report rebuild that deletes core/dist and failed on transient
  missing declarations. Re-running after the API build finished passed; no code workaround added.
- Independent adversarial review is pending; this change is not approved for merge yet.

## Tradeoff

A busy source can generate more reminders than the previous once-until-ack policy. Notifications
still batch all currently pending events and retain existing upstream timing/coalescing rules. This
change does not introduce periodic reminders for old work or a new rate limit. User-visible cadence
should be assessed in real use separately from correctness of fresh-work progress.

## Adversarial review correction

The reviewer rejected 23cf0de because ignoring `already-claimed` also blessed older daemons whose
old policy blocks future batches. Two version-skew health tests failed before repair. Current runtime
now emits distinct `no-new-work`; both legacy reasons remain conservative health failures, independent
of prose and version strings. Public API report and actual IPC assertions are updated. This revision
requires a fresh independent review; no merge approval is inferred from earlier tests.

Repair validation: full core suite 617 passed; transport-health 64 passed; live-daemon/urgency
selection 15 passed; preset override selection 6 passed (including both preset urgency overrides).
Workspace build and check passed; core API report check passed with the new additive reason.
Historical changelog entries remain unchanged. Preset rationale and body-delivery comments now
explain the current forward-progress policy; no preset urgency was changed.

Checkpoint for continuation: repair is ready for exact-SHA independent re-review. Do not push or
merge from this worker; parent owns those steps. Worktree: reminder-starvation/agentmonitors.
