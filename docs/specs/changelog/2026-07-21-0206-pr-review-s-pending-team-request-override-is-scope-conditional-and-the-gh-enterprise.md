## 2026-07-21 — `pr-review`'s pending-team-request override is scope-conditional, and the `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` scrub is documented accurately (003 §11.9, 004 §3.6) — Refs #444, #446

Two findings from PR #446's `pullrequestreview-4747480111`/`pullrequestreview-4747299707` review round:

- **Treating every login-less `reviewRequests` entry as a still-pending request from the viewer's own
  team was only sound under the default `review-requested:@me` scope** (`discussion_r3624450049`).
  `pr-review` also scaffolds `label:needs-review` and an unscoped search as supported alternatives, and
  under either of those the fetched `reviewRequests` can list a team the viewer does not belong to at
  all — the fetch itself is no longer what established viewer relevance. Reproduced with an
  `APPROVED`, non-viewer-team-requested PR under the label-driven scope: the prior unconditional clause
  wrongly kept it in the queue. The reviewer-scoping shell variable is now a single `search='...'`
  assignment (rather than a value inlined directly into `--search`), read by both the `gh pr list
--search "$search"` argument and a new `--arg scope "$search"` passed to the `--jq` reduction, so the
  team-request clause now only applies `and ($scope == "review-requested:@me")`. Editing that one
  variable to switch scopes keeps the `--search` argument and the jq's scope check in lockstep, with no
  second edit required. 003 §11.9's field-selection paragraph and reviewer-scoping table, and 004 §3.6's
  scenario table, are updated to describe the scope-conditional rule; a new
  `apps/cli/src/commands/pr-alerting-presets.test.ts` regression drops an `APPROVED` PR with only a
  team review request once `search=` is switched to `label:needs-review`.
- **The `unset` doc comment claimed the wrapper scrubs three inherited overrides
  (`GH_TOKEN GITHUB_TOKEN GH_REPO`)**, but the shipped script actually scrubs five, also unsetting
  `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` (added to close the Enterprise-token identity-mismatch
  finding from a prior round). The doc comment is corrected to name and explain all five.

