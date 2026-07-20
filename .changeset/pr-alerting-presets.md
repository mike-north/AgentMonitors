---
'@agentmonitors/cli': minor
---

Add two repo-scoped PR-alerting presets to `agentmonitors init --type`: `pr-review` (reviewer role — PRs actually awaiting your review) and `my-prs` (authoring role — your own PRs that need something from you).

Both scaffold a ready-to-run `command-poll` monitor over the GitHub CLI, automatically scoped to the repository the session is operating in — via `command-poll`'s own workspace-root-relative `cwd` default (see the companion `@agentmonitors/source-command-poll` changeset), never a hardcoded `--repo` or a path baked into the scaffolded file — and to the current `gh` identity via `--author @me` rather than a scaffolded username. Turning on PR alerting takes one command instead of hand-writing `gh` argv.

Each preset emits a membership set of actionable items rather than full PR state: a green, non-draft, undecided PR does not appear at all, so an ordinary CI run produces no event, and every `my-prs` entry carries a `needs` field saying what to do. That filtering is what makes `high` urgency safe, and `high` is what makes the presets reliable — normal-urgency reminders are coalesced-until-acknowledgment and carry no event body mid-session, so a normal PR monitor goes silent exactly when the agent has been busy.

If `gh` is missing, unauthenticated, or run outside a GitHub repository, the monitor reports a failing-command event on its first tick — carrying both `gh`'s message and the fix — rather than silently baselining on empty output and never firing.
