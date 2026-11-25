## 2026-07-19 — PR-alerting presets: correct the `cwd` claim, exclude own PRs, fix the recency window, GITHUB_TOKEN, stderr, and curated names (003 §11.9, 005 §2) — Refs #444

Review of the presets added below (same date, same issue) surfaced eight defects, all fixed here:

1. **`cwd` claim was wrong.** `command-poll`'s effective `cwd` defaults to the **daemon's own** process
   working directory, never a "workspace/config root" — the daemon could be launched from anywhere. The
   original text (and `init.ts`'s comment, and this PR's changeset) all said otherwise. Fixed by having
   `init` scaffold an explicit, absolute `cwd:` (the project root `init` was run from) into both
   presets, and correcting every doc/comment that repeated the wrong claim. See the corrected item 1 of
   the entry directly below.
2. **`GITHUB_TOKEN` precedence.** `gh` gives an inherited `GITHUB_TOKEN` unconditional precedence over
   keyring/`gh auth login` credentials, so a daemon environment with one exported would silently
   resolve `@me` against the wrong identity. The generated wrapper now runs `gh` via `env -u
GITHUB_TOKEN`.
3. **`pr-review` included the user's own PRs.** Added `--search '-author:@me'` (GitHub search-qualifier
   negation — `gh pr list` has no `--author`-exclusion flag) so a PR the reviewer opens themselves no
   longer double-fires against both presets.
4. **`my-prs`'s sliding window could silently drop an open PR.** `--state all --limit 10` lets an older
   still-open PR age out once enough newer PRs (including merged/closed ones) exist; once evicted, its
   CI going red produced no event. Changed to `--state open --limit 30`: only actually-open PRs compete
   for the cap, and leaving the open set (merge or close) now surfaces as a removal, same as
   `pr-review`. Trade-off: `state` can no longer read `MERGED`/`CLOSED` from real `gh` output (it is
   still carried for shape symmetry), so the body now says to check the PR directly to tell which.
5. **`2>&1` on the success path could pollute the diffed JSON.** A one-time `gh` warning would have
   merged into stdout and degraded `json-diff` to a raw-text comparison. The wrapper now redirects
   stderr to a per-invocation temp file only consulted on the failure branch.
6. **The named scaffold path clobbered curated preset names.** `init pr-review --type pr-review`
   derived `name: Pr review` from the positional, overwriting the template's own `name: PRs awaiting my
review`. The derived-name seed is now skipped for preset types (`--name` still overrides), and
   005 §2's "re-type the name" workaround text is removed since it's no longer needed.
7. **The interactive prompt modeled presets as source types**, contradicting 005 §2's own "not source
   types" claim. The prompt and its error now list source types and presets as separate categories.
8. **`--urgency` seeding could contradict the rationale comment above it.** Seeding a different urgency
   left the preset-specific "why this value" comment attached to the wrong value. `seedUrgency` now
   swaps in a generalized comment when the seeded value differs, mirroring `seedCommand`'s existing
   #388 pattern.

Test coverage added: an end-to-end scaffold-then-parse test for both presets (with and without
`--urgency`), a CI-only failure (not skip) when the jq suite's `jq` binary is missing, and cleanup of
the test file's temp directories and a dead `MONITOR.md` write that nothing ever read.

