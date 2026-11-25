## 2026-07-14 — Document `.agentmonitors/` and gitignore it from `init` (002 §11.3) — Refs #336

A blind DX study found `.agentmonitors/` — the project-root runtime directory the core creates the
moment a session opens (`defaultHookStatePath()` derives the location; `refreshHookState()` creates it when writing per-session `hook-state.json`) — was entirely
undocumented: no spec, skill, or getting-started doc mentioned it, so following the setup docs
exactly left `?? .agentmonitors/` in `git status`.

- **002 §11.3 — new status paragraph (current).** States explicitly that `.agentmonitors/` is
  host-agnostic runtime state, not source-controlled project content; every file under it is a
  materialized, regenerable projection of the runtime's SQLite store (never the source of truth),
  so it is always safe to delete; and it is project-local, so it is a `.gitignore` concern
  alongside `.claude/*.local.*`.
- **`agentmonitors init` (bare and `--enable-only`) now also gitignores `.agentmonitors/`** —
  `ensureGitignore()` checks/appends each required line independently, so a `.gitignore` that
  already has one line but not the other only gets the missing one appended.
- **No behavior change to where the directory is rooted or what it contains** — this only makes
  its existence, purpose, and gitignore status documented and automatic.

