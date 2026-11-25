## 2026-06-12 — `monitor explain` diagnosis command and read-only IPC report (002 §10.5–§10.7, 005 §6)

Issue #94 adds an author-facing pipeline diagnosis command:
`agentmonitors monitor explain <monitorId>`. The command returns a staged report for definition,
scheduling, observation, notify state, materialization, and projection/delivery, with text output
using `✓` / `✗` / `⏳` and a JSON report for agents. The daemon exposes a read-only
`monitor.explain` IPC method that composes the report from existing persisted runtime state:
`monitor_state`, `observation_history`, `monitor_events`, `session_event_state`, and
`agent_sessions`. The CLI also has a daemon-unavailable fallback that validates the local
definition, then reports scheduling as failed because the daemon is not running or unreachable.

- Minor changesets for `@agentmonitors/core` (new public explain report/runtime API) and
  `@agentmonitors/cli` (new command and IPC wrapper).

