---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

`verify --use-workspace-daemon` no longer pollutes the workspace's event stream with a spurious
event from its own teardown.

That mode targets the persistent workspace daemon and leaves it running. Previously, verify's cleanup
deleted its own scratch trigger file (`agentmonitors-verify-<hash>.<ext>`), the live daemon observed
that deletion as a real change, and a later session's `hook deliver`/`events list` surfaced a spurious
`File deleted: …/agentmonitors-verify-….md` **first**, ahead of the user's real change — a bad look
for the "stakeholder-presentable proof" this mode targets (issue #407). The default isolated mode was
never affected (its throwaway daemon/db are torn down).

Verify now deletes the scratch file, waits for its own monitor to materialize the resulting deletion
event, then retracts the exact events its own scratch file produced (the create AND the delete) across
all sessions. The wait and retraction are scoped to the verified monitor, and the retraction deletes by
the observed event ids — never a `(monitor, path)` sweep — so a real, pre-existing event at the same
watched path survives and a second monitor also watching it is unaffected. Real monitored changes, and
any pre-existing watched file verify merely edits and restores, are never touched.

This adds a new runtime capability, `AgentMonitorRuntime.retractObjectEvents` (backed by the store),
which removes a caller-supplied set of a monitor's events by id — plus their per-recipient
`session_event_state` projections, snapshots, and the affected sessions' seeded cursors; it is exposed
over the daemon socket as the `events.retractObject` IPC verb.
