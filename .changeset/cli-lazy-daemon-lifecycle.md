---
'@agentmonitors/cli': minor
---

Document the lazy-daemon activation lifecycle and the `incoming-changes` scaffolding in the changelog (these shipped while the CLI was a private, changeset-exempt package and were never credited in a release):

- **`session start` / `session end`** — Claude Code `SessionStart`/`SessionEnd` hook entry points. `session start` lazily boots a per-workspace daemon (detached), registers the session, persists the resolved socket/db to `.claude/agentmonitors.local.md`, and surfaces the post-compact recap; `session end` deregisters so the idle daemon can reap itself. Both read the host session id from the hook stdin payload (`session_id`).
- **`daemon run --reap-after-ms <ms>`** — idle reaping: the daemon stops itself after its last workspace session has been closed for the given window (default 300000; `0` disables), with a boot-grace so a freshly-spawned daemon can't reap before its session registers.
- **`init --type incoming-changes`** — the `incoming-changes` source is registered and scaffoldable (`agentmonitors init <name> --type incoming-changes`).
