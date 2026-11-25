## 2026-07-19 — PR-alerting presets: selectable reviewer scoping, a review-revision signal, and time-bounded terminal states (003 §11.9, 005 §2) — Refs #444

Three review findings, each of which defeated one of the goals the presets exist to serve.

**1. The reviewer preset was not scoped to a reviewer.** It returned every open, non-draft,
non-release PR — including the user's own — so it alerted on work the reviewer did not own, and
unrelated rows could consume the 30-row window and hide a real request. Reviewer scoping is
**workflow-dependent**, so the fix is a documented default (`--search 'review-requested:@me'`, the
semantically exact reading, which also covers team-assigned requests) plus `-author:@me`,
`label:needs-review`, and unscoped scaffolded as ready-to-edit alternatives. Measured against this
repository: unscoped returns 6 open PRs, `review-requested:@me` returns 0, and no open PR carries a
requested reviewer — PRs are authored and reviewed under one identity, and GitHub does not permit
requesting review from yourself, which also makes `-author:@me` empty here. Hardcoding any single
filter would take the preset from "too many PRs" to "zero PRs, ever" for some workflow. The empty
case is **silent** — indistinguishable from "nothing needs review" — so the scaffolded body names it
and gives the exact command to check; a `validate`/`monitor test` warning on a zero-row first run
needs support in those commands and is recorded as the follow-up rather than claimed.

**2. Repeat feedback from the same reviewer was invisible.** Reducing each latest review to
`{by, state}` meant a second `CHANGES_REQUESTED` from the same reviewer left `reviewDecision`, the
reduced array, and `commentCount` all unchanged — so `json-diff` emitted nothing even though new
blocking feedback had landed, breaking the single most important author-side trigger. Reviews now
carry `at` (`submittedAt`), which is fixed at submission and therefore a revision signal that cannot
churn between polls, and are sorted by `(by, at, state)` so ordering cannot flap the diff.

**3. Terminal states are now time-bounded to 6h** after `mergedAt`/`closedAt`, rather than lingering
until they fall out of `--limit`. Unbounded, every new merge evicted an older terminal row from the
window and emitted a spurious removal diff — a spurious interrupt at `high` urgency. Time-bounding
makes each terminal PR produce exactly one entry and one predictable drop-off, independent of
`--limit`. The bound reads `mergedAt`/`closedAt`, never `updatedAt`, so post-merge activity cannot
extend it, and **no timestamp is emitted into the payload**: a timestamp in the diffed output changes
on essentially every poll and fires continuously. `fromdateiso8601` errors outright on fractional
seconds, so the query strips them and treats an unparseable timestamp as current (fail-open — a stale
row beats a missed merge alert).

Separately: the presets set an explicit `key:`, which is what keeps the delivered event title short
(`Command output changed: my-prs`) instead of the joined argv — a `command-poll` monitor that omits
`key:` gets its entire `gh` command and `--jq` program as the alert headline. Making the title use the
monitor's authored `name` is a source-level change affecting every `command-poll` monitor and is
tracked as issue #449, not done here; a regression guard keeps the presets from drifting back to the
raw-argv title.

