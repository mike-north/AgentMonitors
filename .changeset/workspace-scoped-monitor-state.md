---
'@agentmonitors/core': minor
'@agentmonitors/cli': minor
'agentmonitors': minor
---

Namespace persisted monitor runtime state and observation history by workspace (P1
durable-state / workspace-isolation fix).

`monitor_state` was keyed by `monitorId` alone (its PRIMARY KEY, with no workspace column), and
`observation_history` had no workspace column. Because the database is global and the same monitor
id can exist in unrelated workspaces on one machine — the getting-started default `my-first-monitor`
is the common collision — a second project reusing the id read the first project's `file-fingerprint`
baseline and reported `descoped`/`deleted` changes for files that only ever existed in the other
workspace.

- **State is now keyed by `(monitorId, workspacePath)`.** A surrogate `id` primary key plus a UNIQUE
  index on `(monitor_id, COALESCE(workspace_path, ''))` keeps each scope single-rowed, including the
  global (`NULL`) scope. `RuntimeStore.getMonitorState`/`setMonitorState` now take the workspace
  scope, and `recordObservationHistory` records it; `ObservationHistoryRecord`/`ObservationHistoryQuery`
  carry `workspacePath`.
- **Scoped diagnostics.** `monitor explain` and `doctor` scope observation history to their workspace;
  `agentmonitors monitor history` gains an opt-in `--workspace <path>` filter (unscoped still tails
  across all workspaces).
- **Migration — one-time re-baseline.** A pre-namespacing `monitor_state` (keyed by `monitor_id`
  alone) is rebuilt under the surrogate `id` PK on the first daemon open after upgrade. Only
  `source_state` is reset — it cannot be safely attributed to a workspace — so every monitor
  re-baselines cleanly on its first post-upgrade tick (no spurious created/deleted/descoped events).
  The durable `notify_state` batch (`pendingDebounce`/`pendingRollup` — already-detected observations
  the runtime must redeliver) is preserved and attributed to its workspace, so no pending delivery is
  silently dropped. Legacy observation-history rows are migrated additively (they keep `NULL` and fall
  out of workspace-scoped queries). The rebuild runs in one immediate transaction so concurrent
  first-opens can't double-migrate.
