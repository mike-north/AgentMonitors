---
'@agentmonitors/cli': minor
'agentmonitors': minor
---

`agentmonitors init` (with no name) is now a one-shot project bootstrap. It enables monitoring
(`.claude/agentmonitors.local.md` with `enabled: true`), ensures `.gitignore` ignores
`.claude/*.local.*`, optionally scaffolds a first monitor, validates the result, and prints a
next-steps summary — collapsing the previously manual onboarding into a single command.

- Interactive on a TTY; `--yes` accepts defaults non-interactively (and scaffolds a starter
  monitor); `--enable-only` performs the enable + gitignore steps only (for agents/scripts).
- Idempotent: re-running on an already-set-up project changes nothing and says so.
- `agentmonitors init <name> --type …` scaffolding is unchanged.

The unscoped `agentmonitors` launcher bumps alongside `@agentmonitors/cli` so users installing the
short name receive the new bootstrap.
