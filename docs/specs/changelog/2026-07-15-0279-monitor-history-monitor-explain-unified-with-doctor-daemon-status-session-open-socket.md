## 2026-07-15 — `monitor history`/`monitor explain` unified with `doctor`/`daemon status`/`session open` socket auto-discovery (005 §1, §6) — Refs #374

`monitor history` and `monitor explain` previously resolved their daemon socket via the bare
`resolveSocketPath()` global default, bypassing `resolveManualDaemonSocketPath()` — the
per-workspace auto-discovery every other manual daemon command (`doctor`, `daemon status`,
`session open`, etc.) already used (issue #335/#349). A daemon booted for the current workspace
(e.g. lazily by a Claude Code session) was therefore invisible to `monitor history`/`monitor
explain` unless `--socket` was passed explicitly — surfacing as a factually wrong "No daemon
running and no persisted state to show" even while `doctor`/`daemon status` confirmed a live
daemon seconds earlier (blind usability evaluation, subjects F3/F4).

- **005 §1 "Socket path resolution" — updated.** `monitor history` and `monitor explain` added to
  the list of commands that insert the enabled workspace's socket via
  `resolveManualDaemonSocketPath()`, keyed off `--workspace` (defaulting to the process cwd, same
  as `doctor`). For `monitor history`, the existing opt-in `--workspace` row filter (issue
  #345/#307) now also selects which workspace's daemon/db to reach.
- **005 §6 "monitor history"/"monitor explain" — updated.** Their no-daemon in-process SQLite
  fallback (`explainMonitorInProcess`/`listObservationHistoryInProcess` in `runtime-client.ts`,
  now both **require** a `dbPath`, matching `doctorReportInProcess`) reads the same
  workspace-resolved db (`resolveWorkspaceDbPath()`) `doctor` reads, instead of the bare global
  default — so the fallback's "nothing persisted" diagnosis is no longer looking at the wrong
  database. Requiring (rather than defaulting) `dbPath` keeps a future caller from silently
  skipping that resolution.
- **005 §6 — remediation text updated (review follow-up).** The "daemon down, nothing persisted"
  message is now worded according to whether the workspace is actually enabled — i.e. whether
  `resolveManualDaemonSocketPath()` really derived a workspace-scoped socket, or the probe fell
  through to the bare global default: an enabled workspace reads "No daemon running **for this
  workspace** and no persisted state to show. ... if the daemon you want lives at a different
  socket, point at it with `--socket <path>`."; a not-enabled workspace reads "No daemon running
  **at the default socket** and no persisted state to show. ... enable this workspace so its
  socket is auto-discovered (`agentmonitors init --enable-only`), or point at the daemon you want
  with `--socket <path>`." The original single wording overclaimed workspace scoping in the
  not-enabled case.
- **Non-goals (unchanged):** the per-workspace socket/db derivation mechanism itself
  (`workspacePaths()`, `resolveWorkspaceDbPath()`) and `--socket`'s explicit-override precedence
  are untouched (#349/#335) — this entry only extends which commands feed their workspace into
  that existing mechanism.

