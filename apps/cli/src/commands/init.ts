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
 * `env -u GITHUB_TOKEN` unsets an inherited `GITHUB_TOKEN` before invoking
 * `gh`. `gh` gives an inherited `GITHUB_TOKEN` unconditional precedence over
 * keyring/`gh auth login` credentials, so a daemon process that happens to
 * have one exported (a common shell-startup leftover) would make `@me` — and
 * therefore both presets — silently resolve against the wrong identity, with
 * no error to surface it. Scrubbing it here is the same fix this repo's own
 * tooling applies to every non-interactive `gh` invocation.
 *
 * Only the failure branch's `2>"$errfile"` sees `gh`'s stderr: the success
 * path's `out=$(...)` captures stdout alone, so a one-time `gh` warning or
 * `GH_DEBUG` chatter on an otherwise-successful run can never leak into the
 * diffed JSON (which would otherwise degrade `json-diff` to a raw-text
 * comparison of the polluted string). `$errfile` is scoped per-invocation by
 * `$$` (this `sh` process's own PID) and removed on both branches, so
 * concurrent ticks never collide or leak a stale file.
 *
 * Note the absence of `--repo`: `gh` resolves the repository from its
 * process working directory. That working directory is the **daemon's own**
 * cwd (§11.1) — never a "workspace/config root" the daemon might not even be
 * running from — so the scaffolded frontmatter carries an explicit `cwd:`
 * (see {@link seedPresetCwd}) pointing at the project root `init` was run
 * from, rather than relying on wherever the daemon happens to be launched.
 * Omitting `--repo` is what then lets that one `cwd` scope `gh` to the right
 * repository; interpolating an owner/name at scaffold time would hardcode it
 * right back.
 */
function ghPresetScript(preset: string, query: string): string {
  return `errfile="\${TMPDIR:-/tmp}/agentmonitors-${preset}-$$.stderr"
if out=$(env -u GITHUB_TOKEN ${query} 2>"$errfile"); then
  rm -f "$errfile"
  printf '%s\\n' "$out"
else
  cat "$errfile" >&2
  rm -f "$errfile"
  printf 'agentmonitors %s: the GitHub CLI query failed, so PR alerting is NOT running.\\nFix one of these, then re-run: agentmonitors monitor test <this file>\\n  1. Install the GitHub CLI: https://cli.github.com\\n  2. Authenticate it: gh auth login\\n  3. Run the daemon from inside a git repo that has a GitHub remote.\\n' '${preset}' >&2
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
  '# normal, not high: an unreviewed PR is real work, but it is not a regression —\n' +
  '# nothing is broken while it waits, and reviewing is a task best picked up at a\n' +
  '# turn boundary rather than mid-edit (002 §9).\n';

/**
 * `my-prs`'s urgency-rationale comment; see {@link PR_REVIEW_URGENCY_COMMENT}.
 * `normal` here is a deliberate reversal of the intuitive call (field-tested
 * live, not merely reasoned about): `json-diff` is symmetric, so a PR
 * *leaving* an actionable state diffs exactly as much as one *entering* it —
 * CI recovering, a merge, and a new PR of one's own all fire identically to
 * the transitions that would justify `high`, and no payload shaping rescues
 * that (003 §11.9).
 */
const MY_PRS_URGENCY_COMMENT =
  '# normal, not high — and the reason is not obvious. json-diff is symmetric: a PR\n' +
  '# LEAVING an actionable state diffs exactly as much as one entering it. So CI\n' +
  '# recovering red -> green, a PR merging, and a new PR of your own appearing all\n' +
  '# fire too, and no amount of payload shaping changes that (filtering the payload\n' +
  '# down to only actionable PRs just moves the benign fire from "field changed" to\n' +
  '# "entry removed"). Since not every fire can be made actionable, high would\n' +
  '# interrupt mid-turn on good news — the interrupt-storm anti-pattern (#441).\n' +
  '# normal surfaces the same information at a turn boundary instead (002 §9).\n';

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
 * `--type pr-review`'s `gh` query: open, non-draft PRs in the current repo,
 * excluding the current `gh` user's own PRs (`--search '-author:@me'` —
 * GitHub search-qualifier negation; `gh pr list` has no `--author`-exclusion
 * flag, only single-value inclusion). Without this, a PR the reviewer opens
 * themselves would appear in their own review queue: `my-prs` already covers
 * it, and "review your own PR" is not an action the body's "act as the
 * reviewer, do not self-merge" framing makes sense for. `changeset-release/*`
 * heads are excluded — the release/Version PR is never agent-reviewable.
 * Fields are chosen so `json-diff` fires on exactly the reviewer-relevant
 * transitions and nothing else: a PR entering the set (newly opened, or a
 * draft marked ready — drafts are filtered out, so "marked ready" *is* an
 * appearance), leaving it (merged/closed/converted back to draft), or
 * flipping `reviewDecision`. `updatedAt` is deliberately absent: including it
 * would fire on every push and comment.
 */
const PR_REVIEW_QUERY =
  "gh pr list --state open --limit 30 --search '-author:@me' " +
  '--json number,title,isDraft,reviewDecision,headRefName,author ' +
  '--jq \'[.[] | select(.isDraft == false and (.headRefName | startswith("changeset-release/") | not)) ' +
  '| {number, title, headRefName, reviewDecision, author: .author.login}] ' +
  "| sort_by(.number)'";

/**
 * `--type my-prs`'s `gh` query: the current `gh` user's recent PRs in the
 * current repo (`--author @me` — never a baked-in username). `--state open`
 * with a generously raised `--limit 30` — rather than `--state all --limit
 * 10` — is what keeps every still-open PR in the result set: `--limit`
 * always applies to a **newest-created-first** list, so a small `--state
 * all` window lets an older still-open PR silently age out the moment enough
 * newer PRs (including merged/closed ones, which `--state all` also counts
 * against the cap) exist — and once evicted, its CI going red produces no
 * event. `--state open` removes merged/closed PRs from the cap entirely, so
 * only actually-open work competes for the 30 slots; a PR leaving the open
 * set (merged or closed) then surfaces as a **removal** from the diffed
 * list, the same "dropped off the list" signal `pr-review` already uses —
 * see the monitor body for how to tell which happened.
 *
 * The `--jq` reduction is what makes the remaining trigger classes diff
 * cleanly:
 *
 * - **CI** — `failingChecks` is the sorted list of *failing* check names.
 *   Reducing `statusCheckRollup` to only failures (rather than diffing it
 *   whole) means a green→red transition fires (`[]` → `["build"]`) and a
 *   red→green recovery fires, while the queued/in-progress churn of a normal
 *   CI run — which would otherwise produce an interrupt per check, per push —
 *   is invisible. Note this is quieter than collapsing the rollup to a single
 *   PASSING/PENDING/FAILING verdict, which reintroduces the churn one level up:
 *   every push would fire twice (PASSING→PENDING, PENDING→PASSING) even when
 *   CI never breaks. Naming the failing checks also makes the delivered event
 *   actionable without a second round-trip.
 * - **Review feedback** — `reviewDecision` plus a per-reviewer
 *   `{by, state}` list and an issue-comment count, so a new review, a changed
 *   verdict, or a new comment all diff. (`gh pr list` exposes no review-thread
 *   data, so inline thread replies are not visible here; see the follow-up
 *   note in the monitor body.)
 * - **Draft state** — `isDraft`, so both directions of draft↔ready produce a
 *   diff. `state` is also carried through for symmetry with `pr-review`'s
 *   shape, but with `--state open` it can only ever read `OPEN` in practice —
 *   a merge or close is observed as the entry disappearing, never as this
 *   field changing.
 */
const MY_PRS_QUERY =
  'gh pr list --author @me --state open --limit 30 ' +
  '--json number,title,url,state,isDraft,reviewDecision,statusCheckRollup,latestReviews,comments ' +
  "--jq '[.[] | {number, title, url, state, isDraft, reviewDecision, " +
  'failingChecks: ([.statusCheckRollup[]? | select(((.conclusion // .state // "") | ascii_upcase) as $c ' +
  '| $c == "FAILURE" or $c == "TIMED_OUT" or $c == "CANCELLED" or $c == "ERROR" ' +
  'or $c == "ACTION_REQUIRED" or $c == "STARTUP_FAILURE") | (.name // .context)] | sort), ' +
  'reviews: ([.latestReviews[]? | {by: .author.login, state}] | sort_by(.by, .state)), ' +
  "commentCount: (.comments | length)}] | sort_by(.number)'";

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
  # Scoped to THIS repository via the explicit cwd below (init fills it in
  # with this project's root): gh resolves the repository from its process
  # working directory, which is the daemon's own cwd, NOT this file's
  # location — omitting cwd would make gh resolve whatever repo the daemon
  # happens to be launched from instead. Do not remove cwd: or add --repo.
  key: pr-review
  command:
    - sh
    - -c
    - |
${yamlBlockScalar(ghPresetScript('pr-review', PR_REVIEW_QUERY), '      ')}
  interval: 5m
  change-detection:
    strategy: json-diff
${PR_REVIEW_URGENCY_COMMENT}urgency: normal
---

The set of pull requests awaiting review in this repository changed. Act as the
reviewer.

- **A PR appeared in the list** — it was just opened, or a draft was marked
  ready (drafts are filtered out, so "marked ready" shows up as an appearance).
  Review it: check out the branch, read the diff against the issue or
  description it claims to implement, and record findings. Do not merge it
  yourself.
- **\`reviewDecision\` moved to \`CHANGES_REQUESTED\` or \`APPROVED\`** — someone
  else reviewed it. If it is now approved, note that it is ready for whoever
  owns merging; do not self-merge.
- **A PR dropped off the list** — it was merged, closed, or converted back to
  draft. No action needed beyond noting it.

Release PRs (\`changeset-release/*\` heads) are filtered out, and so are your
own PRs — those are what \`my-prs\` is for.

If instead you see a "Command failing" event, \`gh\` could not run — read the
error and fix the CLI install, auth, or working directory before trusting this
monitor again.
`.trimStart(),

  'my-prs': yaml`
---
name: My pull requests
watch:
  type: command-poll
  # Scoped to THIS repository via the explicit cwd below (init fills it in
  # with this project's root, not --repo — see the pr-review template's
  # comment for why) and to whoever gh is authenticated as (--author @me,
  # never a baked-in username).
  key: my-prs
  command:
    - sh
    - -c
    - |
${yamlBlockScalar(ghPresetScript('my-prs', MY_PRS_QUERY), '      ')}
  interval: 5m
  change-detection:
    strategy: json-diff
${MY_PRS_URGENCY_COMMENT}urgency: normal
---

Something changed on one of your own pull requests in this repository. Compare
the entries by \`number\` and act on what moved.

- **\`failingChecks\` gained a name** — CI broke. Pull the failing job's log
  (\`gh run view --log-failed\`), fix the cause on the branch, and push. Do not
  ask for review until it is green again.
- **\`failingChecks\` became empty** — CI recovered. Nothing to do beyond
  noting it.
- **\`reviewDecision\` became \`CHANGES_REQUESTED\`, or \`reviews\`/\`commentCount\`
  grew** — review feedback landed. Read it, address each point in code or reply
  explaining why not, then push and re-request review.
- **\`isDraft\` went \`true\` → \`false\`** — the PR is now soliciting review;
  make sure CI is green and the description is accurate.
- **\`isDraft\` went \`false\` → \`true\`** — it was pulled back to draft, usually
  because something was found. Find out what before pushing more.
- **A PR dropped off the list** — this only watches your still-open PRs, so a
  disappearance means it merged or was closed — check the PR on GitHub to tell
  which. If merged: delete the branch and its worktree, and close the issue it
  referenced if its acceptance criteria are met. If closed unmerged: find out
  why before reopening or re-doing the work.

Two things that look like transitions but are not:

- **A PR simply disappearing from the list** — it aged out of the most-recent-20
  window, which is a recency window, not a state. No action.
- **\`reviewDecision\` is \`""\`** — that is how \`gh\` reports "no decision yet",
  not a decision that was cleared.

\`gh pr list\` exposes no review-thread data, so inline review comments that do
not change \`reviewDecision\` are not visible here; check the PR directly when
feedback is expected.

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
 * types (005 §2: "pr-review and my-prs are not source types"). Used to (a)
 * keep {@link VALID_TYPES} — which Commander's `.choices()` still needs as one
 * flat list — split apart wherever the CLI presents types to a human, so the
 * interactive prompt and its error don't imply a preset is a kind of source,
 * and (b) drive {@link seedPresetCwd}, since only these two templates ship a
 * `key:` line for it to anchor on.
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
 * Seed an explicit `cwd:` into a PR-alerting preset's (`pr-review`/`my-prs`)
 * frontmatter, right after its `key:` line, pointing `gh`'s child process at
 * `cwd` — the project root `init` was run from.
 *
 * Without this, `command-poll`'s effective `cwd` is the **daemon's own**
 * process working directory (§11.1) — never this project's root — so a
 * daemon later launched from `$HOME`, another repo, or any directory other
 * than this one would make `gh` silently resolve a different repository's
 * PRs; `gh` exits 0 either way, so nothing would surface the mistake (issue
 * #444 review, finding 1). `init` knows the real project root at scaffold
 * time (the same `process.cwd()` {@link ensureEnabled}/{@link ensureGitignore}
 * already trust), so recording it as an absolute `cwd:` makes the scaffolded
 * file correct regardless of where the daemon is later launched from.
 */
function seedPresetCwd(template: string, cwd: string): string {
  const pattern = /^( *)key: (?:pr-review|my-prs)$/m;
  return template.replace(
    pattern,
    (match, indent: string) =>
      `${match}\n${indent}cwd: ${yamlSingleQuoted(cwd)}`,
  );
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
 * {@link seedPresetCwd} runs unconditionally for the two presets (never
 * user-seeded, never skippable) — both scaffold paths need it, not just the
 * named one, since the bootstrap path can equally scaffold `--type pr-review`.
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
  let content = applySeeds(template, type, seeds);
  if (PRESET_TYPES.has(type)) {
    content = seedPresetCwd(content, process.cwd());
  }
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
