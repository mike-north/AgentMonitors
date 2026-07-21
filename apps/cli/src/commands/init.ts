import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import { readLocalState } from '../local-state.js';
import { COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND } from './scaffold-defaults.js';
import { validateCommand } from './validate.js';

const yaml = String.raw;
const md = String.raw;

/**
 * The `command-poll` template's advisory comment above its illustrative
 * `command:` block. Shared with {@link COMMAND_POLL_CONTRACT_COMMENT} (both
 * used by {@link TEMPLATES} and by `seedCommand` below) so the two can never
 * drift apart: when `--command` replaces the scaffolded command, the
 * example-specific narrative (which explains the fetch-lag semantics of the
 * illustrative `git ls-remote` default) no longer describes what's seeded, so
 * `seedCommand` swaps this exact text for the generalized contract-only
 * comment.
 */
const COMMAND_POLL_EXAMPLE_COMMENT =
  '  # command is an argv array, run directly (no shell). This example queries the\n' +
  '  # remote branch tip live: "git ls-remote" hits the network on every run, so it\n' +
  '  # is always current — no prior fetch needed. Only a LOCAL read of a\n' +
  '  # remote-tracking ref, such as "git rev-parse origin/main", reflects just your\n' +
  '  # last fetch and can lag until you fetch again. A local working-tree command\n' +
  '  # such as "git status --porcelain" has no fetch lag either.\n';

/**
 * The generalized replacement for {@link COMMAND_POLL_EXAMPLE_COMMENT} once a
 * `--command` seed has overwritten the illustrative default: only the
 * source-contract clause applies to an arbitrary seeded command.
 */
const COMMAND_POLL_CONTRACT_COMMENT =
  '  # command is an argv array, run directly (no shell).\n';

/**
 * The `command-poll` template's illustrative `command:` list, rendered
 * directly from {@link COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND} (in
 * `scaffold-defaults.ts`) rather than duplicated as a second literal. This
 * makes that module's "used by the scaffolder" claim structurally true: the
 * template's default argv and `isUntouchedCommandPollDefault`'s comparison
 * target are the same array, so they cannot silently diverge. Every token in
 * {@link COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND} is a plain, unquoted-safe YAML
 * scalar (no `'`, `#`, `:`, or leading `-`), so plain scalars are correct
 * here — this is not the general seeding path and does not call
 * `yamlSingleQuoted`.
 */
const COMMAND_POLL_DEFAULT_COMMAND_BLOCK =
  COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND.map((token) => `    - ${token}`).join(
    '\n',
  );

/**
 * Shell preamble shared by the two PR-alerting presets (`pr-review`,
 * `my-prs`). Both run `gh` through `sh -c` rather than as a bare argv array so
 * a `gh` that is missing, unauthenticated, or pointed at a non-GitHub
 * directory becomes a **loud** condition instead of an empty-output baseline
 * that never fires again.
 *
 * The mechanism is deliberate. `command-poll` classifies a nonzero exit *with*
 * output as a normal result (003 §11.2/§11.5), so a plain `exit 1` here would
 * be diffed like any other output: the very first tick would silently record
 * the error text as the baseline and stay quiet forever. Terminating by a
 * signal instead (`kill -TERM $$`) is classified as an execution **failure**,
 * which emits the `Command failing: <key>` health observation on the very
 * first tick, preserves any prior baseline rather than re-baselining onto
 * garbage, and emits `Command recovered: <key>` once `gh` works again
 * (003 §11.5). The human-readable remedy is written to stderr, which the
 * failure observation carries as `stderrTail`.
 *
 * `$$` is the `sh` process's own PID — not `-$$`, which would signal the whole
 * process group and reach siblings this monitor does not own.
 *
 * `unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_REPO` (below, once per
 * script) scrubs five inherited overrides before invoking `gh`. `GH_TOKEN`/`GITHUB_TOKEN` each give
 * unconditional precedence over keyring/`gh auth login` credentials on github.com (`GH_TOKEN` takes
 * priority over `GITHUB_TOKEN` when both are set); `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` do
 * the same for a GHES host (PR #446 review, thread `discussion_r3624050247`) — so a daemon process
 * that happens to have any of the four exported (a common shell-startup leftover) would make `@me` —
 * and therefore both presets — silently resolve against the wrong identity, with no error to surface
 * it. `GH_REPO` overrides which repository `gh pr list` targets outright, which would silently defeat
 * the working-directory-based auto-scoping below. Scrubbing all five is the same fix this repo's own
 * tooling applies to every non-interactive `gh` invocation. `unset` rather than `env -u` per call is
 * what makes this scrub apply uniformly across a multi-call `fetchCmd` (see {@link ghPresetScript}) —
 * `env -u ... cmd1 && cmd2` would only wrap `cmd1`.
 *
 * Only the failure branch's `2>"$errfile"` sees `gh`'s stderr: the success path's `out=$(...)`
 * captures stdout alone, so a one-time `gh` warning or `GH_DEBUG` chatter on an otherwise-successful
 * run can never leak into the diffed JSON (which would otherwise degrade `json-diff` to a raw-text
 * comparison of the polluted string). `$errfile` is created with `mktemp` (private, mode 0600, and
 * collision-proof — no predictable PID-based path for a shared `/tmp` to pre-seed with a symlink) and
 * removed by an `EXIT` trap rather than explicit `rm -f` calls on each branch, so it is also cleaned up
 * on a `kill -TERM $$` self-signal (the failure branch below) or an external `SIGTERM` from
 * `command-poll`'s own timeout escalation (003 §11.2/§11.7) — a signal a shell with no trap for that
 * signal still runs its `EXIT` trap for, per POSIX. `SIGKILL` cannot be trapped by any shell, so that
 * one remaining escalation step is the only path a stale file can survive under — the same limit every
 * `mktemp`-based script has.
 *
 * Note the absence of `--repo`: `gh` resolves the repository from its process
 * working directory. Neither preset's frontmatter carries an explicit `cwd:`
 * — `command-poll` resolves an omitted `cwd` against the **runtime**
 * workspace/config root for a project monitor (003 §11.1), which is where
 * this repository's `MONITOR.md` lives, so `gh` lands in the right directory
 * without a path baked into the file at scaffold time. Omitting `--repo` is
 * what then lets that resolved working directory scope `gh` to the right
 * repository; interpolating an owner/name at scaffold time would hardcode it
 * right back.
 *
 * `fetchCmd` is one `gh` invocation, or several joined by `&&` (see
 * {@link MY_PRS_FETCH} — issue #444 review, finding 989): a `&&` chain
 * short-circuits on the first failure, so `raw=$(${fetchCmd} ...)`'s own
 * exit status still reflects the FIRST failing `gh` call even when later
 * calls in the chain never run, which is what keeps the loud-failure
 * contract above intact for a multi-call fetch.
 *
 * `reduceJq` runs as a separate `jq -sc` stage over the fetch's raw stdout,
 * not as `gh`'s own `--jq` flag: `-s`/`--slurp` folds however many top-level
 * JSON values `fetchCmd` printed (one per `gh` call) into one array of those
 * values, in call order. When every call prints a JSON array of the same
 * shape ({@link MY_PRS_FETCH}'s three `gh pr list` calls), `reduceJq` starts
 * with `add` to flatten the array-of-arrays back to a single array of PRs —
 * for a one-call `fetchCmd` this is a no-op (`[[...]] | add == [...]`), so
 * that `reduceJq` body is unchanged from when it ran as `gh --jq`. When the
 * calls print DIFFERENT shapes ({@link PR_REVIEW_FETCH}'s `gh api user`
 * object followed by its `gh pr list` array), `reduceJq` instead selects each
 * value by `type` (see {@link PR_REVIEW_REDUCE}) — `add` would be a type
 * error over a mixed object/array slurp.
 */
function ghPresetScript(
  preset: string,
  fetchCmd: string,
  reduceJq: string,
  options: { preamble?: string; jqArgs?: string } = {},
): string {
  const failureMessage = `printf 'agentmonitors %s: the GitHub CLI query failed, so PR alerting is NOT running.\\nFix one of these, then re-run: agentmonitors monitor test <this file>\\n  1. Install the GitHub CLI: https://cli.github.com\\n  2. Authenticate it: gh auth login\\n  3. Install jq: https://jqlang.org (both gh and jq are required)\\n  4. Run the daemon from inside a git repo that has a GitHub remote.\\n' '${preset}' >&2`;
  const preamble =
    options.preamble === undefined ? '' : `${options.preamble}\n`;
  const jqArgs = options.jqArgs === undefined ? '' : `${options.jqArgs} `;
  return `errfile=$(mktemp "\${TMPDIR:-/tmp}/agentmonitors-${preset}-XXXXXX" 2>/dev/null) || {
  ${failureMessage}
  kill -TERM $$
  exit 1
}
trap 'rm -f "$errfile"' EXIT
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_REPO
if ! command -v jq >/dev/null 2>&1; then
  printf 'jq: command not found\\n' >"$errfile"
  cat "$errfile" >&2
  ${failureMessage}
  kill -TERM $$
  exit 1
fi
${preamble}if raw=$(${fetchCmd} 2>"$errfile") && out=$(printf '%s\\n' "$raw" | jq -sc ${jqArgs}'${reduceJq}' 2>>"$errfile"); then
  printf '%s\\n' "$out"
else
  cat "$errfile" >&2
  ${failureMessage}
  kill -TERM $$
  exit 1
fi`;
}

/**
 * `pr-review`'s urgency-rationale comment, above `urgency: normal` in the
 * template. Extracted to a constant (rather than inlined) so
 * {@link seedUrgency} can swap it out for {@link GENERALIZED_URGENCY_COMMENT}
 * when `--urgency` overrides the seeded value — otherwise a seeded
 * `--urgency high` would ship directly under a comment explaining why it is
 * `normal, not high` (mirrors {@link COMMAND_POLL_EXAMPLE_COMMENT}'s
 * issue-#388 swap pattern).
 */
const PR_REVIEW_URGENCY_COMMENT =
  '# high, and that is only safe because the payload is a MEMBERSHIP set of PRs\n' +
  '# that actually need reviewing right now: a PR that has been decided leaves the\n' +
  '# set instead of churning a field inside it, so there is no benign per-push or\n' +
  '# per-comment traffic to interrupt on. `normal` was tried and rejected — normal\n' +
  '# reminders are coalesced-until-ack (002 §9.2), so one claimed-but-unacked\n' +
  '# normal event from ANY monitor suppresses the reminder for all of them, and\n' +
  '# normal carries no event BODY mid-session (002 §9.2/§9.3), so the reviewer\n' +
  '# would not learn WHICH PR needs review until session recap.\n';

/**
 * `my-prs`'s urgency-rationale comment, above `urgency: high` in the
 * template; see {@link PR_REVIEW_URGENCY_COMMENT}. `high` is earned here by
 * the payload filter: only PRs that need the author to act are in the list
 * at all, so an ordinary CI run (queued -> running -> passing) produces no
 * event, and `normal`'s coalesce-until-ack + no-mid-session-body behavior
 * (002 §9.2/§9.3) was tried in the field and does not work for this preset
 * (003 §11.9).
 */
const MY_PRS_URGENCY_COMMENT =
  '# high, earned by the payload filter above: only PRs that need YOU to do\n' +
  '# something are in the list at all, so an ordinary CI run (queued -> running ->\n' +
  '# passing) produces no event. `normal` was tried in the field and does not work\n' +
  '# here, for two compounding reasons (002 §9.2/§9.3):\n' +
  '#   1. Normal reminders are coalesced-until-ack. One claimed-but-unacked normal\n' +
  '#      event from ANY monitor suppresses the coalesced reminder for ALL of them,\n' +
  '#      which in an active session is nearly always true — so a normal author\n' +
  '#      monitor goes silent exactly when the agent has been busy.\n' +
  '#   2. Normal delivers no event BODY mid-session; bodies arrive only at recap.\n' +
  '#      An author needs to know WHICH PR broke and HOW while still working.\n' +
  '# Not every fire is actionable: a PR LEAVING the list (CI fixed, review\n' +
  '# answered, draft marked ready) also diffs. Those are one-per-cycle\n' +
  '# confirmations, not a storm, and the body below names them so they are cheap\n' +
  '# to dismiss.\n';

/**
 * Generalized replacement for {@link PR_REVIEW_URGENCY_COMMENT} /
 * {@link MY_PRS_URGENCY_COMMENT} once a `--urgency` seed has overwritten the
 * preset's own default: neither preset-specific rationale describes the
 * seeded value, so only the general contract pointer applies.
 */
const GENERALIZED_URGENCY_COMMENT =
  '# urgency overridden via --urgency; see 002 §9 for how each level is delivered.\n';

/** Maps a preset `--type` to its urgency-rationale comment, for
 * {@link seedUrgency}'s comment-swap. Types with no such comment (every
 * non-preset template) are absent, so the swap is a no-op for them. */
const PRESET_URGENCY_COMMENTS: Partial<Record<string, string>> = {
  'pr-review': PR_REVIEW_URGENCY_COMMENT,
  'my-prs': MY_PRS_URGENCY_COMMENT,
};

/** Indent a multi-line shell script to sit under a YAML `- |` block scalar. */
function yamlBlockScalar(script: string, indent: string): string {
  return script
    .split('\n')
    .map((line) => (line === '' ? '' : `${indent}${line}`))
    .join('\n');
}

/**
 * How long after merge/close a terminal PR stays in `my-prs`'s payload (6h).
 *
 * Terminal state is *briefly* actionable — delete the branch, close the issue —
 * and then it is history. Bounding membership by time rather than letting
 * terminal rows accumulate until they fall out of `--limit` is what makes the
 * drop-off predictable: without it, every new merge evicts an older terminal row
 * from the window and emits a spurious removal diff, which at `high` urgency is
 * a spurious interrupt. With it, each terminal PR produces exactly one entry and
 * one time-predictable drop-off, independent of `--limit`.
 *
 * The bound reads `mergedAt`/`closedAt` — **not** `updatedAt`. Those are fixed
 * at the moment of merge/close, so a post-merge comment cannot silently extend
 * the window, and neither timestamp is ever emitted into the payload: a
 * timestamp in the diffed output would change on essentially every poll and fire
 * continuously.
 */
const TERMINAL_WINDOW_SECONDS = 21600;

/**
 * The default reviewer-scoping search for `--type pr-review`.
 *
 * **There is no single filter that is correct for every workflow**, so this is a
 * documented default with alternatives scaffolded as ready-to-uncomment options
 * (see {@link PR_REVIEW_SCOPE_COMMENT}). `review-requested:@me` is the
 * semantically exact reading of "PRs awaiting *my* review" and is right for the
 * common team workflow where review is explicitly requested. It matches nothing
 * in two real cases: a solo maintainer, and an agent fleet where PRs are opened
 * and reviewed under the same identity (GitHub does not permit requesting review
 * from yourself). Measured against this repository: unscoped returns 6 open PRs,
 * `review-requested:@me` returns 0, and no open PR has any requested reviewer.
 *
 * That failure is **silent** — an empty result is indistinguishable from "nothing
 * needs review" — so the scaffolded body says so prominently and tells the author
 * how to check.
 */
const PR_REVIEW_DEFAULT_SCOPE = 'review-requested:@me';

/**
 * The single shell-variable assignment an author edits to switch
 * {@link PR_REVIEW_FETCH}'s reviewer scope, declared once at script top level
 * (outside the `fetchCmd` subshell, so both the `gh pr list --search`
 * argument and {@link PR_REVIEW_REDUCE}'s scope-conditional team-request
 * clause read the SAME value — see {@link PR_REVIEW_REDUCE}'s doc comment on
 * `discussion_r3624450049`). Editing only the string literal that used to be
 * inlined into the `--search` flag left the `--jq`'s team-request handling
 * unaware of which scope was actually running; threading it through one
 * variable instead means an author who switches to `label:needs-review` or
 * an empty (unscoped) search gets scope-correct team-request behavior for
 * free, without touching the `--jq`.
 */
const PR_REVIEW_SEARCH_PREAMBLE = `search='${PR_REVIEW_DEFAULT_SCOPE}'`;

/**
 * The scaffolded comment block above `pr-review`'s `command:`, listing the
 * reviewer-scoping alternatives so an author in any of the four workflows can
 * get a working monitor by editing one string rather than rewriting the `--jq`.
 */
const PR_REVIEW_SCOPE_COMMENT =
  "  # REVIEWER SCOPING — the search='...' line inside the command below decides\n" +
  '  # WHOSE review queue this is (it feeds both the --search flag and the --jq\n' +
  '  # below, so editing it here is the only edit you need). There is no filter\n' +
  '  # that is correct for every workflow; the default suits explicit team review\n' +
  '  # requests. If this monitor never fires, this is almost certainly why — check\n' +
  '  # with:\n' +
  '  #   gh pr list --state open --search "review-requested:@me"\n' +
  '  # and if that prints nothing while open PRs exist, switch search= to one of:\n' +
  '  #   review-requested:@me   (default) explicit review requests — includes\n' +
  '  #                          team-assigned requests, since GitHub expands a\n' +
  '  #                          team request to its members for this qualifier,\n' +
  '  #                          and only this default keeps a PR in the queue on\n' +
  '  #                          a pending TEAM request alone once some other\n' +
  "  #                          reviewer approval already satisfies the repo's\n" +
  '  #                          decision. Matches NOTHING for a solo maintainer,\n' +
  '  #                          or when PRs are authored and reviewed under one\n' +
  '  #                          identity.\n' +
  '  #   -author:@me            "I review everyone else\'s work". Matches nothing\n' +
  '  #                          when every PR is authored by you.\n' +
  '  #   label:needs-review     label-driven. The only option that works when\n' +
  '  #                          author and reviewer are the same identity.\n' +
  '  #   (empty search=)        unscoped: every open PR. Fine for a small repo\n' +
  '  #                          where you review everything; at scale unrelated\n' +
  '  #                          PRs consume the 30-row window.\n' +
  '  # PRs you authored yourself never enter this list, whichever scope you\n' +
  '  # choose (enforced in the --jq below, not just by --search), so this list\n' +
  '  # never overlaps the my-prs preset — see my-prs for your own PRs.\n';

/**
 * `--type pr-review`'s `gh` query: PRs in the current repo that are **actually
 * awaiting review right now** — open, non-draft, not a `changeset-release/*`
 * release PR, not yet decided (`reviewDecision` empty or `REVIEW_REQUIRED`),
 * within the configured reviewer scope ({@link PR_REVIEW_DEFAULT_SCOPE}), **not
 * authored by the current `gh` identity**, and **not failing CI**.
 *
 * Membership is the signal, which is what lets this preset run at `high`
 * urgency (see the template's urgency comment). Every PR *entering* this set
 * needs reviewing: newly opened, or a draft marked ready — drafts are excluded,
 * so "marked ready" surfaces as an appearance. `reviewDecision` is encoded as
 * membership rather than carried as a field, so a decision landing removes the
 * PR (one benign fire) instead of churning a value inside the set. `updatedAt`
 * is deliberately absent: it would fire on every push and comment.
 *
 * **The self-authored exclusion is what keeps this payload disjoint from
 * `my-prs` — structurally, under *every* reviewer-scoping model** (PR #446
 * review, thread `discussion_r3615190027`). A prior revision relied on
 * `gh pr list`'s `--search` qualifier for this: `review-requested:@me` cannot
 * match a PR you authored (GitHub forbids requesting your own review), so
 * disjointness held under the *default* scope, but not under the label-driven
 * or unscoped alternatives this same template scaffolds — the only options
 * that work when author and reviewer share an identity. Because the exclusion
 * lived only in `--search`, a PR you authored yourself could enter BOTH
 * presets' payloads under those scopes, and a single CI transition on it then
 * diffed on both independently-scheduled monitors in the same tick: one
 * dismissible "no longer review-ready" removal from `pr-review`, one
 * actionable entry into `my-prs` — issue #441's interrupt-multiplier,
 * reproduced by construction for anyone who followed the label-driven
 * guidance this file itself scaffolds.
 *
 * The fix moves the exclusion into the `--jq` reduction, where it holds
 * regardless of `--search`: `gh api user --jq '{login}'` resolves the current
 * identity ONCE per tick (joined by `&&`, same short-circuit-on-failure
 * contract as {@link MY_PRS_FETCH}'s multi-call chain), and
 * {@link PR_REVIEW_REDUCE} drops any PR whose `author.login` matches it before
 * any other filter runs. A PR can now belong to at most one preset's payload
 * for its entire lifetime — authorship never changes — so the two payloads
 * cannot merely be disjoint at a snapshot, they cannot cross between each
 * other at all: `my-prs`, not `pr-review`, is the only queue an authored PR
 * can ever appear in, on any tick, under any scope.
 *
 * **The identity lookup targets the SAME host `gh pr list` resolves the
 * repository against, not `github.com` unconditionally** (PR #446 review,
 * thread `discussion_r3617759108`). `gh api user` (a bare, repo-less
 * endpoint) does not auto-detect a host the way `gh pr list`'s own
 * repository resolution does — it defaults to `github.com` even when run
 * from inside a GitHub Enterprise checkout, so on GHES it either fails
 * outright or, worse, resolves a dotcom login and compares it against
 * Enterprise PR authors that can never match, quietly readmitting the
 * current user's own PRs into the review queue. The fetch therefore first
 * asks `gh repo view` — which DOES resolve host from the working directory,
 * the same mechanism `gh pr list` itself relies on — for the current
 * repository's URL, extracts its host, and passes that explicitly via `gh
 * api user --hostname`.
 *
 * **Excluding red PRs is a second, independent disjointness clause** for the
 * (common) case of PRs authored by someone else: a red PR is not
 * review-ready — it belongs to its author, and `my-prs` already classifies it
 * `ci-failing` for them. Without this clause a red, undecided, non-draft PR
 * authored by a third party would still be claimed by `pr-review` alone
 * (never by this repo's own `my-prs`, since that preset is scoped to `--author
 * @me`), so this clause is about correctness of the reviewer queue itself,
 * not cross-preset disjointness.
 *
 * **Membership also survives a repo-wide `reviewDecision` that a DIFFERENT
 * reviewer's approval already satisfied** (PR #446 review, thread
 * `discussion_r3617759232`). `reviewDecision` is a branch-protection-derived,
 * repository-wide verdict — GitHub can and does show a PR under "Requesting a
 * code review from you" even once `reviewDecision` reads `APPROVED`, when the
 * repository requires more than one approval and this viewer's own request is
 * still unresolved. Reducing membership to `reviewDecision` alone would drop
 * that PR from the queue while it still needs THIS viewer specifically. The
 * `--json` fetch therefore also carries `reviewRequests`, and
 * {@link PR_REVIEW_REDUCE} keeps a PR whose `reviewDecision` has moved past
 * `REVIEW_REQUIRED` as long as either the resolved identity's own `login`
 * still appears in that list, OR the list still contains a still-pending
 * TEAM request (PR #446 review, thread `discussion_r3624050268`).
 * `reviewRequests` is a union of requested-reviewer shapes: a direct user
 * request exposes `login`, but a `Team`/`EnterpriseTeam` request exposes only
 * a team `slug`/`name` — `gh` never expands a team request back out to its
 * individual members' logins in this field, even though `--search
 * review-requested:@me` itself DOES resolve team membership when selecting
 * which PRs to fetch in the first place. So a plain `.login == $me` check
 * can never match a team-requested PR, and once `reviewDecision` moves past
 * `REVIEW_REQUIRED` (a different reviewer's approval satisfying a
 * multi-approval policy) such a PR would silently drop out of the queue
 * while the viewer's own team-based request is still outstanding.
 *
 * **That team-request override is only sound while the active search
 * actually establishes viewer relevance** (PR #446 review, thread
 * `discussion_r3624450049`). Treating EVERY login-less `reviewRequests` entry
 * as "this viewer's team" was correct under the default
 * {@link PR_REVIEW_DEFAULT_SCOPE}, since `review-requested:@me` itself only
 * ever fetches PRs where a team the viewer belongs to was requested — but
 * this same template also scaffolds `label:needs-review` and an unscoped
 * search as supported alternatives (see {@link PR_REVIEW_SCOPE_COMMENT}),
 * and under either of those a fetched PR's team request can belong to a team
 * the viewer isn't even on. Applying the override unconditionally there kept
 * an unrelated, already-decided PR in the viewer's own high-urgency queue.
 * {@link PR_REVIEW_REDUCE} therefore only trusts a login-less
 * `reviewRequests` entry when `$scope` — the same
 * {@link PR_REVIEW_SEARCH_PREAMBLE} variable `gh pr list --search` itself
 * reads — is still the default `review-requested:@me`; under any other
 * scope, a team request no longer keeps a decided PR in the queue on its
 * own, and only the direct-login and undecided/red-CI clauses apply.
 */
const PR_REVIEW_FETCH =
  "host=$(gh repo view --json url --jq '.url' | sed -E 's#^https?://([^/]+)/.*$#\\1#') && " +
  'gh api user --hostname "$host" --jq \'{login}\' && ' +
  'gh pr list --state open --limit 30 ' +
  '--search "$search" ' +
  '--json number,title,isDraft,reviewDecision,headRefName,author,statusCheckRollup,reviewRequests';

/**
 * `reduceJq` for {@link PR_REVIEW_FETCH}. Slurped input is `[{login: "..."},
 * [...prs]]` — one JSON object (from `gh api user`) followed by one JSON array
 * (from `gh pr list`) — rather than {@link MY_PRS_REDUCE}'s multiple same-shaped
 * arrays, so this cannot start with `add` (folding an object and an array with
 * `add` is a type error). Selecting by `type` rather than by slurp position
 * (`.[0]`/`.[1]`) is deliberate: it stays correct even if `fetchCmd`'s two
 * calls were ever reordered, since `jq -s` preserves each call's own
 * originally-printed value, not a merged stream.
 *
 * A PR stays in the set when EITHER its `reviewDecision` has not yet passed
 * `REVIEW_REQUIRED`, OR the resolved identity's own `login` is still listed
 * in `reviewRequests`, OR — **only while `$scope` is still the default
 * `review-requested:@me`** — `reviewRequests` still lists a pending TEAM
 * request (an entry with no `login` field — see {@link PR_REVIEW_FETCH}'s doc
 * comment on `discussion_r3624050268` and `discussion_r3624450049`). The
 * first two clauses keep a PR visible when a multi-approval repository's
 * `reviewDecision` already reads `APPROVED` from someone else while this
 * viewer's own (direct or team-based) request is still outstanding (PR #446
 * review, thread `discussion_r3617759232`); the scope guard on the third
 * clause is what keeps a team request from a DIFFERENT team than the
 * viewer's own from wrongly extending that same protection once the
 * scaffolded `label:needs-review` or unscoped alternative is in use, where
 * `reviewRequests` was never filtered to the viewer's teams in the first
 * place (`discussion_r3624450049`). `$scope` is threaded in as a jq `--arg`
 * from the same `search` shell variable `gh pr list --search` itself reads
 * (see {@link PR_REVIEW_SEARCH_PREAMBLE}), so editing that one variable keeps
 * the `--search` argument and this clause's scope check in lockstep.
 *
 * `title` is deliberately NOT projected into the reduced entry (PR #446
 * review, thread `discussion_r3617759355`): it is mutable presentation data,
 * and `json-diff` fires on ANY change to the whole diffed payload — including
 * a field mutating on an entry that is already, and remains, a member. A
 * retitle would therefore re-fire the `high`-urgency interrupt for a PR
 * nothing actually happened to. `headRefName` and `author` already identify
 * which PR and branch to look at.
 */
const PR_REVIEW_REDUCE =
  '(.[] | select(type == "object") | .login) as $me | ' +
  '(.[] | select(type == "array")) as $raw | ' +
  '$raw | [.[] | select(.isDraft == false ' +
  'and (.headRefName | startswith("changeset-release/") | not) ' +
  'and (((.reviewDecision // "") == "") ' +
  'or (.reviewDecision == "REVIEW_REQUIRED") ' +
  'or (([.reviewRequests[]? | .login] | index($me)) != null) ' +
  `or ($scope == "${PR_REVIEW_DEFAULT_SCOPE}" ` +
  'and ([.reviewRequests[]? | select(has("login") | not)] | length > 0))) ' +
  'and (.author.login != $me) ' +
  'and ([.statusCheckRollup[]? | select(((.conclusion // .state // "") | ascii_upcase) as $c ' +
  '| $c == "FAILURE" or $c == "TIMED_OUT" or $c == "CANCELLED" or $c == "ERROR" ' +
  'or $c == "ACTION_REQUIRED" or $c == "STARTUP_FAILURE")] | length) == 0) ' +
  '| {number, headRefName, author: .author.login}] ' +
  '| sort_by(.number)';

/**
 * `--type my-prs`'s `gh` query: the current `gh` user's PRs in the current repo
 * (`--author @me` — never a baked-in username) that **need the author to do
 * something**.
 *
 * **The payload is a membership set of actionable PRs, not full state**, and
 * that is the precondition for `high` urgency (see the template's urgency
 * comment). Each PR is reduced to a single `needs` verdict and dropped entirely
 * when it is `none`:
 *
 * - `merged` / `closed` — terminal; the branch needs cleanup or the closure
 *   needs explaining. Terminal entries deliberately carry no
 *   `failingChecks`/`reviews`/`commentCount`, so post-merge comment activity
 *   cannot churn them.
 * - `ci-failing` — `statusCheckRollup` holds a failing entry (both `CheckRun`
 *   `conclusion` and legacy `StatusContext` `state`); `failingChecks` names
 *   them, so the delivered event says *which* check broke.
 * - `changes-requested` — blocking review feedback.
 * - `draft` — an open draft. Encoding draft as *membership* rather than as a
 *   diffed `isDraft` field is what keeps both directions firing: `false → true`
 *   enters the set, `true → false` leaves it.
 *
 * A green, non-draft, undecided open PR is `none` and never enters the payload,
 * so an ordinary CI run (queued → running → passing) produces no event at all.
 *
 * `commentCount` excludes the author's own comments (compared against `author.login`,
 * fetched alongside the other fields) and bot comments (`login` ending `[bot]`, the
 * GitHub convention for bot accounts — Dependabot, Copilot, most CI bots). Without
 * that filter, every reply the author posts to their own PR, or every bot status
 * comment, would increment `commentCount` on an already-actionable entry and
 * re-fire the high-urgency interrupt for activity that carries no new feedback
 * (PR #446 review).
 *
 * `my-prs` fetches THREE separate `gh pr list` calls — `--state open`, `--state merged`, and
 * `--state closed` ({@link MY_PRS_FETCH}) — rather than one `--state all` call, so that
 * merged/closed history can never compete with open PRs for a shared `--limit` window (issue #444
 * review, finding 989). A single `--state all --limit N` call orders newest-created-first across ALL
 * states, so on an active repository terminal PRs can consume most of the window (measured live: 15 of
 * 20 slots at `--limit 20`) and age a still-open PR out of the query entirely — after which its CI
 * going red would silently produce no event, forever, until it happened to re-enter the window. Three
 * separate calls each get their OWN `--limit`, so open coverage can never be displaced by terminal
 * history.
 *
 * **Open coverage is `--limit 1000`** ({@link MY_PRS_OPEN_LIMIT}), not `30` (issue #444 review,
 * finding 989's follow-up: `--limit 30` still evicted an older still-open PR once an author had more
 * than 30 concurrently open). `gh pr list --limit` auto-paginates past its 100-per-page GraphQL cap, so
 * a value this large is not "a bigger bounded window" in the same sense the old `30` was — it is, for
 * any workflow a single human or agent author could actually sustain, complete coverage of every open
 * PR they have. This is deliberately **not** claimed as a mathematical guarantee: an author with more
 * than 1000 simultaneously open PRs (not a realistic operating point for this preset) would still see
 * the oldest evicted, same failure shape as before at a vastly higher threshold (PR #446 review,
 * 21:43 round: this residual gap is real and intentionally not re-solved here — see 003 §11.9 for the
 * documented boundary).
 *
 * **The merged/closed calls filter by a `merged:`/`closed:` search date range, not by relying on
 * `--limit` plus creation-order** (PR #446 review, thread `discussion_r3617759463`). `gh pr list`
 * without `--search` orders results newest-**created**-first, not newest-merged/closed-first, so an
 * older PR (created long ago, merged or closed only just now) can sit behind however many
 * newer-CREATED terminal PRs exist and never be fetched within a fixed `--limit`, silently dropping it
 * out of the 6-hour terminal window this preset advertises. Computing `cutoff` (now minus
 * {@link TERMINAL_WINDOW_SECONDS}) once per tick and passing `merged:>=$cutoff` /
 * `closed:>=$cutoff` scopes each call directly to the window that matters, independent of creation
 * order or volume. The date arithmetic tries GNU `date -d @epoch` first and falls back to BSD/macOS
 * `date -r epoch`, so the same script runs on both a Linux daemon host and a local macOS one.
 *
 * Passing `--search` also changes how `--state closed` behaves: `gh` routes a `--search`-bearing query
 * through GitHub's search API, whose `is:closed` qualifier — unlike the plain GraphQL `states: CLOSED`
 * enum `--state closed` uses alone — matches merged PRs too, so the closed call's own search string
 * explicitly adds `-is:merged` to keep the closed lane exclusively unmerged closures (the merged call
 * needs no equivalent exclusion; it wants merged PRs).
 *
 * The three raw arrays are unioned by {@link ghPresetScript}'s `jq -sc`
 * stage; a PR is never simultaneously open, merged, and closed, so `unique_by(.number)`
 * in {@link MY_PRS_REDUCE} is a defensive no-op against real `gh` output — it only matters against a
 * test stub that (deliberately, to keep transition fixtures simple) returns the same fixture for every
 * call.
 */
const MY_PRS_JSON_FIELDS =
  'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,' +
  'latestReviews,comments,mergedAt,closedAt,author';

/** See {@link MY_PRS_FETCH}'s doc comment for why this is 1000, not a small bounded window. */
const MY_PRS_OPEN_LIMIT = 1000;

/**
 * Row cap for each of the merged/closed `gh pr list` calls in
 * {@link MY_PRS_FETCH}, matching {@link MY_PRS_OPEN_LIMIT}'s "complete
 * coverage for any realistic workflow, not a mathematical guarantee"
 * rationale (PR #446 review, thread `discussion_r3624050272`). The date-range
 * `--search` already scopes each call to the {@link TERMINAL_WINDOW_SECONDS}
 * window regardless of creation order, but the call is still capped at 100
 * rows — an author who merges or closes more than 100 of their own PRs
 * within that single 6-hour window would still silently lose the oldest of
 * them. `gh pr list --limit` auto-paginates past its 100-per-page GraphQL
 * cap, so raising this bound is not "a bigger page", it is complete coverage
 * for any author who could plausibly land 1000 merges/closes in 6 hours —
 * not a realistic operating point for this preset.
 */
const MY_PRS_TERMINAL_LIMIT = 1000;

/**
 * Portable "now minus {@link TERMINAL_WINDOW_SECONDS}, as an ISO-8601 UTC
 * timestamp" computation, shared by {@link MY_PRS_FETCH}'s merged/closed
 * calls. `date -d @epoch` is GNU-only; `date -r epoch` is BSD/macOS-only —
 * trying the GNU form first and falling back on failure covers both a Linux
 * daemon host and a local macOS one with the same script.
 */
const MY_PRS_CUTOFF_PREAMBLE =
  `cutoff_epoch=$(( $(date -u +%s) - ${String(TERMINAL_WINDOW_SECONDS)} )) && ` +
  'cutoff=$(date -u -d @"$cutoff_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ' +
  '|| date -u -r "$cutoff_epoch" +%Y-%m-%dT%H:%M:%SZ) && ';

const MY_PRS_FETCH =
  MY_PRS_CUTOFF_PREAMBLE +
  `gh pr list --author @me --state open --limit ${String(MY_PRS_OPEN_LIMIT)} --json ${MY_PRS_JSON_FIELDS} && ` +
  `gh pr list --author @me --state merged --search "merged:>=$cutoff" --limit ${String(MY_PRS_TERMINAL_LIMIT)} --json ${MY_PRS_JSON_FIELDS} && ` +
  `gh pr list --author @me --state closed --search "closed:>=$cutoff -is:merged" --limit ${String(MY_PRS_TERMINAL_LIMIT)} --json ${MY_PRS_JSON_FIELDS}`;

/**
 * `reduceJq` for {@link MY_PRS_FETCH}. `title` is deliberately NOT projected
 * into the reduced entry (PR #446 review, thread `discussion_r3617759355`):
 * it is mutable presentation data, and `json-diff` fires on ANY change to the
 * whole diffed payload, including a field mutating on an entry that is
 * already, and remains, a member. A retitle would re-fire the `high`-urgency
 * interrupt for a PR nothing actually happened to — `url` already identifies
 * exactly which PR an entry is about.
 */
const MY_PRS_REDUCE =
  'add | unique_by(.number) | [.[] ' +
  '| (.author.login) as $me ' +
  '| (([.statusCheckRollup[]? | select(((.conclusion // .state // "") | ascii_upcase) as $c ' +
  '| $c == "FAILURE" or $c == "TIMED_OUT" or $c == "CANCELLED" or $c == "ERROR" ' +
  'or $c == "ACTION_REQUIRED" or $c == "STARTUP_FAILURE") | (.name // .context)] | sort)) as $failing ' +
  '| ((.mergedAt // .closedAt // "")) as $terminalAt ' +
  '| (if $terminalAt == "" then now ' +
  'else (try (($terminalAt | sub("\\\\.[0-9]+Z$"; "Z")) | fromdateiso8601) catch now) end) as $terminalEpoch ' +
  '| (if .state == "MERGED" or .state == "CLOSED" ' +
  `then (if $terminalEpoch > (now - ${String(TERMINAL_WINDOW_SECONDS)}) ` +
  'then (if .state == "MERGED" then "merged" else "closed" end) else "none" end) ' +
  'elif ($failing | length) > 0 then "ci-failing" ' +
  'elif .reviewDecision == "CHANGES_REQUESTED" then "changes-requested" ' +
  'elif .isDraft then "draft" ' +
  'else "none" end) as $needs ' +
  '| select($needs != "none") ' +
  '| {number, url, needs: $needs} ' +
  '+ (if $needs == "merged" or $needs == "closed" then {} ' +
  'else {failingChecks: $failing, ' +
  'reviews: ([.latestReviews[]? | {by: .author.login, state, at: .submittedAt}] ' +
  '| sort_by(.by, .at, .state)), ' +
  'commentCount: ([.comments[]? | select((.author.login // "") != $me ' +
  'and ((.author.login // "") | endswith("[bot]") | not))] ' +
  '| length)} end)] | sort_by(.number)';

/**
 * The scaffold body for each `--type`. Exported (test-only use) so
 * `scaffold-defaults.test.ts` can assert the `command-poll` entry's parsed
 * `command:` block still equals {@link COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND}
 * in `scaffold-defaults.ts` — kept as a direct regression test even though
 * the two are now structurally linked via
 * {@link COMMAND_POLL_DEFAULT_COMMAND_BLOCK}, so a future refactor that
 * breaks that link still fails loudly.
 */
export const TEMPLATES: Record<string, string> = {
  'file-fingerprint': yaml`
---
name: My monitor
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
urgency: normal
---

When changes are detected, review and take appropriate action.
`.trimStart(),

  'api-poll': yaml`
---
name: My web page monitor
watch:
  type: api-poll
  # The common "watch a page" case needs NO change-detection block: the strategy
  # is inferred from the response Content-Type — JSON bodies (application/json,
  # *+json) use json-diff, everything else (HTML/plain-text/unknown) uses
  # text-diff. Set change-detection.strategy explicitly only to override the
  # inferred default; an explicit value always wins:
  #   text-diff   — compare the raw body (good for HTML / plain-text pages)
  #   json-diff   — compare JSON semantically, ignoring key order/whitespace
  #   status-code — only fire when the HTTP status changes (e.g. 200 -> 503)
  url: 'https://example.com/page'
  method: GET
  interval: 5m
urgency: normal
---

When the page changes, review the differences and take appropriate action.
`.trimStart(),

  'command-poll': yaml`
---
name: Upstream branch monitor
watch:
  type: command-poll
${COMMAND_POLL_EXAMPLE_COMMENT}  command:
${COMMAND_POLL_DEFAULT_COMMAND_BLOCK}
  interval: 5m
  change-detection:
    strategy: text-diff
urgency: normal
---

When the upstream branch changes, review the new commits and decide whether they
affect this workspace.
`.trimStart(),

  'pr-review': yaml`
---
name: PRs awaiting my review
watch:
  type: command-poll
  # Scoped to THIS repository: gh resolves the repository from its process
  # working directory, which command-poll defaults (no cwd: needed here) to
  # this project's root — the runtime workspace/config root, resolved fresh
  # on every tick from wherever this file lives, not a path baked in at scaffold
  # time. Do not add --repo or a hardcoded cwd:.
  key: pr-review
${PR_REVIEW_SCOPE_COMMENT}  command:
    - sh
    - -c
    - |
${yamlBlockScalar(
  ghPresetScript('pr-review', PR_REVIEW_FETCH, PR_REVIEW_REDUCE, {
    preamble: PR_REVIEW_SEARCH_PREAMBLE,
    jqArgs: '--arg scope "$search"',
  }),
  '      ',
)}
  interval: 5m
  change-detection:
    strategy: json-diff
${PR_REVIEW_URGENCY_COMMENT}urgency: high
---

A pull request in this repository needs review. This list holds only PRs that
are open, out of draft, authored by someone else, and **not yet decided** — so
anything that *appears* here is waiting on you.

- **A PR appeared** — it was just opened, or a draft was marked ready. Review
  it: check out the branch, read the diff against the issue or description it
  claims to implement, and record findings. Do not merge it yourself.
- **A PR disappeared** — someone reviewed it (approved or requested changes), or
  it was merged, closed, or pulled back to draft. No action: it is no longer
  waiting on you.

Release PRs (\`changeset-release/*\` heads) never enter this list, and neither do
PRs you authored yourself — always, regardless of which \`--search\` scope below
is active — so this list never overlaps \`my-prs\`; see that preset for your own
PRs. By default it also excludes PRs you were not asked to review.

**If this monitor never fires, check the reviewer scoping before assuming there
is nothing to review.** An empty result looks exactly like "no PRs need you". The
default \`--search 'review-requested:@me'\` matches only PRs where your review was
explicitly requested, so it returns nothing for a solo maintainer, or when PRs are
authored and reviewed under the same identity. Run
\`gh pr list --state open --search "review-requested:@me"\`; if that prints nothing
while open PRs exist, switch the \`--search\` in this file to one of the
alternatives listed in its comments.

If instead you see a "Command failing" event, \`gh\` could not run — read the
error and fix the CLI install, auth, or working directory before trusting this
monitor again.
`.trimStart(),

  'my-prs': yaml`
---
name: My pull requests
watch:
  type: command-poll
  # Scoped to THIS repository (no cwd: needed — see the pr-review template's
  # comment for why) and to whoever gh is authenticated as (--author @me,
  # never a baked-in username).
  key: my-prs
  command:
    - sh
    - -c
    - |
${yamlBlockScalar(ghPresetScript('my-prs', MY_PRS_FETCH, MY_PRS_REDUCE), '      ')}
  interval: 5m
  change-detection:
    strategy: json-diff
${MY_PRS_URGENCY_COMMENT}urgency: high
---

One of your own pull requests needs attention. This list holds only PRs that
need something from you; each entry carries a \`needs\` field saying what.

- **\`needs: ci-failing\`** — CI broke. \`failingChecks\` names the failing
  checks; pull the log (\`gh run view --log-failed\`), fix the cause on the
  branch, and push. Do not ask for review until it is green.
- **\`needs: changes-requested\`** — blocking review feedback landed. Read it,
  address each point in code or reply explaining why not, then push and
  re-request review. A growing \`reviews\`/\`commentCount\` on an entry already
  in the list means more feedback arrived.
- **\`needs: draft\`** — the PR is in draft. If you did not just put it there,
  someone pulled it back; find out what they found before pushing more.
- **\`needs: merged\`** — it landed. Delete the branch and its worktree, and
  close the issue it referenced if its acceptance criteria are met.
- **\`needs: closed\`** — closed without merging. Find out why before reopening
  or redoing the work.

An entry **leaving** the list is good news, not a transition to act on: CI went
green, the review was answered, or a draft was marked ready. Note it and move on.
A merged or closed PR also drops off on its own about 6 hours after it landed —
that is the entry expiring, not a new state change.

\`gh pr list\` exposes no review-thread data, so inline review comments that do
not move \`reviewDecision\` are not visible here; check the PR directly when
feedback is expected. Note that \`gh\` reports "no decision yet" as an empty
string, not \`null\`.

If instead you see a "Command failing" event, \`gh\` could not run — read the
error and fix the CLI install, auth, or working directory before trusting this
monitor again.
`.trimStart(),

  schedule: yaml`
---
name: My scheduled monitor
watch:
  type: schedule
  cron: '0 9 * * 1-5'
  timezone: UTC
urgency: normal
---

This monitor fires on a schedule. Review and take appropriate action.
`.trimStart(),

  'incoming-changes': yaml`
---
name: Spec changes from upstream
watch:
  type: incoming-changes
  paths:
    - 'docs/specs/**'
  branch: main
urgency: normal
---

The spec documents changed in the latest pull. Summarize what changed and
whether it affects what I'm currently working on.
`.trimStart(),
};

const VALID_TYPES = Object.keys(TEMPLATES);
const DEFAULT_TYPE = 'file-fingerprint';
const DEFAULT_MONITOR_NAME = 'my-monitor';
const VALID_URGENCIES = ['low', 'normal', 'high'];

/**
 * `--type` values that are ready-made presets rather than observation source
 * types (005 §2: "pr-review and my-prs are not source types"). Used to keep
 * {@link VALID_TYPES} — which Commander's `.choices()` still needs as one flat
 * list — split apart wherever the CLI presents types to a human, so the
 * interactive prompt and its error don't imply a preset is a kind of source.
 */
const PRESET_TYPES = new Set(['pr-review', 'my-prs']);

/** {@link VALID_TYPES} minus {@link PRESET_TYPES} — the actual observation
 * source types, for prompt/error text that must not conflate the two. */
const SOURCE_TYPES = VALID_TYPES.filter((type) => !PRESET_TYPES.has(type));

/**
 * Types whose template has a seedable path-pattern list: `globs:` for
 * `file-fingerprint`, `paths:` for `incoming-changes` (spec 001 §2 field
 * names differ per source even though `--glob` addresses both). Types not
 * in this map have no such block, so `--glob` is rejected for them.
 */
const GLOB_FIELD_BY_TYPE: Partial<Record<string, 'globs' | 'paths'>> = {
  'file-fingerprint': 'globs',
  'incoming-changes': 'paths',
};

/** Thrown when a seed flag (`--glob`/`--name`/`--urgency`) can't be applied
 * to the chosen `--type`. Caught by the action handler and reported as a
 * normal CLI error (message + exit code 1), not a stack trace. */
class InitSeedError extends Error {}

/** Seed values from `--glob`/`--name`/`--urgency`/`--command`, threaded into
 * the generated frontmatter value-preserving (issues #330, #388). Only the named
 * `init <name>` scaffold path consumes these; the bare bootstrap form ignores
 * them (non-goal). */
interface SeedOptions {
  name?: string;
  urgency?: string;
  globs?: string[];
  command?: string[];
}

/**
 * Render `value` as a single-quoted YAML flow scalar, matching the quoting
 * style the templates already use for string fields (`'**\/*.ts'`,
 * `'https://example.com/page'`). Single-quoted YAML scalars have exactly one
 * escape rule — a literal `'` doubles to `''` — so this is safe for
 * arbitrary user-supplied text (colons, `#`, backslashes, etc. all pass
 * through unescaped and unmisinterpreted).
 */
function yamlSingleQuoted(value: string): string {
  // A single-quoted YAML scalar cannot safely span lines at an arbitrary
  // indent; reject control characters outright rather than emit a scaffold
  // that fails its own `validate` step.
  if (/[\r\n]/.test(value)) {
    throw new InitSeedError(
      'Seed values must be single-line (newlines are not allowed).',
    );
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Replace the template's `name:` frontmatter line with the seeded value. */
function seedName(template: string, name: string): string {
  return template.replace(/^name: .*$/m, `name: ${yamlSingleQuoted(name)}`);
}

/**
 * Derive a readable frontmatter `name:` from the positional `<name>`
 * argument when `--name` is not given (issue #375): without this, the
 * scaffold's literal template placeholder (e.g. `My monitor`) survives
 * untouched, so a rushed author can commit a monitor that is never renamed.
 * Splits on `-`/`_` and capitalizes the first word, e.g. `watch-docs` ->
 * `Watch docs`. A separator-free positional is still capitalized (a single
 * word, e.g. `watchdocs` -> `Watchdocs`). A positional that is empty or
 * consists solely of separators (e.g. `---`) has no word to capitalize and
 * returns `undefined`, leaving the `name:` seed unset so the template's own
 * (non-empty) default name survives — returning it verbatim would otherwise
 * scaffold `name: ''`, which fails `monitorFrontmatterSchema`'s `.min(1)` on
 * `validate`.
 */
function deriveNameFromPositional(positional: string): string | undefined {
  const words = positional.split(/[-_]+/).filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  const [first, ...rest] = words;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `words.length > 0` guarantees `first` is defined.
  const capitalized = `${first!.charAt(0).toUpperCase()}${first!.slice(1)}`;
  return [capitalized, ...rest].join(' ');
}

/** Replace the template's `urgency:` frontmatter line with the seeded value.
 * `urgency` is Commander-`.choices()`-constrained to {@link VALID_URGENCIES},
 * so it's always a bare, unquoted YAML scalar.
 *
 * For the two presets, `urgency:` sits directly under a rationale comment
 * that explains that *specific* value (issue #444 review). A bare value swap
 * would leave that comment attached to a now-wrong value — e.g. `--urgency
 * high` on `pr-review` would ship directly under "normal, not high: ...".
 * When the seeded value differs from the template's own default, the
 * preset-specific comment is swapped for {@link GENERALIZED_URGENCY_COMMENT}
 * first, the same #388 pattern {@link seedCommand} already applies to
 * `command-poll`'s illustrative-comment.
 */
function seedUrgency(template: string, type: string, urgency: string): string {
  const rationaleComment = PRESET_URGENCY_COMMENTS[type];
  const alreadyMatches = new RegExp(`^urgency: ${urgency}$`, 'm').test(
    template,
  );
  const withGeneralizedComment =
    rationaleComment !== undefined && !alreadyMatches
      ? template.replace(rationaleComment, GENERALIZED_URGENCY_COMMENT)
      : template;
  return withGeneralizedComment.replace(
    /^urgency: .*$/m,
    `urgency: ${urgency}`,
  );
}

/**
 * Replace the template's seedable path-pattern list (`globs:` or `paths:`,
 * per {@link GLOB_FIELD_BY_TYPE}) with the seeded patterns. Throws
 * {@link InitSeedError} for a `type` with no such block (e.g. `api-poll`,
 * `command-poll`, `schedule`) so the CLI reports a clear error instead of
 * silently dropping the flag.
 */
function seedGlobs(template: string, type: string, globs: string[]): string {
  const field = GLOB_FIELD_BY_TYPE[type];
  if (field === undefined) {
    throw new InitSeedError(
      `--glob is not supported for --type ${type} (only file-fingerprint and incoming-changes have a path-pattern list)`,
    );
  }
  // Derive the list-item indent from the template's own first item so
  // seeding follows the template if its indentation ever changes.
  const blockPattern = new RegExp(
    `^( *)${field}:\\n(( +)- .*\\n)(?:\\3- .*\\n)*`,
    'm',
  );
  return template.replace(
    blockPattern,
    (_match, indent: string, _first: string, itemIndent: string) => {
      const listBlock = globs
        .map((pattern) => `${itemIndent}- ${yamlSingleQuoted(pattern)}`)
        .join('\n');
      return `${indent}${field}:\n${listBlock}\n`;
    },
  );
}

/**
 * Replace the command-poll template's `command:` argv list with the seeded
 * tokens. Throws {@link InitSeedError} for any type other than `command-poll`
 * (only that template has a `command:` argv block), mirroring {@link seedGlobs}.
 *
 * Each token is emitted as a single-quoted YAML scalar so argv tokens that are
 * not plain scalars — a leading `-`/`--` like `--porcelain`, embedded spaces,
 * `#`, `:` — round-trip verbatim. Quoting also means seeding never invents shell
 * semantics: each `--command` token is one argv element, matching the
 * "argv array, run directly (no shell)" contract (spec 003 §"command-poll").
 *
 * If the template's `command:` block ever drifts out of the shape
 * `blockPattern` expects, `String.replace` would otherwise return the
 * template unchanged with no error — silently shipping the untouched
 * `ls-remote` default under a `--command` seed that looks like it applied.
 * That is exactly the wrong-intent trap this flag exists to prevent (issue
 * #388), so a non-matching template throws {@link InitSeedError} instead of
 * silently no-op'ing.
 *
 * Exported (test-only use) so `init.test.ts` can exercise the no-match
 * (drift-guard) path directly with a hand-crafted, deliberately non-matching
 * template — that shape can't be reached through the real, currently-correct
 * template via the CLI's public surface.
 */
export function seedCommand(
  template: string,
  type: string,
  command: string[],
): string {
  if (type !== 'command-poll') {
    throw new InitSeedError(
      `--command is not supported for --type ${type} (only command-poll has a seedable command: argv array; the pr-review and my-prs presets ship a fixed gh query)`,
    );
  }
  // The seeded command is no longer the illustrative upstream-tip example, so
  // its comment must stop describing that example (see
  // COMMAND_POLL_EXAMPLE_COMMENT's doc comment).
  const withGeneralizedComment = template.replace(
    COMMAND_POLL_EXAMPLE_COMMENT,
    COMMAND_POLL_CONTRACT_COMMENT,
  );
  // Same block-replacement shape as seedGlobs: match the `command:` key line,
  // capture its indent and the list-item indent from the template's own first
  // item, then replace the whole item run with the seeded tokens.
  const blockPattern = /^( *)command:\n(( +)- .*\n)(?:\3- .*\n)*/m;
  if (!blockPattern.test(withGeneralizedComment)) {
    throw new InitSeedError(
      'Could not find a command: argv block in the command-poll template to seed (the template may have changed shape) — refusing to silently ship the untouched default; please report this as a bug.',
    );
  }
  return withGeneralizedComment.replace(
    blockPattern,
    (_match, indent: string, _first: string, itemIndent: string) => {
      const listBlock = command
        .map((token) => `${itemIndent}- ${yamlSingleQuoted(token)}`)
        .join('\n');
      return `${indent}command:\n${listBlock}\n`;
    },
  );
}

/**
 * Apply `--glob`/`--name`/`--urgency`/`--command` seed overrides to a
 * template, in frontmatter-field order. A `SeedOptions` with all fields
 * `undefined` returns `template` unchanged. As of issue #375, the named
 * scaffold path's caller always passes a `name` seed (the `--name` value, or
 * one derived from the positional `<name>` when `--name` is omitted), so a
 * zero-flag `init <name>` no longer returns the raw template byte-for-byte —
 * only its `name:` line differs from the template default. The bare
 * bootstrap path never calls this with a `name` seed, so its scaffolded
 * templates are unaffected (non-goal, issue #330).
 */
function applySeeds(
  template: string,
  type: string,
  seeds: SeedOptions,
): string {
  let result = template;
  if (seeds.name !== undefined) result = seedName(result, seeds.name);
  if (seeds.urgency !== undefined) {
    result = seedUrgency(result, type, seeds.urgency);
  }
  if (seeds.globs !== undefined && seeds.globs.length > 0) {
    result = seedGlobs(result, type, seeds.globs);
  }
  if (seeds.command !== undefined && seeds.command.length > 0) {
    result = seedCommand(result, type, seeds.command);
  }
  return result;
}

/** Commander `.option()` collector for repeatable `--glob <pattern>`. */
function collectGlob(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Commander `.option()` collector for repeatable `--command <token>`; each
 * occurrence appends one argv token to `watch.command` (order-preserving). */
function collectCommand(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * The project-enable file, written verbatim from the setup-monitors skill's
 * "Enable The Project" section
 * (`agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md`). It is the exact
 * minimal shape the skill documents: only `enabled: true` is required for the
 * session-start hook to register the daemon. `session start` later augments this
 * file (socket/db/reap fields) via `writeLocalState` when a session opens, so we
 * intentionally write the minimal form here and never clobber an already-enabled
 * file (see {@link ensureEnabled}).
 */
const ENABLE_FILE_CONTENTS = md`
---
enabled: true
---

> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).
`.trimStart();

/** The single line the setup-monitors skill requires in `.gitignore`. */
const GITIGNORE_LINE = '.claude/*.local.*';

/**
 * `.agentmonitors/` is the project-root runtime directory the core writes
 * per-session hook state into (`<workspace>/.agentmonitors/sessions/<id>/hook-state.json`,
 * see `libs/core/src/adapter/claude.ts#defaultHookStatePath` and
 * docs/specs/002-runtime-delivery.md §11.3). It is created the moment a
 * session opens — before any user opts into it — so it must be ignored
 * alongside {@link GITIGNORE_LINE} rather than left for the user to discover
 * in `git status` (issue #336). Every file under it is a materialized,
 * regenerable projection of the runtime's SQLite store, never the source of
 * truth, so it is safe to delete.
 */
const RUNTIME_DIR_GITIGNORE_LINE = '/.agentmonitors/';

/** All lines `agentmonitors init` ensures are present in `.gitignore`. */
const GITIGNORE_LINES = [GITIGNORE_LINE, RUNTIME_DIR_GITIGNORE_LINE] as const;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

interface ScaffoldResult {
  status: 'created' | 'exists';
  /** Directory of the scaffolded monitor (its `MONITOR.md` lives inside). */
  monitorDir: string;
}

/**
 * Write a template `MONITOR.md` for `type` into `<dir>/<name>/`. Shared by the
 * named `init <name>` scaffold path and the bare-init bootstrap so both produce
 * byte-identical monitor files. Never overwrites an existing monitor: returns
 * `status: 'exists'` so each caller can decide how to react (the named path
 * errors; the bootstrap treats it as an idempotent no-op).
 *
 * `seeds` (default `{}`, i.e. no-op) lets the named scaffold path override
 * specific frontmatter fields (value-preserving) via `--glob`/`--name`/`--urgency`
 * (issue #330); the bootstrap path never passes seeds, so its output is
 * unaffected. Seeding is applied — and can throw {@link InitSeedError} — before
 * any filesystem write, so a rejected seed (e.g. `--glob` on a type with no
 * path-pattern list) never leaves a partial directory behind.
 *
 * Neither preset seeds an explicit `cwd:` (issue #444 review, finding 826): a
 * PR-alerting preset omits `cwd` entirely, and `command-poll` now defaults an
 * omitted `cwd` to the **runtime** workspace/config root for a project
 * monitor (003 §11.1) — the same root the daemon resolves fresh on every
 * tick, from wherever `MONITOR.md` actually lives, never a value baked into
 * the file at scaffold time. Baking in `process.cwd()` here, as an earlier
 * revision did, broke the very first tick after the project was relocated or
 * shared to another checkout path.
 */
function scaffoldMonitor(
  dir: string,
  name: string,
  type: string,
  seeds: SeedOptions = {},
): ScaffoldResult {
  // Commander's .choices() guarantees a valid key on the named path; the
  // bootstrap validates the interactive/`--yes` type before calling here.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const template = TEMPLATES[type]!;
  const monitorDir = path.join(dir, name);
  if (existsSync(path.join(monitorDir, 'MONITOR.md'))) {
    return { status: 'exists', monitorDir };
  }
  const content = applySeeds(template, type, seeds);
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(path.join(monitorDir, 'MONITOR.md'), content, 'utf-8');
  return { status: 'created', monitorDir };
}

/**
 * Bootstrap step 1: ensure the project is enabled. Reuses `readLocalState` to
 * detect an already-enabled project so a re-run never rewrites the file (which
 * would clobber socket/db fields a prior `session start` persisted).
 *
 * `readLocalState`'s minimal frontmatter parser only recognizes a bare `---`
 * as the block delimiter (see `local-state.ts`'s `parseFrontmatter`), so a
 * BOM-prefixed file (a literal U+FEFF before `---`) — which some editors/tools
 * write — fails that check and reports `enabled: false` even though the file
 * already declares `enabled: true`. Before writing, fall back to a raw-text
 * check (BOM stripped) so we never clobber an already-enabled file's
 * socket/db fields.
 */
function ensureEnabled(cwd: string): 'created' | 'already-enabled' {
  if (readLocalState(cwd).enabled) return 'already-enabled';
  const target = path.join(cwd, '.claude', 'agentmonitors.local.md');
  let existingRaw: string | undefined;
  try {
    existingRaw = readFileSync(target, 'utf-8');
  } catch {
    existingRaw = undefined;
  }
  if (existingRaw !== undefined) {
    const stripped = existingRaw.replace(/^\uFEFF/, '');
    if (stripped.includes('enabled: true')) {
      return 'already-enabled';
    }
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, ENABLE_FILE_CONTENTS, 'utf-8');
  return 'created';
}

/**
 * Bootstrap step 2: ensure `.gitignore` ignores the local coordination file
 * and the `.agentmonitors/` runtime directory ({@link GITIGNORE_LINES}).
 * Appends whichever lines are missing, creates the file if absent, and is a
 * no-op if every line is already present. Each line is checked independently,
 * so a `.gitignore` that already has one line but not the other only gets the
 * missing one appended (same append-if-missing semantics as a single line).
 *
 * Only a missing file (`ENOENT`) is treated as "absent, create it". Any other
 * read error (e.g. `EACCES` on an unreadable file, `EISDIR` when `.gitignore`
 * is actually a directory) is rethrown so the command fails loudly instead of
 * silently overwriting something that isn't a plain, absent file.
 */
function ensureGitignore(cwd: string): 'created' | 'appended' | 'present' {
  const target = path.join(cwd, '.gitignore');
  let content: string;
  try {
    content = readFileSync(target, 'utf-8');
  } catch (err) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') throw err;
    writeFileSync(target, `${GITIGNORE_LINES.join('\n')}\n`, 'utf-8');
    return 'created';
  }
  const existingLines = new Set(content.split('\n').map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return 'present';
  const needsNewline = content.length > 0 && !content.endsWith('\n');
  writeFileSync(
    target,
    `${content}${needsNewline ? '\n' : ''}${missing.join('\n')}\n`,
    'utf-8',
  );
  return 'appended';
}

/**
 * Interactively ask whether to scaffold a starter monitor and, if so, for its
 * source type and name. Returns `null` when the author declines. Only ever
 * called on a TTY (see {@link runBootstrap}); non-interactive callers use flags.
 */
async function promptForMonitor(): Promise<{
  name: string;
  type: string;
} | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const add = (await rl.question('Scaffold a starter monitor now? [Y/n] '))
      .trim()
      .toLowerCase();
    if (add === 'n' || add === 'no') return null;

    let type = DEFAULT_TYPE;
    for (;;) {
      // Presets (pr-review, my-prs) are listed separately from source types
      // — 005 §2 is explicit that a preset is not a kind of source, and
      // conflating them here would make a future source-type-wide behavior
      // wrongly sweep presets in.
      const answer = (
        await rl.question(
          `Source type (${SOURCE_TYPES.join(', ')}) or preset (${[...PRESET_TYPES].join(', ')}) [${DEFAULT_TYPE}]: `,
        )
      ).trim();
      if (answer === '') break;
      if (VALID_TYPES.includes(answer)) {
        type = answer;
        break;
      }
      console.log(
        `Unknown source type or preset "${answer}". Try one of the listed types or presets.`,
      );
    }

    const nameAnswer = (
      await rl.question(`Monitor name [${DEFAULT_MONITOR_NAME}]: `)
    ).trim();
    const name = nameAnswer === '' ? DEFAULT_MONITOR_NAME : nameAnswer;
    return { name, type };
  } finally {
    rl.close();
  }
}

type MonitorOutcome =
  | { kind: 'created' | 'exists'; monitorDir: string; name: string }
  | { kind: 'enable-only' }
  | { kind: 'declined' }
  | { kind: 'skipped-noninteractive' };

interface BootstrapOptions {
  dir: string;
  type: string;
  enableOnly?: boolean;
  yes?: boolean;
}

/**
 * Bare `agentmonitors init`: one-shot project bootstrap. Enables the project,
 * fixes `.gitignore`, optionally scaffolds a first monitor, validates the
 * result, and prints a "what happens next + how to verify" summary. Idempotent:
 * a re-run on an already-set-up project changes nothing and says so.
 */
async function runBootstrap(options: BootstrapOptions): Promise<void> {
  const cwd = process.cwd();

  const enableStatus = ensureEnabled(cwd);
  const gitignoreStatus = ensureGitignore(cwd);

  let monitor: MonitorOutcome = { kind: 'enable-only' };
  // Tracked alongside `monitor` (rather than added to `MonitorOutcome`) so the
  // closing "Verify the monitor fires" summary can decide whether to suggest
  // `verify --manual`: only `file-fingerprint` can auto-trigger a change
  // (verify.ts's `buildAutoTrigger` only reads `watch.globs`).
  let scaffoldedType: string | undefined;
  if (!options.enableOnly) {
    // `isTTY` is typed `boolean` but is `undefined` for a non-TTY stdin at
    // runtime; either way, a falsy value means we must not prompt.
    const canPrompt = process.stdin.isTTY && !options.yes;
    let choice: { name: string; type: string } | null = null;
    if (canPrompt) {
      choice = await promptForMonitor();
      monitor = choice ? monitor : { kind: 'declined' };
    } else if (options.yes) {
      choice = { name: DEFAULT_MONITOR_NAME, type: options.type };
    } else {
      // Not a TTY and no --yes: we cannot prompt (agents/scripts pass flags).
      monitor = { kind: 'skipped-noninteractive' };
    }
    if (choice) {
      const result = scaffoldMonitor(options.dir, choice.name, choice.type);
      monitor = {
        kind: result.status,
        monitorDir: result.monitorDir,
        name: choice.name,
      };
      scaffoldedType = choice.type;
    }
  }

  const nothingChanged =
    enableStatus === 'already-enabled' &&
    gitignoreStatus === 'present' &&
    monitor.kind !== 'created';

  if (nothingChanged) {
    console.log(
      'AgentMon is already set up in this project — nothing to change.',
    );
    console.log(`  Monitoring enabled:  .claude/agentmonitors.local.md`);
    console.log(`  .gitignore already ignores ${GITIGNORE_LINES.join(', ')}`);
    console.log(
      `\nAdd another monitor with:  agentmonitors init <name> --type <type>`,
    );
    console.log('Check overall health any time:  agentmonitors doctor');
    return;
  }

  console.log('AgentMon project setup');
  console.log(
    enableStatus === 'created'
      ? '  Enabled monitoring          .claude/agentmonitors.local.md'
      : '  Monitoring already enabled  .claude/agentmonitors.local.md',
  );
  console.log(
    gitignoreStatus === 'present'
      ? `  .gitignore already ignores  ${GITIGNORE_LINES.join(', ')}`
      : `  Updated .gitignore          ${GITIGNORE_LINES.join(', ')}`,
  );

  if (monitor.kind === 'created') {
    console.log(
      `  Scaffolded monitor          ${monitor.monitorDir}/MONITOR.md`,
    );
  } else if (monitor.kind === 'exists') {
    console.log(
      `  Monitor already exists      ${monitor.monitorDir}/MONITOR.md (left unchanged)`,
    );
  }

  // Step: validate the just-scaffolded monitor by running the real `validate`
  // command in-process (no behavior of its own reinvented here — AP6).
  if (monitor.kind === 'created') {
    console.log(`\nValidating ${options.dir}:`);
    await validateCommand.parseAsync([options.dir], { from: 'user' });
  }

  console.log('\nWhat happens next');
  console.log(
    "  • If you're using the AgentMon Claude Code plugin, monitoring starts automatically",
  );
  console.log(
    '    the next time you open a Claude Code session (SessionStart lazy-boots the daemon).',
  );
  // Point manual users at the backgrounded form (issue #389 P1). The bare
  // `daemon run` this used to print occupies the terminal it was started
  // from, leaving the reader to discover `& disown` and log redirection.
  console.log(
    `  • Otherwise, start the daemon yourself:  agentmonitors daemon run ${options.dir} --detach`,
  );
  console.log(
    `  • Or run a one-shot tick now:  agentmonitors daemon once ${options.dir}`,
  );
  console.log('  • Check overall health any time:  agentmonitors doctor');

  if (monitor.kind === 'created') {
    // Only file-fingerprint can auto-trigger a change today (see
    // `scaffoldedType` above), so every other type needs `--manual`.
    const manualFlag = scaffoldedType === 'file-fingerprint' ? '' : ' --manual';
    console.log('\nVerify the monitor fires');
    console.log(
      `  • Dry-run its source:  agentmonitors monitor test ${monitor.monitorDir}/MONITOR.md`,
    );
    console.log(
      `  • Prove it delivers end-to-end:  agentmonitors verify ${monitor.name} --dir ${options.dir}${manualFlag}`,
    );
    console.log(
      `  • Using the AgentMon Claude Code plugin? The setup-monitors skill's "Verify It Fires" section walks through the same proof by hand.`,
    );
    console.log(
      `\nEdit ${monitor.monitorDir}/MONITOR.md to configure what it watches.`,
    );
  } else {
    // No monitor scaffolded (enable-only, declined, or non-interactive skip).
    console.log('\nAdd a monitor with:');
    console.log(
      `  agentmonitors init <name> --type <${VALID_TYPES.join('|')}>`,
    );
    if (monitor.kind === 'skipped-noninteractive') {
      console.log(
        '  (or re-run `agentmonitors init --yes` to scaffold a starter monitor)',
      );
    }
    console.log(`Then verify it:  agentmonitors validate ${options.dir}`);
  }
}

export const initCommand = new Command('init')
  .description(
    'Bootstrap AgentMon in this project (no name), or scaffold a single monitor (with a name)',
  )
  .argument(
    '[name]',
    'Monitor name (kebab-case, becomes the directory name). Omit to bootstrap the project.',
  )
  .option('--dir <dir>', 'Base directory for monitors', '.claude/monitors')
  .addOption(
    new Option(
      '--type <type>',
      'Observation source type, or a ready-made preset (pr-review: PRs awaiting your review; my-prs: CI/review/state changes on your own PRs — both auto-scoped to the current repo)',
    )
      .choices(VALID_TYPES)
      .default(DEFAULT_TYPE),
  )
  .option(
    '--enable-only',
    'Bootstrap only: enable the project and update .gitignore (no monitor, no prompts)',
  )
  .option(
    '--yes',
    'Bootstrap non-interactively: accept defaults and scaffold a starter monitor',
  )
  .option(
    '--glob <pattern>',
    'Seed watch.globs (file-fingerprint) or watch.paths (incoming-changes); repeatable. Scaffold form only.',
    collectGlob,
    [],
  )
  .option(
    '--command <token>',
    'Seed watch.command (command-poll) argv, one token per flag; repeatable. Scaffold form only.',
    collectCommand,
    [],
  )
  .option(
    '--name <name>',
    'Seed the frontmatter name: field (distinct from the positional <name>, which sets the directory). Defaults to a readable form of the positional <name>. Scaffold form only.',
  )
  .addOption(
    new Option(
      '--urgency <urgency>',
      'Seed the frontmatter urgency: field. Scaffold form only.',
    ).choices(VALID_URGENCIES),
  )
  .action(
    async (
      name: string | undefined,
      options: {
        dir: string;
        type: string;
        enableOnly?: boolean;
        yes?: boolean;
        glob: string[];
        command: string[];
        name?: string;
        urgency?: string;
      },
    ) => {
      // Named form: `init <name> --type ...` — unchanged scaffold behavior
      // when no seed flags are passed (AC3, issue #330), except that the
      // frontmatter `name:` now derives from the positional `<name>` rather
      // than surviving as the template's literal placeholder (issue #375).
      // `--name` still overrides.
      if (name !== undefined) {
        // `urgency`/`globs`/`name` are all built conditionally (not `field:
        // value ?? undefined`) because `exactOptionalPropertyTypes` treats an
        // explicit `undefined` value differently from an absent key.
        // `deriveNameFromPositional` returns `undefined` for a positional
        // with no word to capitalize (empty or separators-only, e.g. `---`),
        // so `name` is omitted from the seed in that case and the template's
        // own default name: line survives untouched.
        //
        // Presets are the other case that must keep the template's own
        // `name:`: their curated names (e.g. "PRs awaiting my review") ARE
        // the product value, unlike the throwaway placeholder #375's
        // derivation replaces. Deriving from the positional would silently
        // clobber it — `init pr-review --type pr-review` would otherwise
        // rename it to "Pr review" (issue #444 review, finding 6) — so the
        // derived-name seed is skipped for preset types; `--name` still
        // overrides explicitly.
        const derivedName =
          options.name ??
          (PRESET_TYPES.has(options.type)
            ? undefined
            : deriveNameFromPositional(name));
        const seeds: SeedOptions = {
          ...(derivedName !== undefined ? { name: derivedName } : {}),
          ...(options.urgency !== undefined
            ? { urgency: options.urgency }
            : {}),
          ...(options.glob.length > 0 ? { globs: options.glob } : {}),
          ...(options.command.length > 0 ? { command: options.command } : {}),
        };
        let result: ScaffoldResult;
        try {
          result = scaffoldMonitor(options.dir, name, options.type, seeds);
        } catch (err) {
          if (err instanceof InitSeedError) {
            console.error(err.message);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
        const { status, monitorDir } = result;
        if (status === 'exists') {
          console.error(`Monitor already exists: ${monitorDir}/MONITOR.md`);
          process.exitCode = 1;
          return;
        }
        console.log(`Created monitor: ${monitorDir}/MONITOR.md`);
        console.log(`\nEdit the file to configure your monitor, then run:`);
        console.log(`  agentmonitors validate ${options.dir}`);
        console.log(`  agentmonitors doctor`);
        // Only file-fingerprint can auto-trigger a change today (verify.ts's
        // `buildAutoTrigger` only reads `watch.globs`); every other type
        // needs `--manual`.
        const manualFlag =
          options.type === 'file-fingerprint' ? '' : ' --manual';
        console.log(
          `\nProve it delivers end-to-end:  agentmonitors verify ${name} --dir ${options.dir}${manualFlag}`,
        );
        return;
      }

      // Bare form: `init` — one-shot project bootstrap. Seed flags
      // (--glob/--name/--urgency) are intentionally not consumed here
      // (non-goal, issue #330): the bootstrap form's behavior is unchanged.
      await runBootstrap(options);
    },
  );
