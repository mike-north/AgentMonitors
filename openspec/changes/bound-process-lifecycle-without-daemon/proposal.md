## Why

A monitored command's lifetime bound lives only in daemon-resident timers. If the daemon is
hard-killed before the timeout fires, the command and its descendants can be orphaned: a detached
child reparents to the OS supervisor and keeps running, unbounded. Cleanup of in-flight spawned
work must not depend on the daemon being alive to perform it. Refs #470 (narrowed by PR #472's
self-bounding watchdog, still open).

Source: 008 §3.3, §4.1, §12 (rows "Weeks of continuous running accumulate zero unintended
processes" and, with #478/#426, "Hard kill + restart leaves a clean process list").

## What Changes

- Spawned work becomes self-bounding: the mechanism enforcing a command's window survives daemon
  death, so the command's covered tree (the original-group mechanism class) still terminates at
  its deadline with no daemon present. **Modifies** the current "Lifetime bound across daemon
  death" requirement, closing the #470 known gap.
- Crash-survival guarantee: cleanup of in-flight spawned work does not depend on a live daemon.
- The restart sweep is complementary reconciliation, never a substitute for this lifetime bound.
- The close-on-exec-descendant residual stays open under #470: such a survivor is unbounded once the
  daemon is gone, until a future daemon start reconciles it via the restart sweep.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reliability/process-hygiene`: modifies "Lifetime bound across daemon death"; adds in-flight
  cleanup independence and sweep-is-not-a-bound requirements.

## Impact

- Code: `plugins/source-command-poll/src/*` (self-bounding watchdog), daemon spawn path.
- Principles: PP7, BP1 (per `principles`). Supplies the watchdog half of ladder rung 2 in
  `add-containment-probe-and-full-boundary-bounds` (#480); the close-on-exec residual is reconciled
  by `add-restart-sweep-and-stray-collection` (#478).
- Contradictions resolved: none; this closes a documented current gap.
- Changeset for `@agentmonitors/source-command-poll`.
