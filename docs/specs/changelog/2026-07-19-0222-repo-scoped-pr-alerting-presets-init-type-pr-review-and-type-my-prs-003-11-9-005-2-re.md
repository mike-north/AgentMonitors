## 2026-07-19 — Repo-scoped PR-alerting presets: `init --type pr-review` and `--type my-prs` (003 §11.9, 005 §2) — Refs #444

Added two ready-made `command-poll` presets to `init --type`, one per pull-request role: `pr-review`
(reviewer — open, non-draft PRs awaiting review, excluding `changeset-release/*` heads) and `my-prs`
(author — CI, review feedback, and state changes on the current `gh` user's own PRs). Both are new
`TEMPLATES` entries only; no source, schema, or runtime behavior changed.

Three contract points are now specified rather than left to the author of each hand-written monitor:

1. **Repository auto-scoping is achieved by omission of `--repo`, plus an explicit scaffolded `cwd:`.**
   `gh` resolves the repository from its working directory, and `command-poll`'s effective `cwd`
   defaults to the **daemon's own** process working directory (003 §11.1) — not a "workspace/config
   root", which an earlier draft of this entry, `init.ts`'s own comment, 003 §11.9, 005 §2, and this
   PR's changeset all incorrectly claimed (corrected below, 2026-07-19). `init` scaffolds an explicit,
   absolute `cwd:` (the project root it was run from) into both presets specifically to fix that: it is
   what then lets omitting `--repo` scope `gh` correctly, regardless of where the daemon is later
   launched from. Interpolating an owner/name at scaffold time is explicitly rejected — it would
   hardcode what `cwd:` makes portable. `--author @me` applies the same auto-scoping rule to identity.
2. **Which fields are diffed is the real product decision.** `json-diff` fires on any semantic change
   to stdout, so the `--jq` reduction decides what becomes an interrupt. `my-prs` reduces
   `statusCheckRollup` to only the _failing_ check names, which is what makes green→red fire while
   the queued/in-progress churn of a normal CI run stays silent; diffing the rollup whole would
   interrupt once per check, per push.
3. **A broken `gh` is a loud failure, not a silent baseline.** 003 §11.2/§11.5 classify a nonzero exit
   _with output_ as a normal result, so a preset that merely `exit 1`-ed on `gh` failure would record
   the error text as its first baseline and never fire again. Both presets instead terminate by
   signal (`kill -TERM $$`) after writing a remedy to stderr, which §11.5 classifies as an execution
   failure: `Command failing: <key>` is emitted on the very first tick, the remedy travels in
   `stderrTail`, any prior baseline is preserved, the alert is edge-triggered, and recovery emits
   `Command recovered: <key>`.

Both presets are `normal` urgency, and the `my-prs` case establishes a general rule (002 §9, 003
§11.9). The intuitive call is `high` — a stalled PR of one's own is interrupt-worthy — but
`json-diff` is **symmetric**: a PR leaving an actionable state diffs exactly as much as one entering
it, so CI recovering red→green, a PR merging, and one's own new PR appearing all fire too. Filtering
the payload down to only actionable PRs does not fix this; it relocates the benign fire from "a field
changed" to "an entry was removed", which the diff reports identically. Since no payload design makes
every fire actionable, `high` would interrupt mid-turn on good news (#441). Generalized: **`high` is
only defensible for a `json-diff` monitor when the watched value cannot transition back to a benign
state**, because at the diff layer recovery is indistinguishable from breakage.

Two field traps are recorded rather than left for the next author to rediscover. `reviewDecision` is
the empty string, not `null`, when there is no decision, so a `// "NONE"` coalesce is a silent no-op.
And `--limit` makes the query a recency window, not a set: an old PR aging out produces a removal
diff that is not a transition, which the monitor body calls out explicitly.

Collapsing `statusCheckRollup` to a single `PASSING`/`PENDING`/`FAILING` verdict was considered and
rejected: it is quieter than the raw array but reintroduces the churn one level up, firing twice on
every ordinary push (`PASSING → PENDING → PASSING`) even when CI never breaks. Reducing to failing
check _names_ stays silent across that whole cycle — asserted directly — and names the failing check
in the delivered event.

Known limitation, recorded rather than worked around: `gh pr list` exposes no review-thread data, so
inline review comments that do not move `reviewDecision` are invisible to `my-prs`. A first-class
`source-github-pr` plugin modelling PR transitions semantically remains the north star and would
close that gap; these presets deliver the capability without it.

