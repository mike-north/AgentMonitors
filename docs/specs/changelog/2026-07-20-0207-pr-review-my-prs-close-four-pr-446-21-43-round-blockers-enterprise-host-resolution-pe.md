## 2026-07-20 — `pr-review`/`my-prs` close four PR #446 21:43-round blockers: Enterprise host resolution, per-viewer review requests, mutable-title churn, and date-scoped terminal coverage (003 §11.9, 004 §3.6) — Refs #444, #446

Four inline findings from PR #446's `pullrequestreview-4739187751` review, plus the review body's
spec-drift/proof-test ask about `my-prs`'s open-PR limit:

- **`gh api user`'s identity lookup defaulted to `github.com` even on GitHub Enterprise**
  (`discussion_r3617759108`). `gh api user` is a bare, repo-less endpoint — it does not auto-detect
  a host the way `gh pr list`'s own repository resolution does. On a GHES checkout this either fails
  outright or, worse, compares a dotcom login against Enterprise PR authors that can never match,
  silently readmitting the current user's own PRs into the review queue. The fetch now asks `gh repo
view` (which DOES resolve host from the working directory) for the repository's URL, extracts its
  host, and passes it explicitly via `gh api user --hostname`.
- **A repo-wide `reviewDecision` could drop a PR from `pr-review` while THIS viewer's own review
  request was still outstanding** (`discussion_r3617759232`) — a multi-approval repository can show
  `reviewDecision: APPROVED` once one reviewer approves, while GitHub still lists the PR under
  "Requesting a code review from you" for a second. The fetch now also selects `reviewRequests`, and
  the reduction keeps a PR whose decision has moved past `REVIEW_REQUIRED` as long as the resolved
  identity is still listed there.
- **`title` was mutable presentation data inside a `high`-urgency membership snapshot**
  (`discussion_r3617759355`) — `json-diff` fires on any change to the whole diffed payload, so
  retitling a PR that was already, and remained, a member re-fired the interrupt for a PR nothing
  had actually happened to. `title` is no longer projected into either preset's reduced entry;
  `headRefName`/`author` (pr-review) and `url` (my-prs) already identify which PR an entry is about.
- **`my-prs`'s merged/closed calls relied on `--limit` plus `gh`'s newest-created-first ordering**,
  which can miss an older PR that only just entered the 6-hour terminal window
  (`discussion_r3617759463`), and — once `--search` is added to fix that — `gh` routes `--state
closed` through the search API, whose `is:closed` also matches merged PRs. The fetch now computes
  a portable `cutoff` (GNU `date -d @epoch`, falling back to BSD/macOS `date -r epoch`) once per
  tick and scopes each terminal call to `merged:>=$cutoff` / `closed:>=$cutoff -is:merged`,
  independent of creation order or volume.
- **003 §11.9 still described `my-prs`'s open-state call as `--limit 30`** after a prior delta
  raised it to `1000`, and the terminal-volume test that was supposed to prove the new bound (99
  merged rows, one open row) passed unchanged under either limit — it never actually exercised the
  argv. 003 is corrected to `--limit 1000`, and a new argv-level test in
  `apps/cli/src/commands/pr-alerting-presets.test.ts` asserts the shipped command carries `--limit
1000`, not `30`. The residual gap above 1000 concurrently open PRs is unchanged and is not claimed
  to be closed — see 003 §11.9 for the documented boundary.

004 §3.6's scenario table gains rows for all four fixes.

