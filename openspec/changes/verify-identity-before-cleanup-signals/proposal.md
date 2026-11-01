## Why

Cleanup signals today are sent to stored or freshly observed pids without positively verifying that
the target is still the process the daemon believes it is. Operating systems recycle pids (and
pgids/session ids); a stored identifier can come to name the user's unrelated work, and signalling
it would be collateral damage — the one failure mode the reliability posture forbids outright.
Refs #479.

Source: 008 §5 (including its identifier-recycling example and test implications), §12 (row "No
report, ever, of signalling a process that was not ours").

## What Changes

- Before sending any cleanup signal on any path — live reaping, timeout-escalation follow-ups, the
  restart sweep, `gc` — the daemon positively verifies at signal time that the target is the
  process it believes it is (start time, lineage, containment marks).
- A stored pid/pgid/session id whose identity marks no longer match is never signalled.
- Verification failure is an abstention, never an error path that escalates to force: prefer a
  leak to a wrong kill.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reliability/process-hygiene`: adds identity verification at signal time for every cleanup path,
  recycled-identifier safety, and the abstain-on-failure bias.

## Impact

- Code: every cleanup-signal path — `plugins/source-command-poll/src/*` (timeout escalation),
  `apps/cli/src/commands/daemon.ts` (daemon stop / detach-failure termination), the restart sweep
  and stray collection.
- Principles: PP7, BP4 (per `principles`). Used by `add-restart-sweep-and-stray-collection` (#478,
  #426); verification failures surface through `add-abstention-warnings` (#507); identity marks
  include those applied by the mechanism selected in `add-containment-probe-and-full-boundary-bounds`
  (#480).
- Contradictions resolved: none.
- Changesets for affected packages.
