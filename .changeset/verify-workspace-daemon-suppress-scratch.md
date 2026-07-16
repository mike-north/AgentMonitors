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

Verify now cleans up its own events using one of **two mechanisms with non-overlapping safe domains**,
chosen by whether its trigger's object key is synthetic or a real watched path:

- **Synthetic scratch file** (`…/agentmonitors-verify-<token><ext>`, a path no real object shares):
  verify deletes it and, in one **non-blocking** call, retracts the create event it already delivered
  AND installs a durable, self-expiring **object-event suppression** (tombstone). The daemon's tick
  sweeps the pending `File deleted: …/agentmonitors-verify-…` by object key on the tick it
  materializes — before any later session can see it — so the mode finishes in about the same time as
  plain `verify` and its ETA is honest. Safe precisely because the key is synthetic.
- **Real watched path** (a literal single-file glob whose file verify created): a by-key sweep here
  would eat a **later genuine event at that same path** within the window, silently losing the user's
  change, so verify instead retracts **only its own observed event ids** (the id-scoped path). A
  literal file that pre-existed is only edited and restored, never erased.

To keep this a defect-resistant invariant, `AgentMonitorRuntime.suppressObjectEvents` and the
`events.suppressObject` IPC verb **reject a non-synthetic object key** outright — a real path can
never reach the by-key sweep. An omitted `workspacePath` is normalized to the NULL scope for both the
tombstone and its retraction, so it can no longer sweep other workspaces' events.

An interrupted run leaves no permanent stray state: verify's `SIGINT`/`SIGTERM` handler runs the same
object-appropriate cleanup best-effort before exiting, and — even on an uncatchable kill — the daemon
tombstones + retracts a stale `agentmonitors-verify-*` session's scratch objects when it reaps that
session to dormant (with a tombstone lifetime derived from the monitor's own cadence).

This adds a new runtime capability, `AgentMonitorRuntime.suppressObjectEvents` (backed by a durable
`object_event_suppressions` table, a key-scoped `retractObjectEventsByKey`, and a per-tick suppression
sweep), exposed over the daemon socket as the `events.suppressObject` IPC verb; `isVerifyScratchObjectKey`
is exported so the daemon boundary can enforce the synthetic-key invariant.
