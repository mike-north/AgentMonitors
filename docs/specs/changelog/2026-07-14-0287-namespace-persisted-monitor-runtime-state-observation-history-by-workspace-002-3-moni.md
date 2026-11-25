## 2026-07-14 — Namespace persisted monitor runtime state + observation history by workspace (002 §3, `monitor_state`/`observation_history` schema) — Refs #345, #307

Persisted `monitor_state` was keyed by `monitor_id` alone (it was the PRIMARY KEY, no
`workspace_path` column), and `observation_history` had no workspace column. Because the database
is global and the same monitor id can exist in unrelated workspaces (the getting-started default
`my-first-monitor` is the common collision), a second project reusing the id read the first
project's `source_state` and reported `descoped`/`deleted` changes for files that only ever existed
in the other workspace — a durable-state / workspace-isolation defect (issue #345; same mechanism
as #307).

- **002 §3 + `monitor_state` schema — changed (current).** State is now keyed by
  `(monitor_id, workspace_path)`: a surrogate `id` PK plus a UNIQUE index on
  `(monitor_id, COALESCE(workspace_path, ''))` (the NULL-safe pattern already used by
  `session_object_cursor`). Every runtime read/write threads its workspace scope — the tick loop,
  `ingest()`, `scheduleForMonitor()`, the watch path, and `explain`/`doctor`. Verified:
  `libs/core/src/inbox/schema.ts` (`monitorState`), `libs/core/src/inbox/db.ts` (DDL + unique index
  - legacy-table migration), `libs/core/src/runtime/store.ts` (`getMonitorState`/`setMonitorState`
    keyed by `(monitorId, workspacePath)`), and
    `apps/cli/src/workspace-isolation.integration.test.ts` (two-workspace/same-id/shared-DB repro,
    restart-safe).
- **`observation_history` schema — changed (current).** Adds a nullable `workspace_path`; scoped
  readers (`monitor explain`, `doctor`, `monitor history --workspace`) filter by exact workspace, so
  a same-id monitor elsewhere cannot leak its audit trail. An unscoped `monitor history` still tails
  across all workspaces.
- **Migration — one-time re-baseline (documented).** A pre-namespacing `monitor_state` was keyed by
  `monitor_id` alone, so the first open after upgrade **rebuilds** the table under the surrogate
  `id` PK (SQLite can't add it in place). The rebuild resets only `source_state` — which cannot be
  safely attributed to a workspace — so every monitor re-baselines cleanly on its first post-upgrade
  tick, emitting no spurious created/deleted/descoped events. The durable `notify_state` batch
  (`pendingDebounce`/`pendingRollup` — already-detected observations the runtime MUST redeliver,
  002 §4.4 / #109) is **preserved**, attributed to the workspace derived from each observation's
  monitor `filePath`, so no pending batch is silently dropped. Legacy `observation_history` rows are
  migrated additively (they keep `NULL` `workspace_path` and fall out of workspace-scoped queries),
  not reset by the drop. The rebuild runs inside one immediate transaction so concurrent first-opens
  serialize. This resolves the mechanism #307 tracks.

