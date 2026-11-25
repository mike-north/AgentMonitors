## 2026-06-28 — Manual daemon commands use the enabled workspace socket (005 §1) — Refs #199

`session open`, `session close`, `session list`, `events list`, `events ack`, and `hook claim` now
resolve the enabled workspace's persisted `.claude/agentmonitors.local.md` `socket:` when no explicit
`--socket` and no `AGENTMONITORS_SOCKET` are present. This aligns manual CLI inspection with the
plugin hook path: in an enabled project, manual commands reach the per-workspace daemon that
`session start` booted; outside an enabled project, the global default socket remains unchanged.

When those manual commands cannot reach the resolved daemon, they now print one actionable stderr
line telling the author how to start a daemon and exit non-zero, rather than exposing a raw
`DaemonConnectionError` stack. Daemon-side application errors remain surfaced normally and still honor
JSON error output where applicable.

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` covers manual commands reaching the
  per-workspace socket after `session start`, explicit `--socket` / `AGENTMONITORS_SOCKET`
  precedence over that local socket, plus daemon-unavailable remediation for `session open`,
  `session close`, `session list`, `events list`, `events ack`, and `hook claim` with no stack trace.
- Patch changeset: `@agentmonitors/cli` user-visible command resolution/error behavior.

