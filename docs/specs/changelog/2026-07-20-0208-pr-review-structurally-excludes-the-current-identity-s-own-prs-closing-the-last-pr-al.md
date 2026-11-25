## 2026-07-20 — `pr-review` structurally excludes the current identity's own PRs, closing the last PR-alerting cross-monitor firing (003 §11.9, 004 §3.6) — Refs #444, #446

PR #446 review, thread `discussion_r3615190027`, the last open finding: a prior revision's
`pr-review`/`my-prs` disjointness held only under the default `--search 'review-requested:@me'`
scope — under the label-driven or unscoped alternatives this same scaffold ships as ready-to-edit
options (the ones required when author and reviewer share an identity), a PR you authored yourself
could still enter `pr-review`'s payload, and a single CI transition on it then diffed on **both**
independently-scheduled monitors in the same tick. An earlier delta documented this as an "accepted
residual"; the reviewer correctly rejected that framing — reclassifying a bug as documented behavior
does not make the duplicate alert disappear.

The fix moves the exclusion from `--search` (server-side, scope-dependent) into the `--jq` reduction
(local, unconditional): `pr-review`'s fetch now runs `gh api user --jq '{login}'` before `gh pr
list`, and the reduction drops any PR whose `author.login` matches the resolved identity before any
other filter runs, regardless of which `--search` qualifier is active. Because PR authorship never
changes, a PR now belongs to at most one preset's payload for its entire lifetime — the two payloads
partition by **role first, then readiness** — so no PR can ever cross between them. This closes the
crossing entirely rather than reducing its frequency: 003 §11.9's "The two presets must not overlap"
section is rewritten to describe the new mechanism and remove the "residual" framing; 004 §3.6's
scenario table gets a row for the new structural guarantee, replacing the row that pinned the
old residual's exact shape.

Two other threads closed in the same delta, both from the same final review round
(pull request review `pullrequestreview-4738740767`):

- **`my-prs`'s open-PR coverage was still capped at `--limit 30`** even after a prior delta split
  open/merged/closed into three separate `gh pr list` calls (issue #444 review, finding 989) — an
  author with more than 30 concurrently open PRs could still have an older one silently evicted, and
  its later CI failure or review feedback would go unobserved. The open-state call now uses
  `--limit 1000` (not claimed as a mathematical guarantee — an author who genuinely sustains over a
  thousand simultaneously open PRs would hit the same failure shape at a much higher threshold, which
  is not this preset's realistic operating range); the terminal `merged`/`closed` calls stay at
  `--limit 20` each, since their coverage requirement (outlast the 6-hour terminal window) is bounded
  by construction and does not benefit from widening.
- **A PR opened directly as a draft enters `my-prs`'s `needs: draft` membership exactly like a PR
  pulled back to draft does**, which 003 previously described as contradicting an absolute "every
  entering transition is actionable" invariant. `command-poll`'s stateless `json-diff` polling has no
  history that would let the reduction distinguish "the author's own deliberate first action" from
  "someone pulled a decided PR back," so this is accepted rather than engineered around (a prior delta
  already pinned it as a characterization test). 003 §"Membership, not full state" now states the
  narrower, accurate invariant — entering transitions are actionable far more often than not, with
  this one documented, non-spurious exception — instead of the absolute claim the exception
  contradicted.

Test coverage: `apps/cli/src/commands/pr-alerting-presets.test.ts`'s "the two presets do not overlap"
block now constructs its cross-payload fixtures with an explicit current-identity author override
(`rawReviewPr`'s own default author changed to a distinct, non-current identity — 'contributor' — so
the reviewer-queue-only tests keep exercising the ordinary "someone else's PR" case) and asserts the
CI-crossing transition fires `my-prs` alone, never `pr-review`, replacing the prior test that pinned
the two-monitor double-fire as expected. A new argv-level test in "reviewer scoping" asserts the `gh
api user` identity call is present unconditionally. `stubGhApplyingJq`/`stubGhEchoingFixture` both
gained an `identityLogin` parameter so they can answer `pr-review`'s new second `gh` call.

