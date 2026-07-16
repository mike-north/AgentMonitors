---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

`verify --use-workspace-daemon` no longer runs ~2× as long as plain `verify` (with a wrong ETA), and
an interrupted run no longer leaves permanent stray state.

The scratch-event cleanup added in the previous release WAITED a full extra poll interval + settle for
the scratch file's deletion event to re-materialize before retracting it, so `--use-workspace-daemon`
ran ~120s vs plain `verify`'s ~59s while still showing plain `verify`'s `~68s` ETA — reading as a hang
and overrunning default 2-minute command/CI timeouts. A run killed mid-cleanup left a permanently
`active` verify session plus dangling scratch events that `doctor` never flagged (issue #414).

Verify now deletes the scratch file and, in one non-blocking call, retracts the create event it already
delivered AND installs a durable, self-expiring **object-event suppression** (tombstone) keyed to the
synthetic scratch object. It no longer waits: the daemon's tick sweeps the pending
`File deleted: …/agentmonitors-verify-…` on the tick it materializes — before any later session can see
it — so the mode finishes in about the same time as plain `verify` and its ETA is honest, while the
prior no-leak guarantee is preserved. The suppression sweep deletes by the scratch object key, which is
safe only because that key is a synthetic path no real monitored object shares; a real watched file
verify merely edits and restores is never suppressed.

An interrupted run now leaves no permanent stray state: verify's `SIGINT`/`SIGTERM` handler runs the
same teardown (revert, tombstone, close session) best-effort before exiting, and — even on an
uncatchable kill — the daemon tombstones + retracts a stale `agentmonitors-verify-*` session's scratch
objects when it reaps that session to dormant.

This adds a new runtime capability, `AgentMonitorRuntime.suppressObjectEvents` (backed by a durable
`object_event_suppressions` table, a key-scoped `retractObjectEventsByKey`, and a per-tick suppression
sweep), exposed over the daemon socket as the `events.suppressObject` IPC verb.
