## 2026-07-14 — Unify per-workspace db/socket defaulting across `daemon run`/`once`, `doctor`, `daemon status`/`stop` (002 §10.2, 005 §9, §10.1, §15) — Refs #335

A directly-invoked `agentmonitors daemon run` — the Getting Started guide's own documented usage,
with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` overrides — bound to the bare global
default db/socket, while `doctor` (and `session start`'s lazy boot) already assumed an enabled
workspace gets its own isolated, derived-per-workspace db/socket. `session open`/`session list`/
`daemon status` all talked to the live daemon (or its actual default socket) and agreed the lead
session was active; `doctor` independently re-derived a _different_, empty SQLite file and reported
no lead session at all — three commands disagreeing about the exact same durable state (DX study S3
F5). Spec 002 §10.2 and 005 §15 already documented "the same way the daemon resolves them" as the
intended contract; the bug was that `daemon run`/`daemon once` never actually implemented it.

- **002 §10.2 — clarified (current).** "Per-workspace isolation" now states explicitly that the
  convention applies regardless of how the daemon was started — a directly-invoked `daemon run`/
  `daemon once` now resolves the identical per-workspace db/socket an enabled workspace's `doctor`/
  `session open` assume, not just the lazy-boot path. Updated the `Verified:` citation to include
  the new shared resolvers.
- **005 §"Socket path resolution" / "Database path resolution" — rewritten (current).** Documents
  the full, now-symmetric resolution order (env var → enabled workspace's persisted-or-derived
  per-workspace value → global default) and names every command that shares it: `session
open/close/list`, `events list/ack`, `hook claim`, `doctor`, `daemon run`/`once`, and — newly —
  `daemon status`/`daemon stop`, which previously used only `--socket`/the bare global default and
  would have silently disagreed with the other commands once this fix made `daemon run` bind
  elsewhere.
- **005 §9.1/§9.2 (`daemon once`/`daemon run`) — updated (current).** The `--workspace` flag rows
  now state it is resolved to an absolute path and drives per-workspace db/socket resolution.
- **005 §10.1 (`session open`) — updated (current).** The `--workspace` flag is now resolved via
  `path.resolve()`, the same way `doctor`/`daemon once`/`daemon run` resolve theirs, so a relative
  or trailing-slash value cannot silently diverge from `doctor`'s exact-string workspace match.
- **005 §15 (`doctor`) — updated (current).** The lead-session check's failure `detail` and
  remediation now name the exact workspace path doctor searched, so a future db/socket-derivation
  mismatch is self-diagnosing (compare directly against `session list`'s workspace column) rather
  than a bare "No lead session is registered for this workspace."
- **Implementation.** New shared `apps/cli/src/workspace-db-path.ts` (`resolveWorkspaceDbPath()`),
  used by `doctor.ts` and `daemon.ts`; `apps/cli/src/manual-daemon.ts`'s
  `resolveManualDaemonSocketPath()` now falls back to the derived per-workspace socket (not
  `undefined`/the global default) for an enabled workspace with no persisted socket yet;
  `daemon.ts`'s `run`/`once`/`status`/`stop` actions all resolve db/socket through these shared
  helpers instead of the bare global default. `MonitorDoctorReport.workspacePath` (core) tightened
  from optional to required, matching `DoctorReportInput.workspacePath`'s existing required field.
  Regression coverage: `apps/cli/src/commands/cli.integration.test.ts` `describe('daemon run/once
workspace-scoped defaulting (issue #335)')` drives the exact study sequence (init --enable-only →
  direct `daemon run` with no overrides → `session open` → `session list`/`daemon status`/`doctor`)
  end-to-end against the real built CLI; unit coverage in `workspace-db-path.test.ts` and
  `manual-daemon.test.ts` locks down the resolution order directly.

