# cli/authoring-commands Specification

## Purpose

The command surface for authoring monitors: `init` (project bootstrap and monitor scaffolding,
including the `pr-review` and `my-prs` presets), `validate`, `scan`, `source` (list plus
placeholder plugin-management commands), and `schema generate` — their arguments, flags, output
shapes, and exit codes. What `validate` and `schema generate` check or contain is owned by the
`monitor/validation` capability.

## Requirements

### Requirement: init selects its form by the name argument

`agentmonitors init [name] [options]` SHALL run the scaffold form when the positional `[name]` is given (create `<dir>/<name>/MONITOR.md` from the chosen `--type` template) and the bootstrap form when it is omitted (one-shot project onboarding run against the current working directory).

#### Scenario: Name given scaffolds one monitor

- **WHEN** a user runs `agentmonitors init watch-docs`
- **THEN** `.claude/monitors/watch-docs/MONITOR.md` is created from the `file-fingerprint` template

#### Scenario: No name bootstraps the project

- **WHEN** a user runs `agentmonitors init`
- **THEN** the bootstrap form runs against the current working directory

### Requirement: init flags and defaults

`init` SHALL accept `--dir <dir>` (default `.claude/monitors`); `--type <type>` (default `file-fingerprint`; choices `file-fingerprint`, `api-poll`, `command-poll`, `schedule`, `incoming-changes`, and the presets `pr-review`, `my-prs`); boolean `--enable-only` and `--yes`; repeatable `--glob <pattern>` and `--command <token>`; `--name <name>`; and `--urgency <level>` with choices `low`, `normal`, `high`.

#### Scenario: Invalid --type is rejected

- **WHEN** a user runs `agentmonitors init x --type rss`
- **THEN** the CLI rejects the value with the allowed choices and exits non-zero

#### Scenario: Invalid --urgency is rejected

- **WHEN** a user runs `agentmonitors init x --urgency urgent`
- **THEN** the CLI rejects the value with the allowed choices `low`, `normal`, `high`

### Requirement: init flag applicability by form

`--enable-only` and `--yes` SHALL apply only to the bootstrap form and MUST be ignored when `[name]` is given. `--glob`, `--command`, `--name`, and `--urgency` SHALL be consumed only by the scaffold form; the bootstrap form MUST accept and ignore them (#330, #388). `--type` SHALL apply to both forms, overriding the bootstrap starter monitor's source type when `--yes` scaffolds one.

#### Scenario: Seed flags ignored by bootstrap

- **WHEN** a user runs `agentmonitors init --yes --urgency high`
- **THEN** the starter monitor is scaffolded from the unmodified template (no urgency seed applied)

#### Scenario: --type overrides the bootstrap default

- **WHEN** a user runs `agentmonitors init --yes --type schedule`
- **THEN** the starter monitor `my-monitor` uses the `schedule` template

### Requirement: init scaffold success output

The scaffold form SHALL be human-readable only (no `--format`). On success it MUST print `Created monitor: <dir>/<name>/MONITOR.md`, then hints to run `agentmonitors validate <dir>` and `agentmonitors doctor` (#331), then a line recommending `agentmonitors verify <name> --dir <dir>`, with ` --manual` appended for any `--type` other than `file-fingerprint` (#408).

#### Scenario: file-fingerprint scaffold

- **WHEN** a user runs `agentmonitors init watch-docs`
- **THEN** stdout includes `Created monitor: .claude/monitors/watch-docs/MONITOR.md`, `agentmonitors validate .claude/monitors`, `agentmonitors doctor`, and `agentmonitors verify watch-docs --dir .claude/monitors` with no `--manual`

#### Scenario: Non-file-fingerprint scaffold suggests --manual

- **WHEN** a user runs `agentmonitors init nightly --type schedule`
- **THEN** the verify line is `agentmonitors verify nightly --dir .claude/monitors --manual`

#### Scenario: Zero seed flags keep the template byte-for-byte

- **WHEN** a user scaffolds with no seed flags
- **THEN** the written file equals the template except for the derived `name:` line

### Requirement: init scaffold refuses to overwrite

If `<dir>/<name>/MONITOR.md` already exists, the scaffold form SHALL print `Monitor already exists: <dir>/<name>/MONITOR.md` to stderr, leave the file unchanged, and exit 1.

#### Scenario: Duplicate scaffold

- **GIVEN** `.claude/monitors/watch-docs/MONITOR.md` exists
- **WHEN** a user runs `agentmonitors init watch-docs`
- **THEN** stderr carries `Monitor already exists: .claude/monitors/watch-docs/MONITOR.md` and the exit code is 1

### Requirement: init rejects --glob for types without a path list

`--glob` on a `--type` whose template has no path-pattern list (`api-poll`, `command-poll`, `schedule`, `pr-review`, `my-prs`) SHALL print to stderr `--glob is not supported for --type <type> (only file-fingerprint and incoming-changes have a path-pattern list)`, create no directory, and exit 1.

#### Scenario: --glob with api-poll

- **WHEN** a user runs `agentmonitors init x --type api-poll --glob '*.json'`
- **THEN** stderr carries `--glob is not supported for --type api-poll (only file-fingerprint and incoming-changes have a path-pattern list)`, no `x/` directory exists, and the exit code is 1

### Requirement: init rejects --command for types other than command-poll

`--command` on any `--type` other than `command-poll` (including the `pr-review` and `my-prs` presets, whose `gh` query and `--jq` reduction are the preset) SHALL print to stderr `--command is not supported for --type <type> (only command-poll has a seedable command: argv array; the pr-review and my-prs presets ship a fixed gh query)`, create no directory, and exit 1.

#### Scenario: --command with a preset

- **WHEN** a user runs `agentmonitors init prs --type pr-review --command gh`
- **THEN** stderr carries the `--command is not supported for --type pr-review …` message, no directory is created, and the exit code is 1

### Requirement: init seed flags are value-preserving

Each seed flag SHALL replace only its corresponding field in the chosen template, leaving comments, other fields, and the body unchanged. `--name`, `--glob`, and `--command` values MUST be re-emitted as single-quoted YAML scalars (`'` doubled to `''`), so text with embedded quotes, colons, or `#` round-trips. A seeded scaffold MUST still pass `agentmonitors validate`.

#### Scenario: Awkward characters round-trip

- **WHEN** a user runs `agentmonitors init x --glob "docs/it's: #1/**"`
- **THEN** the file contains `- 'docs/it''s: #1/**'` under the path list and `agentmonitors validate` accepts it

### Requirement: init --glob seeds the source's path list

`--glob` SHALL be repeatable and seed `watch.globs` for `file-fingerprint` and `watch.paths` for `incoming-changes`, one list entry per flag in order.

#### Scenario: Two globs

- **WHEN** a user runs `agentmonitors init x --glob 'a/**' --glob 'b/**'`
- **THEN** `watch.globs` is the two-entry list `'a/**'`, `'b/**'`

#### Scenario: incoming-changes uses paths

- **WHEN** a user runs `agentmonitors init x --type incoming-changes --glob 'docs/**'`
- **THEN** `watch.paths` is `['docs/**']`

### Requirement: init --command seeds argv one token per flag

`--command` SHALL be repeatable and seed `command-poll`'s `watch.command` argv one token per flag, order-preserving, with no shell and no whitespace splitting; each token MUST be a single-quoted YAML scalar so leading-dash tokens, spaces, `#`, and `:` round-trip verbatim.

#### Scenario: Multi-token argv

- **WHEN** a user runs `agentmonitors init x --type command-poll --command git --command status --command --porcelain`
- **THEN** `watch.command` is `[git, status, --porcelain]`

#### Scenario: Explicit shell for a pipeline

- **WHEN** a user passes `--command sh --command -c --command 'git status -sb | grep ahead'`
- **THEN** `watch.command` has exactly three tokens, the third being `git status -sb | grep ahead`

### Requirement: init command-poll default command

When `--command` is omitted for `--type command-poll`, the scaffold SHALL keep the illustrative default `watch.command` `[git, ls-remote, origin, refs/heads/main]` so the monitor still validates and runs; `validate` flags this untouched default with a soft warning (#388).

#### Scenario: Untouched default

- **WHEN** a user runs `agentmonitors init tip --type command-poll`
- **THEN** `watch.command` is `[git, ls-remote, origin, refs/heads/main]` and `agentmonitors validate` reports the monitor valid with one warning

### Requirement: init always seeds the frontmatter name

On the scaffold path for source types, `name:` SHALL always be seeded (#375): `--name` sets it verbatim; otherwise it derives from the positional `[name]` by joining its `-`/`_`-separated segments with spaces and capitalizing the first segment. A positional with no word (e.g. `---`) MUST leave the template's own `name:` line.

#### Scenario: Derived names

- **WHEN** a user scaffolds `watch-docs` and, separately, `watchdocs`
- **THEN** the names are `Watch docs` and `Watchdocs`

#### Scenario: --name overrides

- **WHEN** a user runs `agentmonitors init watch-docs --name 'API docs'`
- **THEN** the frontmatter has `name: 'API docs'`

### Requirement: Preset names are not derived

For the `pr-review` and `my-prs` presets the scaffold SHALL keep the template's curated `name:` unless `--name` explicitly overrides it; the name MUST NOT be derived from the positional `[name]`.

#### Scenario: Curated preset name survives

- **WHEN** a user runs `agentmonitors init pr-review --type pr-review`
- **THEN** the frontmatter has `name: PRs awaiting my review`, not `Pr review`

### Requirement: init bootstrap enables the project

The bootstrap form SHALL first ensure `.claude/agentmonitors.local.md` declares `enabled: true`, writing the minimal enable shape (`enabled: true` frontmatter plus a note that the file is gitignored and safe to delete) when it does not; an already-enabled file MUST be left untouched so socket/db fields a prior `session start` persisted are never clobbered.

#### Scenario: Re-run preserves persisted fields

- **GIVEN** `.claude/agentmonitors.local.md` has `enabled: true` and a persisted `socket:`
- **WHEN** a user runs `agentmonitors init`
- **THEN** the file is byte-for-byte unchanged

### Requirement: init bootstrap fixes .gitignore

The bootstrap form SHALL ensure `.gitignore` contains the lines `.claude/*.local.*` and `/.agentmonitors/`, appending each missing line independently (creating the file if absent), as a no-op when all are present, and never duplicating a line across runs.

#### Scenario: Missing .gitignore

- **GIVEN** the project has no `.gitignore`
- **WHEN** a user runs `agentmonitors init --enable-only`
- **THEN** `.gitignore` is created containing `.claude/*.local.*` and `/.agentmonitors/`

#### Scenario: Re-run does not duplicate

- **WHEN** a user runs `agentmonitors init --enable-only` twice
- **THEN** each line appears exactly once

### Requirement: init bootstrap offers a first monitor

The bootstrap form SHALL prompt for a source type or preset (listed as separate categories) and a name only on a TTY with neither `--yes` nor `--enable-only`, then scaffold through the scaffold path. `--yes` MUST scaffold `my-monitor` of type `file-fingerprint` (or `--type`) without prompting; `--enable-only` MUST skip this step; non-TTY stdin without `--yes` MUST skip scaffolding without prompting and tell the caller to pass `--yes` or use `init <name>`.

#### Scenario: Non-interactive without --yes never hangs

- **GIVEN** stdin is not a TTY
- **WHEN** a user runs `agentmonitors init`
- **THEN** no prompt is shown, no monitor is scaffolded, and the summary suggests `agentmonitors init --yes` or `agentmonitors init <name> --type <type>`

#### Scenario: --yes scaffolds the starter monitor

- **WHEN** a user runs `agentmonitors init --yes`
- **THEN** `.claude/monitors/my-monitor/MONITOR.md` is created from the `file-fingerprint` template without prompting

#### Scenario: Prompt keeps presets distinct from sources

- **GIVEN** an interactive TTY
- **WHEN** the user enters an unknown type at the prompt
- **THEN** the error reads `Unknown source type or preset "<answer>". Try one of the listed types or presets.`

### Requirement: init bootstrap validates what it scaffolded

When the bootstrap form scaffolds a monitor, it SHALL run the `validate` command in-process against the monitors directory and print its result.

#### Scenario: Validation runs after scaffolding

- **WHEN** `agentmonitors init --yes` creates a monitor
- **THEN** the output includes the `validate` result for `.claude/monitors`

### Requirement: init bootstrap next-steps summary

The bootstrap summary SHALL say monitoring starts automatically on the next Claude Code session only if the AgentMon Claude Code plugin is used (#338), then name `agentmonitors daemon run <dir> --detach` (#389), a one-shot `agentmonitors daemon once <dir>`, and `agentmonitors doctor` (#331). When a monitor was created it MUST name `agentmonitors monitor test <file>` and `agentmonitors verify <name> --dir <dir>` (plus ` --manual` for non-`file-fingerprint`) (#408).

#### Scenario: Summary after --yes

- **WHEN** `agentmonitors init --yes` completes
- **THEN** the output includes `If you're using the AgentMon Claude Code plugin, monitoring starts automatically`, `agentmonitors daemon run .claude/monitors --detach`, `agentmonitors daemon once .claude/monitors`, `agentmonitors doctor`, and `agentmonitors verify my-monitor --dir .claude/monitors`

#### Scenario: Plugin skill is a supplement, never the sole pointer

- **WHEN** the summary mentions the `setup-monitors` skill's "Verify It Fires" section
- **THEN** it does so only as a plugin-only supplement after the CLI `verify` command line

### Requirement: init bootstrap is idempotent

Re-running the bootstrap on an already-enabled project with a correct `.gitignore` (and, for `--yes`, an already-existing default monitor) SHALL change nothing, print `AgentMon is already set up in this project — nothing to change.` together with the `agentmonitors doctor` pointer, and exit 0.

#### Scenario: No-op re-run

- **GIVEN** a project already bootstrapped with `agentmonitors init --yes`
- **WHEN** the user runs `agentmonitors init --yes` again
- **THEN** no file changes, the "nothing to change" message and `agentmonitors doctor` pointer are printed, and the exit code is 0

### Requirement: init exit codes

`init` SHALL exit 0 on success, including a no-op bootstrap re-run, and exit 1 on scaffold-form errors (existing monitor, unsupported seed flag).

#### Scenario: Bootstrap success

- **WHEN** `agentmonitors init --enable-only` succeeds
- **THEN** the exit code is 0

### Requirement: init source templates

Each `--type` SHALL scaffold a distinct starter `watch:` block: `file-fingerprint` with `globs: ['**/*.ts']`; `api-poll` with `url`, `method: GET`, `interval: 5m` and no `change-detection.strategy`; `command-poll` with `command: [git, ls-remote, origin, refs/heads/main]`, `interval: 5m`, `change-detection.strategy: text-diff`; `schedule` with `cron: '0 9 * * 1-5'`, `timezone: UTC`; `incoming-changes` with `paths: ['docs/specs/**']`, `branch: main`.

#### Scenario: api-poll infers its strategy

- **WHEN** a user scaffolds `--type api-poll`
- **THEN** the template omits `change-detection.strategy`, so the source infers it from `Content-Type`

#### Scenario: schedule template

- **WHEN** a user scaffolds `--type schedule`
- **THEN** `watch` has `cron: '0 9 * * 1-5'` and `timezone: UTC`

### Requirement: PR-alerting presets are command-poll monitors

`pr-review` and `my-prs` SHALL be ready-made `command-poll` monitors (issue #444) selected through `--type`, not source types: `pr-review` runs `gh pr list` (no `--repo`) with `key: pr-review`; `my-prs` runs `gh pr list --author @me` (no `--repo`) with `key: my-prs`; both use `interval: 5m`, `change-detection.strategy: json-diff`, and `urgency: high`. Execution and failure semantics are per the `sources/command-poll` capability.

#### Scenario: Scaffolded pr-review

- **WHEN** a user runs `agentmonitors init prs --type pr-review`
- **THEN** `watch.type` is `command-poll`, `key` is `pr-review`, `interval` is `5m`, the strategy is `json-diff`, and `urgency` is `high`

#### Scenario: Both presets are high-urgency json-diff command-poll monitors

- **WHEN** `init --type pr-review` and `init --type my-prs` are scaffolded
- **THEN** each `watch:` block is `type: command-poll` with `change-detection.strategy: json-diff` and the monitor sets `urgency: high`

### Requirement: Presets alert at high urgency only

Both presets SHALL scaffold `urgency: high`, which is safe because each payload is a membership set of actionable items rather than full PR state. `normal` MUST NOT be the preset urgency: normal reminders carry no mid-session event body, so the recipient would not learn which PR needs action until recap (per the `delivery/lifecycles` capability).

#### Scenario: High-urgency silence on non-events

- **GIVEN** a scaffolded `my-prs` monitor with a baseline
- **WHEN** a PR is approved, retitled, or receives post-merge chat
- **THEN** no event is emitted despite `urgency: high`

### Requirement: pr-review preset reviewer queue

`pr-review` SHALL track PRs in the current repository actually awaiting this identity's review — open, out of draft, not a `changeset-release/*` PR, not yet decided, and within the reviewer scope (exact predicate per "PR-alerting reviewer membership"; scope per "PR-alerting reviewer scope is selectable") — and MUST fire only when a PR enters or leaves that queue.

#### Scenario: Default reviewer scoping

- **WHEN** `pr-review` is scaffolded and not edited
- **THEN** its command carries the reviewer-scoping qualifier `review-requested:@me`
- **AND** an empty `search=''` remains a supported user-chosen alternative

#### Scenario: Only actionable transitions fire

- **WHEN** a PR appears in the queue, leaves it, or is marked ready from draft
- **THEN** an event fires; other changes to the PR do not fire

#### Scenario: Unresolved requested reviewer keeps a decided PR

- **GIVEN** a PR whose repo-wide `reviewDecision` already reads a decision but this identity is still an unresolved requested reviewer
- **WHEN** `pr-review` observes
- **THEN** the PR stays in the queue

#### Scenario: Team-request override only under the default scope

- **GIVEN** an `APPROVED` PR with a pending team review request
- **WHEN** `search=` is `review-requested:@me`, then `label:needs-review`, then unscoped
- **THEN** the PR is kept only under `review-requested:@me`

### Requirement: my-prs preset author queue

`my-prs` SHALL track the current `gh` user's recent PRs in this repository that need something from them, each entry carrying a `needs` verdict; a green, non-draft, undecided PR MUST NOT appear. Verdicts, the 6h terminal window, fetch coverage, and entry fields are per "PR-alerting author needs verdicts", "PR-alerting author fetch coverage", and "PR-alerting author supporting fields".

#### Scenario: Every actionable needs transition fires

- **WHEN** a PR's CI starts failing, changes are requested, it becomes draft, or it is merged or closed
- **THEN** `my-prs` emits an event

#### Scenario: Terminal rows are time-bounded

- **WHEN** a PR has been merged or closed for more than 6h
- **THEN** it drops out of the payload once and never re-churns

#### Scenario: Open coverage survives terminal history

- **GIVEN** an author with many recently merged PRs
- **WHEN** `my-prs` observes
- **THEN** open PRs are fetched by a separate call with `--limit 1000`, and merged/closed calls are scoped by `merged:`/`closed:` search date ranges, so neither open PRs nor an older PR terminating inside the 6h window is missed

### Requirement: Presets never overlap

The `pr-review` and `my-prs` payloads SHALL never both claim the same PR on any tick (#441): `pr-review` MUST drop every PR authored by the current identity before any other filter, under every `--search` scope, and MUST exclude PRs with failing checks.

#### Scenario: Self-authored red PR

- **GIVEN** an undecided PR authored by the current identity with failing CI
- **WHEN** both presets observe under any `pr-review` scope, including `label:needs-review` and unscoped
- **THEN** only `my-prs` carries it, with `needs: ci-failing`

#### Scenario: Third-party failing PR leaves the review queue

- **WHEN** PRs 1–4 exist, PR 2 by a third party has failing CI, and PRs 2–4 qualify for `my-prs`
- **THEN** `pr-review` holds `[1]` and `my-prs` holds `[2, 3, 4]`, disjoint

### Requirement: Preset payloads stay stable and readable

Neither preset's diffed payload SHALL carry `title`, so a retitle never re-fires an already-actionable entry, and the delivered event body MUST stay readable (short titles, no raw command text).

#### Scenario: Retitle does not re-fire

- **WHEN** an already-actionable PR is retitled
- **THEN** neither preset emits an event

### Requirement: Presets are portable across checkouts

Both presets SHALL be scoped to the session's repository through `command-poll`'s workspace-root-relative `cwd` default and to the identity of current `gh` auth: the scaffold MUST contain no `cwd:`, no `--repo`, and no username (`--author @me`), and the identity lookup MUST take its host from `gh repo view` and pass it via `gh api user --hostname`, never defaulting to `github.com`.

#### Scenario: No hardcoded repository, user, or directory

- **WHEN** either preset is scaffolded
- **THEN** the file contains no `cwd:` key, no `--repo` flag, and no literal username

#### Scenario: Enterprise host identity

- **GIVEN** the workspace's GitHub remote is on `ghe.example.com`
- **WHEN** the preset resolves the current identity
- **THEN** the identity lookup runs `gh api user --hostname ghe.example.com`

### Requirement: Presets harden the gh environment

Both presets SHALL require `gh` (authenticated) and `jq` on the daemon's `PATH`, and the recipe wrapper MUST run `unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_REPO` once before any `gh` call, so a leaked token cannot change the resolved identity and `GH_REPO` cannot defeat working-directory repository scoping across every call of a multi-call fetch. Stderr temp-file handling is per "PR-alerting recipe keeps gh stderr out of the diffed output".

#### Scenario: Leaked token is not used

- **GIVEN** `GH_TOKEN` and `GH_REPO` are exported in the daemon environment
- **WHEN** the preset runs
- **THEN** every `gh` invocation runs without `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, or `GH_REPO`

### Requirement: Presets fail loudly when gh is unusable

The recipe SHALL run in an `sh -c` wrapper that checks `command -v jq` before fetching; when `jq` is missing or any `gh` call fails (unauthenticated, outside a GitHub repository), it SHALL write `gh`'s message and a remedy naming both `gh` and `jq` to stderr and self-signal with `kill -TERM $$` (never `-$$`), so the first tick is a `command-poll` failure (`Command failing: <key>`, remedy in `stderrTail`, no baseline), never a silent baseline.

#### Scenario: Unauthenticated gh

- **GIVEN** `gh` is installed but not authenticated
- **WHEN** a scaffolded `my-prs` monitor runs its first tick
- **THEN** a `Command failing: my-prs` event is emitted with the remedy in `stderrTail`
- **AND** no baseline is recorded

#### Scenario: Missing jq is named in the remedy

- **WHEN** `jq` is not on `PATH`
- **THEN** the failing observation's `stderrTail` names `jq` as a required install

### Requirement: Upstream branch recipe polls the remote tip

The `init --type command-poll` default command (per "init command-poll default command" and "init source templates") SHALL be the upstream-branch recipe, `git ls-remote origin refs/heads/main` under `text-diff`, which contacts the remote on every run without fetching or mutating local refs, so a new monitor does not silently become a local-only status check.

#### Scenario: Remote tip change fires without a fetch

- **GIVEN** a monitor using the upstream-branch recipe baselined on SHA `aaa`
- **WHEN** the remote's `refs/heads/main` advances to `bbb` and no local fetch has run
- **THEN** the next execution's stdout changes and one observation is emitted

#### Scenario: Local ref commands are not equivalent

- **WHEN** an author instead polls `git rev-parse origin/main` or `git status -sb`
- **THEN** the value reflects only local state and can stay stale until `git fetch`/`git pull`

### Requirement: PR-alerting recipe keeps gh stderr out of the diffed output

Only the recipe's failure branch SHALL see `gh` stderr: the success path SHALL capture stdout alone, and stderr SHALL go to a `mktemp`-created private temp file removed by an `EXIT` trap on ordinary exits and explicitly before each `kill -TERM $$` self-signal.

#### Scenario: gh warning on a successful run does not pollute the payload

- **WHEN** `gh` prints a warning to stderr but exits `0`
- **THEN** the diffed stdout is the reduced JSON only

#### Scenario: Temp file is always cleaned up

- **WHEN** the recipe runs to success, or fails and self-signals
- **THEN** no `agentmonitors-<preset>-*` temp file remains

### Requirement: PR-alerting recipe reduces with a separate jq stage

The recipe SHALL pipe the fetch's raw stdout through a separate `jq -sc` stage (not `gh --jq`) that slurps every top-level value the fetch printed and reduces them to one compact JSON payload, so a fetch may be several `gh` calls.

#### Scenario: Three-call fetch reduces to one array

- **WHEN** `my-prs`'s fetch prints three JSON arrays
- **THEN** the jq stage flattens them into a single array of PRs before reduction

### Requirement: PR-alerting reviewer membership

`pr-review` SHALL project each PR to `{number, headRefName, author}` (no `title`, `updatedAt`, or `reviewDecision` field) and keep it only while: not authored by the current identity, not a draft, head not `changeset-release/*`, no failing CI, and either `reviewDecision` is `""` or `REVIEW_REQUIRED`, or the identity's `login` is in `reviewRequests`, or (default scope only) a login-less team request is pending.

#### Scenario: Retitle does not re-fire

- **GIVEN** a PR already in `pr-review`'s payload
- **WHEN** its title changes
- **THEN** no observation is emitted

#### Scenario: Own outstanding request keeps an APPROVED PR visible

- **WHEN** a PR's repo-wide `reviewDecision` is `APPROVED` but the current identity's `login` is still in `reviewRequests`
- **THEN** the PR stays in `pr-review`'s payload

#### Scenario: Draft marked ready appears

- **WHEN** a third-party draft PR is marked ready for review
- **THEN** it enters `pr-review`'s payload and one observation is emitted

### Requirement: PR-alerting reviewer scope is selectable

`pr-review`'s `--search` scope SHALL default to `review-requested:@me`, held in one editable shell variable (`search='review-requested:@me'`) that both the fetch and the team-request clause read; `-author:@me`, `label:needs-review`, and an empty scope SHALL be supported alternatives. Under any non-default scope a pending team request alone SHALL NOT keep a decided PR visible.

#### Scenario: Default scope in the generated scaffold

- **WHEN** `init --type pr-review` is scaffolded without edits
- **THEN** the command contains `search='review-requested:@me'`

#### Scenario: Label scope drops a team-only APPROVED PR

- **GIVEN** `search='label:needs-review'`
- **WHEN** an `APPROVED` PR's only pending request is a team request
- **THEN** the PR is not in `pr-review`'s payload

### Requirement: PR-alerting author fetch coverage

`my-prs` SHALL fetch with three `gh pr list` calls — `--state open --limit 1000`; `--state merged --search "merged:>=$cutoff" --limit 1000`; `--state closed --search "closed:>=$cutoff -is:merged" --limit 1000` — where `cutoff` is now minus 6 hours (GNU `date -d @epoch`, else BSD `date -r epoch`), and union the results (`unique_by(.number)` as defense in depth).

#### Scenario: Open PR survives terminal-history volume

- **WHEN** a still-open, CI-failing PR is older than 99 newer merged PRs
- **THEN** it remains in `my-prs`'s payload

#### Scenario: Old PR merged inside the window is not missed

- **WHEN** a PR created long ago is merged one hour before the poll
- **THEN** the merged call's date-range search returns it and it appears with `needs: merged`

### Requirement: PR-alerting author needs verdicts

`my-prs` SHALL reduce each PR to one `needs` verdict and drop it when `none`: `merged`/`closed` (only within 6 hours of `mergedAt`/`closedAt`, never `updatedAt`), `ci-failing`, `changes-requested`, or `draft`. A green, non-draft, undecided open PR SHALL be `none`. No timestamp SHALL be emitted; fractional seconds are stripped and an unparseable timestamp counts as current.

#### Scenario: Ordinary CI run is silent

- **WHEN** a green PR's CI goes queued → running → passing
- **THEN** no observation is emitted

#### Scenario: Terminal rows age out after 6 hours and do not churn

- **WHEN** a merged PR receives a post-merge comment 2 hours after merge
- **THEN** no observation is emitted
- **AND WHEN** the poll occurs more than 6 hours after `mergedAt`
- **THEN** the row leaves the payload once

#### Scenario: Draft toggles fire in both directions

- **WHEN** an own ready PR is converted to draft, and later marked ready
- **THEN** it enters the payload with `needs: draft`, then leaves it

#### Scenario: PR opened directly as a draft enters as draft

- **WHEN** the author opens a new PR as a draft
- **THEN** it enters `my-prs` with `needs: draft` exactly like a ready PR pulled back to draft (accepted characterization)

### Requirement: PR-alerting author supporting fields

Non-terminal `my-prs` entries SHALL carry `failingChecks` (sorted names of failing `statusCheckRollup` entries, `CheckRun` `conclusion` and `StatusContext` `state`), per-reviewer `{by, state, at}` from `latestReviews` (`at` = `submittedAt`), and an issue-comment count excluding the PR author's and `[bot]` logins. `reviewDecision` SHALL be compared against `""`, never coalesced from `null`.

#### Scenario: Repeat review in the same state still fires

- **WHEN** a reviewer submits a second `CHANGES_REQUESTED` review on a PR already needing changes
- **THEN** the entry's `at` changes and one observation is emitted

#### Scenario: Author and bot comments do not fire

- **WHEN** only the PR author or a `dependabot[bot]` login comments
- **THEN** no observation is emitted
- **AND WHEN** a reviewer comments
- **THEN** one observation is emitted

#### Scenario: Approval and retitle are silent

- **WHEN** an own PR is approved or retitled with no other change
- **THEN** no observation is emitted

### Requirement: validate usage

`agentmonitors validate [path] [options]` SHALL take an optional `[path]` (default `.claude/monitors`) naming a monitors directory and `--format <text|json>` (default `text`); `toon` is not offered. It runs in-process.

#### Scenario: Invalid --format rejected

- **WHEN** a user runs `agentmonitors validate --format toon`
- **THEN** the CLI rejects the value and exits non-zero

### Requirement: validate applies the monitor validation contract

`validate` SHALL check every `MONITOR.md` under the path as defined by the `monitor/validation` capability (parse, known `watch.type`, full per-source schema of `watch` minus `type`, unique monitor IDs) and report each failure as an invalid monitor. An unknown source error MUST list the available sources.

#### Scenario: Directory of valid monitors

- **WHEN** a user validates a directory whose monitors are all valid
- **THEN** every monitor is listed as valid and the exit code is 0

#### Scenario: Unknown source name

- **WHEN** a monitor has `watch.type: rss`
- **THEN** it is invalid with `Unknown source "rss". Available sources: file-fingerprint, api-poll, command-poll, schedule, incoming-changes`

#### Scenario: Source config violates the schema

- **WHEN** a monitor has `watch: { type: file-fingerprint, globs: 42 }`
- **THEN** it is invalid and the exit code is 1

#### Scenario: Old top-level source/scope shape gets a hint

- **WHEN** a monitor fails to parse and uses top-level `source:` plus `scope:` without `watch:`
- **THEN** its error has the hint `did you mean to use the current watch shape? Move source/scope into watch:, for example: watch: { type: <source>, ... }` appended

### Requirement: validate text output

Text output SHALL print `Valid monitors: <n>` followed by `  <id>: <name>` lines, then `Invalid monitors: <n>` followed by `  <id>: <error>` lines, then `Warnings: <n>` followed by `  <id>: <warning>` lines, omitting each section when its count is 0, and `No monitors found.` when there are no valid or invalid monitors. Lines MUST use the monitor ID, falling back to the file path when no ID can be derived.

#### Scenario: Mixed directory

- **WHEN** a directory has one valid monitor `a` and one invalid monitor `b`
- **THEN** stdout has `Valid monitors: 1`, `  a: <name>`, `Invalid monitors: 1`, `  b: <error>`

#### Scenario: Empty directory

- **WHEN** a user validates an empty directory
- **THEN** stdout is `No monitors found.` and the exit code is 0

### Requirement: validate soft warnings

`validate` SHALL report soft, non-fatal warnings about otherwise-valid monitors that never change the valid/invalid counts or the exit code. Currently: a `command-poll` monitor whose `watch.command` equals the untouched scaffold default `git ls-remote origin refs/heads/main` (#388), with a message naming how to seed the intended command and that it is safe to ignore when upstream-tip polling is intended.

#### Scenario: Untouched command-poll scaffold

- **GIVEN** a `command-poll` monitor with `command: [git, ls-remote, origin, refs/heads/main]`
- **WHEN** a user runs `agentmonitors validate`
- **THEN** the monitor counts as valid, a `Warnings: 1` section names it, and the exit code is 0

### Requirement: validate JSON output

`--format json` SHALL print `{ valid, invalid, monitors: [{ id, name, source }], duplicateIds: [{ id, filePaths }], errors: [{ filePath, error }], warnings: [{ id, warning }] }`. `errors[].filePath` MUST carry the monitor ID (key kept for compatibility); each duplicate ID MUST also be folded into `errors`; `duplicateIds` and `warnings` are `[]` when empty.

#### Scenario: Duplicate IDs folded into errors

- **GIVEN** two `MONITOR.md` files that derive the same id `dup`
- **WHEN** a user runs `agentmonitors validate --format json`
- **THEN** `duplicateIds` has one entry with both file paths and `errors` contains an entry whose `error` starts `Duplicate monitor id "dup"`
- **AND** `invalid` counts that entry

### Requirement: validate requires a directory

If `[path]` does not exist, `validate` SHALL report `path "<path>" does not exist` and exit 1; if it is a file, it MUST report an error naming `agentmonitors monitor test '<path>'` as the single-file command and exit 1 (#338). Errors follow the `cli/conventions` error routing.

#### Scenario: Nonexistent directory

- **WHEN** a user runs `agentmonitors validate /nonexistent`
- **THEN** stderr carries `Error: path "/nonexistent" does not exist` and the exit code is 1

#### Scenario: Missing path in JSON mode

- **WHEN** a user runs `agentmonitors validate /nonexistent --format json`
- **THEN** stdout is a JSON object with an `error` field and the exit code is 1

#### Scenario: File redirects to monitor test

- **WHEN** a user runs `agentmonitors validate .claude/monitors/a/MONITOR.md`
- **THEN** the error names `agentmonitors monitor test '.claude/monitors/a/MONITOR.md'` and the exit code is 1

### Requirement: validate exit codes

`validate` SHALL exit 1 if any monitor is invalid and exit 0 if all monitors pass or none are found.

#### Scenario: One invalid monitor

- **WHEN** one of three monitors is invalid
- **THEN** the exit code is 1

### Requirement: scan usage

`agentmonitors scan [dir] [options]` SHALL take an optional `[dir]` (default `.claude/monitors`) and `--format <toon|json|text>` (default auto-detected per `cli/conventions`), and SHALL find and list every `MONITOR.md` without performing source validation. It runs in-process.

#### Scenario: Schema-invalid monitor still listed

- **WHEN** a parseable monitor has an invalid source config
- **THEN** `scan` lists it like any other monitor

### Requirement: scan text output

Text output SHALL be a columnar table with headers `ID`, `Name`, `Source`, `Urgency` (column widths 30, 40, 20, open). If parse errors occurred it MUST append `<n> file(s) failed to parse.`; duplicate ids MUST be listed with their file paths; with no monitors and no errors it prints `No monitors found.`

#### Scenario: Parse failures summarized

- **WHEN** two files fail to parse
- **THEN** the text output ends with `2 file(s) failed to parse.`

### Requirement: scan structured output

JSON and TOON output SHALL encode `{ monitors: [{ id, name, source, urgency, tags, notify }], errors: [{ filePath, error }], duplicateIds: [{ id, filePaths }] }`, with `tags` defaulting to `[]`, `notify` to `null`, and `duplicateIds` to `[]`. Each duplicate entry MUST carry the folder-derived `id` and the `filePaths` (at least two) deriving it.

#### Scenario: Defaults for absent fields

- **WHEN** a monitor declares no `tags` and no `notify`
- **THEN** its JSON entry has `"tags": []` and `"notify": null`

#### Scenario: Lists monitors and parse failures

- **WHEN** a directory holds one valid monitor and one unparseable file
- **THEN** `monitors` has one entry and `errors` has one entry with the file path and parse error

### Requirement: scan exit codes

`scan` SHALL exit 0 on a clean scan (any number of monitors, or none, with empty `errors` and `duplicateIds`) regardless of `--format`, and exit 1 when `errors` or `duplicateIds` is non-empty (#420) or when `[dir]` is missing or not a directory, while still printing the offending files or ids.

#### Scenario: Duplicate id fails the scan

- **GIVEN** two monitors derive the same id
- **WHEN** a user runs `agentmonitors scan --format json`
- **THEN** the JSON lists the duplicate and the exit code is 1

#### Scenario: Empty directory is clean

- **WHEN** a user scans an empty directory
- **THEN** the exit code is 0

### Requirement: source list

`agentmonitors source list [--format <toon|json|text>]` (default auto-detected) SHALL list every source in the bundled registry — currently `file-fingerprint`, `api-poll`, `command-poll`, `schedule`, `incoming-changes` — with each source's config fields, per-field descriptions from its JSON Schema `description`, and required fields. It runs in-process.

#### Scenario: Reflects the bundled registry

- **WHEN** a user runs `agentmonitors source list --format json`
- **THEN** the `name` values are exactly the five bundled sources

### Requirement: source list text output

Text output SHALL print `Installed sources:` then, per source, `  <name>`, `    Config fields: <f1>, <f2>, ...`, one `    - <field>: <description>` line per described field, and `    Required: <f1>, ...` or `    Required: (none)`.

#### Scenario: Source with no required fields

- **WHEN** a source's schema has no `required` list
- **THEN** its block ends with `    Required: (none)`

### Requirement: source list structured output

JSON output SHALL be an array of `{ name, configFields, scopeFields, fieldDescriptions, required }`, where `scopeFields` is a backwards-compatible alias of `configFields` (fields written flat inside `watch:`) and `fieldDescriptions` maps field to plain terminal-safe description. TOON output MUST carry the same fields, rendering `fieldDescriptions` as `{ field, description }` rows.

#### Scenario: scopeFields alias

- **WHEN** a user runs `agentmonitors source list --format json`
- **THEN** every entry's `scopeFields` equals its `configFields`

### Requirement: source search placeholder

`agentmonitors source search [query]` SHALL be a placeholder (NP3) that prints to stderr `Plugin search is not yet implemented.` (followed by ` (query: "<query>")` when a query is given) and `Install plugins manually: pnpm add --prefix ~/.config/agentmonitors <package-name>`, and exits 1.

#### Scenario: Search with a query

- **WHEN** a user runs `agentmonitors source search rss`
- **THEN** stderr carries `Plugin search is not yet implemented. (query: "rss")` and the manual-install line, and the exit code is 1

### Requirement: source install placeholder

`agentmonitors source install <name>` SHALL be a placeholder (NP3) that prints to stderr `Plugin installation is not yet implemented: <name>` and `Install manually: pnpm add --prefix ~/.config/agentmonitors <name>`, and exits 1.

#### Scenario: Install attempt

- **WHEN** a user runs `agentmonitors source install my-source`
- **THEN** stderr carries both lines naming `my-source` and the exit code is 1

### Requirement: source update placeholder

`agentmonitors source update [name]` SHALL be a placeholder (NP3) that prints to stderr `Plugin update is not yet implemented.` (followed by ` (package: <name>)` when a name is given) and exits 1.

#### Scenario: Update a named package

- **WHEN** a user runs `agentmonitors source update my-source`
- **THEN** stderr carries `Plugin update is not yet implemented. (package: my-source)` and the exit code is 1

### Requirement: source remove placeholder

`agentmonitors source remove <name>` SHALL be a placeholder (NP3) that prints to stderr `Plugin removal is not yet implemented: <name>` and exits 1.

#### Scenario: Remove attempt

- **WHEN** a user runs `agentmonitors source remove my-source`
- **THEN** stderr carries `Plugin removal is not yet implemented: my-source` and the exit code is 1

### Requirement: schema generate

`agentmonitors schema generate [-o, --output <file>]` SHALL output the combined monitor JSON Schema generated from the bundled source registry (contents per the `monitor/validation` capability), pretty-printed with 2-space indent: to stdout without `--output`, or written to `<file>` followed by printing `Schema written to <file>`. It runs in-process.

#### Scenario: Source-discriminated schema on stdout

- **WHEN** a user runs `agentmonitors schema generate`
- **THEN** stdout is a draft-07 JSON Schema whose `watch.type` enum lists the registered sources with a per-source `if/then` conditional

#### Scenario: Write to a file

- **WHEN** a user runs `agentmonitors schema generate -o schema.json`
- **THEN** `schema.json` holds the schema and stdout is `Schema written to schema.json`

### Requirement: schema generate exit codes

`schema generate` SHALL exit 0 on success. It has no command-specific error handling: a filesystem error writing `--output` propagates to the top-level handler, which reports `Error: <message>` on stderr with exit code 1.

#### Scenario: Unwritable output path

- **WHEN** a user runs `agentmonitors schema generate -o /nonexistent-dir/schema.json`
- **THEN** stderr carries `Error: ` followed by the filesystem error and the exit code is 1
