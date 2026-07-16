---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
'agentmonitors': patch
---

`verify --use-workspace-daemon` no longer pollutes the workspace's event stream with a spurious
event from its own teardown.

That mode targets the persistent workspace daemon and leaves it running. Previously, verify's cleanup
deleted its own scratch trigger file (`agentmonitors-verify-<hash>.<ext>`), the live daemon observed
that deletion as a real change, and a later session's `hook deliver`/`events list` surfaced a spurious
`File deleted: …/agentmonitors-verify-….md` **first**, ahead of the user's real change — a bad look
for the "stakeholder-presentable proof" this mode targets (issue #407). The default isolated mode was
never affected (its throwaway daemon/db are torn down).

Verify now deletes the scratch file, waits for the daemon to materialize the resulting deletion event,
then retracts every event its own scratch object produced (the create AND the delete) across all
sessions — scoped strictly to that synthetic path. Real monitored changes, and any pre-existing
watched file verify merely edits and restores, are never touched.

This adds a new runtime capability, `AgentMonitorRuntime.retractObjectEvents` (backed by the store),
which removes the shared `monitor_events` rows, their per-recipient `session_event_state` projections,
snapshots, and seeded cursors for one `(monitorId, objectKey)`; it is exposed over the daemon socket
as the `events.retractObject` IPC verb.
