---
'@agentmonitors/cli': minor
'agentmonitors': minor
---

`agentmonitors init` (bare and `--enable-only`) now also ensures `.gitignore` ignores
`.agentmonitors/` — the project-root runtime directory the daemon creates the moment a session
opens (per-session `hook-state.json`). Previously only `.claude/*.local.*` was gitignored, so
following the setup docs exactly left `.agentmonitors/` as an untracked entry in `git status`.

- Each required `.gitignore` line is checked independently, so a `.gitignore` that already has one
  line but not the other only gets the missing one appended (no duplicates on re-run).
- `.agentmonitors/` is fully regenerated on every session/tick, so it is always safe to delete.

The unscoped `agentmonitors` launcher bumps alongside `@agentmonitors/cli` so users installing the
short name receive the fix.
