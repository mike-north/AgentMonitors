---
'@agentmonitors/cli': minor
---

Add two repo-scoped PR-alerting presets to `agentmonitors init --type`: `pr-review` (reviewer role — open, non-draft PRs awaiting review, excluding release PRs) and `my-prs` (authoring role — CI failures, review feedback, and merged/closed/draft transitions on your own PRs).

Both scaffold a ready-to-run `command-poll` monitor over the GitHub CLI and are automatically scoped to whichever repository the session is operating in: they omit `--repo` so `gh` resolves the repository from the daemon's working directory, and `my-prs` uses `--author @me` rather than a scaffolded username. The same `MONITOR.md` is therefore correct in every checkout, and turning on PR alerting takes one command instead of hand-writing `gh` argv.

If `gh` is missing, unauthenticated, or run outside a GitHub repository, the monitor reports a failing-command event on its first tick — carrying both `gh`'s message and the fix — rather than silently baselining on empty output and never firing.
