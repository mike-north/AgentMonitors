## 2026-07-16 — `verify --use-workspace-daemon` retracts its own scratch-file events (005 §16) — Refs #407

`verify --use-workspace-daemon` targets the persistent workspace daemon and leaves it running. Its
teardown deletes its own scratch trigger file, which the live daemon observed as a real change and
queued as an event — so a later session's `hook deliver`/`events list` saw a spurious `File deleted:
…/agentmonitors-verify-….md` **first**, ahead of the user's real change. (Default isolated mode is
unaffected: its throwaway daemon/db are torn down.)

- Added **step 9 "Retract"** to §16: under `--use-workspace-daemon`, verify now deletes the scratch
  file, waits for **its own monitor** to materialize the resulting deletion event, then retracts the
  exact events its own scratch file produced (create AND delete) across all sessions. The wait and
  retraction are scoped to the verified monitor's id, and the retraction deletes **by the observed
  event ids** (not a `(monitor, path)` sweep), so a real pre-existing event at the same watched path
  survives and a second monitor at that path is unaffected. Real monitored changes — and any
  pre-existing watched file verify merely edited and restored — are never retracted. §16 also records
  the residual crash window (a daemon death between materialization and retraction).
- Behavioral, not just clarifying: a new runtime capability `retractObjectEvents` (core service +
  store) removes a caller-supplied SET of a monitor's events by id — plus their per-recipient
  `session_event_state` projections, snapshots, and the affected sessions' seeded cursors — exposed
  over the daemon socket as the `events.retractObject` IPC verb.

