## 2026-07-20 — PR-alerting presets: 003's field-selection paragraph re-aligned with the shipped `gh` query, and two further review findings closed (003 §11.9, 004 §3.6) — Refs #444, #446

003 §11.9's "Field selection is what makes the transitions observable" section still described a
superseded `pr-review` shape: `{number, title, headRefName, reviewDecision, author}` projected via
`--search '-author:@me'`. The shipped query (since the prior entry's reviewer-scoping fix) projects
`{number, title, headRefName, author}` — `reviewDecision` decides membership rather than being carried
as a field — and scopes via the configurable `--search`, defaulting to `review-requested:@me`. The
paragraph is corrected to match, and the adjacent "per-reviewer list" description is updated from
`{by, state}` to `{by, state, at}` to reflect the repeat-feedback fix from the prior entry.

Two further PR #446 review findings, addressed in the same delta:

**`GH_TOKEN`/`GH_REPO` were not scrubbed.** The shell wrapper unset only `GITHUB_TOKEN`, but `gh` gives
`GH_TOKEN` higher precedence still, and `GH_REPO` overrides repository selection outright — either
inherited variable could silently redirect a preset to the wrong identity or repository despite `@me`
and the explicit `cwd:`. The wrapper now scrubs all three (`env -u GH_TOKEN -u GITHUB_TOKEN -u
GH_REPO`). The wrapper's stderr temp file also moved from a predictable `$$`-PID-based path (removed by
explicit `rm -f` on each branch, so a `SIGKILL` between creation and either branch could leak it) to an
`mktemp`-created private file removed by an `EXIT` trap, which additionally survives the wrapper's own
`kill -TERM $$` self-signal and `command-poll`'s `SIGTERM` timeout escalation.

**`my-prs`'s `commentCount` churned on the author's own replies and bot comments.** Since `commentCount`
growing is one of the signals that re-fires an already-actionable entry, every self-reply or bot status
comment produced a spurious high-urgency interrupt. The count now excludes comments whose author is the
PR's own author (`author.login`, now fetched alongside the other fields) or whose login ends `[bot]`.

Not addressed in this delta, evaluated and left open with rationale (PR #446 review):

- **A newly-opened draft PR enters `my-prs`'s `draft` membership**, which is a benign, self-caused
  transition rather than a true "someone acted on your PR" signal. This is a structural limit of
  stateless `json-diff` polling: distinguishing "just created as a draft" from "pulled back to draft
  after being ready" requires state `command-poll` does not carry between ticks. The scaffolded body
  already tells the author how to tell the two apart ("If you did not just put it there, someone pulled
  it back"), and `apps/cli/src/commands/pr-alerting-presets.test.ts` gained a characterization test
  pinning this documented, accepted shape so it can't silently drift.

004 §3 gained a new §3.6 mapping the presets' required scenarios (reviewer scoping, disjointness,
environment/temp-file hardening, terminal time-bounding, `commentCount` filtering, graceful
degradation, portability) to `apps/cli/src/commands/pr-alerting-presets.test.ts`'s describe blocks, per
§6's spec-change checklist.

