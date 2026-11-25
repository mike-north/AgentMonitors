## 2026-06-09 — Lazy project-scoped daemon (Plan B)

CLI-only change (no `@agentmonitors/core` public API change; no changeset needed).

**New files:**

- `apps/cli/src/workspace-paths.ts` — `workspacePaths(workspacePath)` derives a stable per-workspace
  `{ dir, db, socket }` under `XDG_DATA_HOME ?? ~/.local/share/agentmonitors/workspaces/<hash>/`.
- `apps/cli/src/local-state.ts` — `readLocalState`/`writeLocalState` for
  `.claude/agentmonitors.local.md` (minimal YAML frontmatter: `enabled`, `socket`, `db`,
  `reap-after-ms`). Absent/unparseable → `{ enabled: false }` (quick-exit).
- `apps/cli/src/detached-spawn.ts` — `spawnDetachedDaemon()` spawns `daemon run` with
  `detached: true, stdio: 'ignore'`, `.unref()`. The spawner exits; the daemon runs in the background.

**Modified files:**

- `apps/cli/src/commands/session.ts` — adds `session start` (lazy-boot daemon + `session.open`) and
  `session end` (finds session by `hostSessionId`, calls `session.close`). Both are no-ops when
  `CLAUDE_CODE_SESSION_ID` is absent or `enabled: false`.
- `apps/cli/src/commands/daemon.ts` — adds `--reap-after-ms <ms>` to `daemon run` (default 300000;
  0 disables). After each tick, the daemon counts active sessions for the workspace; if zero for
  `reapAfterMs` ms continuously, it stops itself.

**Spec updates:**

- [002 §10.2](./002-runtime-delivery.md#102-daemon-run--continuous-loop--unix-socket-server) — lazy
  boot, per-workspace isolation, idle reaping.
- [005 §9.2](./005-cli-reference.md#92-daemon-run--continuous-loop), [§10.4](./005-cli-reference.md#104-session-start--lazy-boot-daemon-and-register-session),
  [§10.5](./005-cli-reference.md#105-session-end--deregister-session) — `session start`/`session end` + `--reap-after-ms`.

