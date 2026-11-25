## 2026-06-13 — `monitor explain` healthy/idle status, workspace scoping, and connection-only fallback (002 §10.7, 005 §6)

Three corrections to the #94 `monitor explain` command (review of PR #98):

- **Healthy/idle is not a failure.** A `no-change` or `rebaselined` observation outcome now maps to a
  new `healthy` stage status (rendered `○`, distinct from `✓` delivered and `✗` failure) with an
  affirmative verdict ("Source ran, observed 0 changes — your watched target genuinely hasn't changed
  (not a bug)."). Previously a perfectly idle monitor rendered as an error (`✗`/`failure`),
  contradicting #94's contract that "your watched thing genuinely didn't change" is not a bug. When
  the latest observation is `healthy`, the downstream materialization and delivery stages report
  `healthy` for the expected absence of events/projections rather than `✗`. `failure` is reserved for
  real faults (errored observe, invalid definition, missing projection, daemon down). The new status
  is carried in `--format json` as `"status": "healthy"`.
- **Workspace scoping (session isolation).** The inbox DB is global, so the same `monitorId` can
  exist in multiple workspaces. `explainMonitor()` now scopes the materialization stage to the
  explained workspace's `monitor_events` (plus workspace-agnostic events) and the delivery stage to
  that workspace's sessions (plus global sessions), so one workspace's report never counts another
  workspace's events or projections.
- **Connection-only fallback.** The daemon-unavailable fallback now fires only for a genuine
  connection failure (socket refused/absent or request timeout, surfaced as a typed
  `DaemonConnectionError`). A daemon-side application error is surfaced verbatim
  (`Explain failed: <message>`, exit 1) instead of being masked as "daemon not running".
- **Proof:** `libs/core/src/runtime/service.test.ts` (no-change + rebaselined → `healthy`/affirmative
  verdict, no downstream `✗`; cross-workspace event/projection isolation);
  `apps/cli/src/daemon-ipc.test.ts` (application error → plain `Error`, connection failure →
  `DaemonConnectionError`); `apps/cli/src/commands/cli.integration.test.ts` (live daemon application
  error surfaced, not masked).
- Minor changeset: `@agentmonitors/core` (new `healthy` value in the public `MonitorExplainStageStatus`
  union and workspace-scoped explain queries).

