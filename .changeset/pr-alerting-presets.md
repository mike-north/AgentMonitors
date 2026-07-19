---
'@agentmonitors/cli': minor
---

Add two repo-scoped PR-alerting presets to `agentmonitors init --type`: `pr-review` (reviewer role — open, non-draft PRs awaiting review, excluding release PRs and your own PRs) and `my-prs` (authoring role — CI failures, review feedback, and merged/closed/draft transitions on your own open PRs).

Both scaffold a ready-to-run `command-poll` monitor over the GitHub CLI and are automatically scoped to whichever repository the session is operating in. `gh` resolves the repository from its process working directory, and `command-poll`'s effective `cwd` defaults to the **daemon's own** working directory, not necessarily this project's — so `init` scaffolds an explicit `cwd:` pointing at the project root it was run from, rather than omitting `cwd` and hoping the daemon happens to launch from the right place. `my-prs` uses `--author @me` rather than a scaffolded username. The same `MONITOR.md` is therefore correct in every checkout, and turning on PR alerting takes one command instead of hand-writing `gh` argv. Both invoke `gh` with an inherited `GITHUB_TOKEN` scrubbed first, so a stray exported token can't silently change what `@me` resolves to.

Both are `normal` urgency. `high` is deliberately not used: `json-diff` fires symmetrically, so a PR leaving an actionable state (CI recovering, a PR merging) is indistinguishable from one entering it, and a high-urgency PR monitor would interrupt mid-turn on good news.

If `gh` is missing, unauthenticated, or run outside a GitHub repository, the monitor reports a failing-command event on its first tick — carrying both `gh`'s message and the fix — rather than silently baselining on empty output and never firing. Only the failure path's diagnostics ever mix with stderr; a successful run's diffed JSON is never polluted by incidental `gh` warnings.

Each preset's curated `name:` (e.g. `PRs awaiting my review`) is preserved when scaffolding with `init <name> --type pr-review` — unlike a source-type scaffold, the positional `<name>` no longer overwrites it.
