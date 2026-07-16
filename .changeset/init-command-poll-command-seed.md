---
'@agentmonitors/cli': minor
'agentmonitors': minor
---

`init --type command-poll` now accepts a `--command` seed flag, and `validate` warns when a
command-poll scaffold is left at its untouched default.

Previously `init <name> --type command-poll` always scaffolded the fixed default command
`git ls-remote origin refs/heads/main`, regardless of intent. Because that default validates and
runs, a scaffold left untouched silently watched the wrong thing for any other goal (e.g. watching
uncommitted changes with `git status --porcelain`) instead of failing visibly.

- **New `--command` seed flag** (scaffold form only, mirroring `--glob`): repeatable, seeding
  `watch.command` one argv token per flag, order-preserving — `init dirty-worktree --type
command-poll --command git --command status --command --porcelain` yields
  `command: [git, status, --porcelain]`. Each token round-trips verbatim (single-quoted YAML), and
  the CLI never whitespace-splits, so it never invents shell semantics the source doesn't have. It
  is rejected with a clear error for any `--type` other than `command-poll`.
- **Untouched-default warning:** when `--command` is omitted, the scaffold keeps its illustrative
  upstream-tip default, but `agentmonitors validate` now emits a soft, non-fatal warning for a
  command-poll monitor whose `watch.command` still equals that exact default — so a wrong-intent
  ship is caught instead of silently passing as configured. The warning does not change the
  valid/invalid counts or the exit code. `validate --format json` gains an additive
  `warnings: [{ id, warning }]` array (`[]` when none), and text output gains an optional
  `Warnings:` section.
