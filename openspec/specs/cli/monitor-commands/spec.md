# cli/monitor-commands Specification

## Purpose

The `agentmonitors monitor` command surface: `monitor test` (a one-shot, in-process dry-run of a
single monitor's source), `monitor history` (the per-tick observation audit trail), and
`monitor explain` (a staged diagnosis of where a monitor's signal stops). This capability owns
arguments, flags, output shapes, fallbacks, and exit codes; the persisted rows they read are
defined by `persistence/schema` and the socket protocol by `daemon/ipc`.

## Requirements

### Requirement: monitor test usage

`agentmonitors monitor test <path> [--format <text|json>]` SHALL take a required path to a single `MONITOR.md` file and `--format` with default `text`. It SHALL run in-process, resolve the monitor's source, and run a live observation cycle without writing to the database.

#### Scenario: Dry-run leaves no durable state

- **WHEN** a user runs `agentmonitors monitor test .claude/monitors/a/MONITOR.md`
- **THEN** the source is observed and no rows are written to the SQLite store

### Requirement: monitor test stateful baseline flow

For a stateful source (`source.stateful === true`) whose first observation returns no observations, `monitor test` SHALL treat it as a baseline, wait 100 ms, and run a second observation reusing the baseline's state; JSON output from that second observation MUST carry `baseline: true`.

#### Scenario: file-fingerprint baseline then follow-up

- **GIVEN** a valid `file-fingerprint` monitor whose globs match files
- **WHEN** a user runs `agentmonitors monitor test <file>`
- **THEN** stdout reports `Baseline established.` and runs a second observation, then either prints observations or states `No changes detected since baseline. This is expected — both observations happened within the same command invocation.`

#### Scenario: JSON marks the post-baseline result

- **WHEN** the same command runs with `--format json`
- **THEN** the JSON has `"baseline": true` and the second observation's `observations`

### Requirement: monitor test text output

Text output SHALL begin with `Testing monitor "<name>" (source: <sourceName>)...` and print each observation's title and snapshot. A non-stateful source with no observations MUST print `No observations produced.`; non-fatal source warnings MUST be printed to stderr as `Warning: <warning>`.

#### Scenario: Header line

- **WHEN** a user tests a monitor named `Docs` using `file-fingerprint`
- **THEN** stdout begins with `Testing monitor "Docs" (source: file-fingerprint)...`

### Requirement: monitor test JSON output

`--format json` SHALL print `{ "monitor": "<name>", "source": "<sourceName>", "baseline": <boolean>, "observations": [{ "title", "snapshot" }] }`, adding a `warnings` array only when the source reported non-fatal warnings.

#### Scenario: Non-stateful result

- **WHEN** a non-stateful source returns observations on the first call
- **THEN** the JSON has `"baseline": false` and those observations

### Requirement: monitor test reports zero-match scopes

If the source reports `outcome: "no-files-matched"` (currently `file-fingerprint` when its scope expands to zero files), `monitor test` SHALL report an error naming `watch.globs` and `watch.cwd`, MUST NOT establish a baseline or run a second observation, and exits 1.

#### Scenario: Zero-match text

- **WHEN** a `file-fingerprint` monitor's globs match no files
- **THEN** stderr carries `Error: No files matched this monitor's globs (globs: <globs>). Check watch.globs and watch.cwd relative to workspace: <workspace>` and the exit code is 1

#### Scenario: Zero-match JSON

- **WHEN** the same command runs with `--format json`
- **THEN** stdout is `{ "monitor", "source", "baseline": false, "outcome": "no-files-matched", "observations": [], "error": "<message>" }` and the exit code is 1

### Requirement: monitor test requires a single file

If `<path>` is a directory, `monitor test` SHALL report an error naming `agentmonitors validate '<path>'` as the whole-directory command and exit 1, instead of a raw `EISDIR` read error (#338).

#### Scenario: Directory redirects to validate

- **WHEN** a user runs `agentmonitors monitor test .claude/monitors`
- **THEN** the error names `agentmonitors validate '.claude/monitors'` and the exit code is 1

### Requirement: monitor test errors and exit codes

`monitor test` SHALL exit 1, reporting via the `cli/conventions` error routing, on: file not found (`Monitor file not found: <path>`), parse error (`Parse error: <error>`), unknown source (`Unknown source: "<type>". Available: <names>`), an invalid source scope (`Invalid monitor scope: <errors>`), an observation exception (`Observation failed: <message>`), or `no-files-matched`. A successful dry-run, including a quiet no-change run that matched its scope, MUST exit 0.

#### Scenario: Missing file

- **WHEN** a user runs `agentmonitors monitor test missing/MONITOR.md`
- **THEN** stderr carries `Error: Monitor file not found: missing/MONITOR.md` and the exit code is 1

#### Scenario: Unparseable file

- **WHEN** the file's frontmatter is invalid
- **THEN** the error begins `Parse error:` and the exit code is 1

#### Scenario: JSON-mode error

- **WHEN** a parse error occurs with `--format json`
- **THEN** stdout is `{ "error": "Parse error: <error>" }` and the exit code is 1

#### Scenario: Quiet run succeeds

- **WHEN** a stateful source matches its scope and reports no changes
- **THEN** the exit code is 0

### Requirement: monitor history usage

`agentmonitors monitor history [monitorId]` SHALL accept `--socket <path>` (default: resolved per `cli/conventions`), `--workspace <path>`, `--limit <n>` (default `50`, newest first), and `--format <toon|text|json>` (default auto-detected). `[monitorId]` filters to one monitor. When given, `--workspace` filters rows to that workspace (#345, #307); omitted, rows from all workspaces are listed.

#### Scenario: Limit and filter

- **WHEN** a user runs `agentmonitors monitor history docs --limit 5 --format json`
- **THEN** at most 5 rows for monitor `docs` are returned, newest first

### Requirement: monitor history reaches the workspace daemon

`monitor history` SHALL request `history.list` over the daemon socket, auto-discovering the per-workspace socket as `doctor`, `daemon status`, and `session open` do (#374), using `--workspace` (default: the process cwd) to select which workspace's daemon and db to reach; no `--socket` is required for a daemon already running for the current workspace.

#### Scenario: Flagless history from an enabled workspace

- **GIVEN** a daemon lazily booted for the enabled workspace in the cwd
- **WHEN** a user runs `agentmonitors monitor history` with no flags
- **THEN** the rows come from that daemon

### Requirement: monitor history rows

Each row SHALL report `result` — `triggered`, `suppressed`, `no-change`, `no-files-matched`, `errored`, or `rebaselined`, with meanings per the `persistence/schema` capability's `observation_history` — plus the monitor id, source name, and timestamp. Text output MUST print one row per line as `<createdAt>  <result>  <monitorId>  (<sourceName>)`, or `No observation history.` when empty.

#### Scenario: Text row

- **WHEN** a tick for monitor `docs` on `file-fingerprint` triggered
- **THEN** a text line shows its timestamp, `triggered`, `docs`, and `(file-fingerprint)`

### Requirement: monitor history no-daemon fallback

On a genuine daemon connection failure (socket refused/absent or request timeout), `monitor history` SHALL read the persisted SQLite store in-process from the workspace-resolved db (#150, #374). When rows exist, text and TOON output MUST be prefixed with `No daemon running — showing persisted state from the last tick.`; the `--format json` array MUST be unchanged.

#### Scenario: History after daemon once

- **GIVEN** `daemon once` has run and no daemon is running
- **WHEN** a user runs `agentmonitors monitor history`
- **THEN** stdout begins with `No daemon running — showing persisted state from the last tick.` followed by the persisted rows

#### Scenario: JSON is not annotated

- **WHEN** the same command runs with `--format json`
- **THEN** stdout is the plain array of rows

### Requirement: monitor history remediation when nothing is persisted

When the daemon is unreachable and no rows are persisted, `monitor history` SHALL report an actionable remediation (never a raw `connect ENOENT …`) and exit 1. For an enabled workspace it MUST read `No daemon running for this workspace and no persisted state to show. …`; otherwise `No daemon running at the default socket and no persisted state to show. …`, per this requirement's scenarios.

#### Scenario: Enabled workspace wording

- **GIVEN** an enabled workspace with no daemon and no persisted rows
- **WHEN** a user runs `agentmonitors monitor history`
- **THEN** the error is `No daemon running for this workspace and no persisted state to show. Start it with \`agentmonitors daemon run\` (or it starts automatically when a Claude Code session opens); if the daemon you want lives at a different socket, point at it with \`--socket <path>\`. Or use \`agentmonitors monitor test <path>\` for a one-shot check.` and the exit code is 1

#### Scenario: Not-enabled wording

- **GIVEN** a workspace that is not enabled, no daemon, and no persisted rows
- **WHEN** a user runs `agentmonitors monitor history`
- **THEN** the error is `No daemon running at the default socket and no persisted state to show. Start it with \`agentmonitors daemon run\`, enable this workspace so its socket is auto-discovered (\`agentmonitors init --enable-only\`), or point at the daemon you want with \`--socket <path>\`. Or use \`agentmonitors monitor test <path>\` for a one-shot check.` and the exit code is 1

### Requirement: monitor history surfaces daemon application errors

When the daemon answers with an error, `monitor history` SHALL report it verbatim as `History failed: <message>` with exit code 1 and MUST NOT mask it as "daemon not running" (#94, #98).

#### Scenario: Daemon-side failure

- **GIVEN** a reachable daemon that answers `history.list` with an error
- **WHEN** a user runs `agentmonitors monitor history`
- **THEN** the error is `History failed: <message>` and no fallback read happens

### Requirement: monitor history rejects --dir with a hint

`monitor history` SHALL NOT accept `--dir` and MUST NOT alias it to `--workspace` (#420). The default `error: unknown option '--dir'` line and non-zero exit SHALL be followed by a second stderr line `monitor history scopes by --workspace (the project directory), not --dir.`

#### Scenario: Habitual --dir

- **WHEN** a user runs `agentmonitors monitor history --dir .claude/monitors`
- **THEN** stderr carries `error: unknown option '--dir'` and then `monitor history scopes by --workspace (the project directory), not --dir.`, and the exit code is non-zero

### Requirement: monitor explain usage

`agentmonitors monitor explain <monitorId>` SHALL accept `--dir <path>` (default `.claude/monitors`), `--workspace <path>` (default: the process cwd; used for session projection and to select which workspace's daemon/db to reach, #374), `--socket <path>`, `--history-limit <n>` (default `10`), `--event-limit <n>` (default `10`), and `--format <toon|text|json>` (default auto-detected).

#### Scenario: Limits bound structured output

- **WHEN** a user runs `agentmonitors monitor explain docs --history-limit 3 --event-limit 2 --format json`
- **THEN** `observations` has at most 3 rows and `events` at most 2

### Requirement: monitor explain builds a read-only staged report

`monitor explain` SHALL request the read-only `monitor.explain` report over the daemon socket, auto-discovering the per-workspace socket as `doctor` does (#374). The report is built from the monitor definition, scheduling state, recent `observation_history`, `monitor_state.notify_state`, `monitor_events`, and `session_event_state` rows, with stages `definition`, `scheduling`, `observation`, `notify`, `materialization`, `delivery`.

#### Scenario: Flagless explain reaches the workspace daemon

- **GIVEN** a daemon running for the enabled workspace in the cwd
- **WHEN** a user runs `agentmonitors monitor explain docs`
- **THEN** the report comes from that daemon without `--socket`

### Requirement: monitor explain text output

Text output SHALL print one line per stage with a status glyph — `✓` `ok`, `○` `healthy` (the stage ran and the correct outcome was nothing to do), `⏳` `pending` (intentionally holding, or upstream produced no input), `✗` `failure` (a real fault) — followed by a verdict line. A genuinely idle monitor MUST render `○` at the observation stage with an affirmative verdict, never `✗`.

#### Scenario: Idle monitor is not a bug

- **GIVEN** a monitor whose watched target has not changed
- **WHEN** a user runs `agentmonitors monitor explain <id> --format text`
- **THEN** the observation stage shows `○` with a reason such as "Source ran, observed 0 changes — your watched target genuinely hasn't changed (not a bug)."

### Requirement: monitor explain JSON output

JSON output SHALL be `{ monitorId, generatedAt, monitor: { id, displayName, filePath, sourceName, urgency }, stages: [{ id, label, status, reason, details }], verdict: { status, stage, reason }, observations, events, projections, leadSessions }`, where `status` is one of `ok`, `pending`, `healthy`, `failure` and `stage`/`id` is one of the six stage ids.

#### Scenario: Shape

- **WHEN** a user runs `agentmonitors monitor explain docs --format json`
- **THEN** the object has every listed top-level key and each stage has `id`, `label`, `status`, `reason`, and `details`

### Requirement: monitor explain verdict severity

The verdict SHALL reflect the highest-severity stage, ordered `failure` > `pending` > `healthy` > `ok`, not the first non-`ok` stage (#149). A `healthy` or `ok` observation stage MUST NOT mask a downstream `failure` or `pending`; an all-`healthy` monitor reports a `healthy` verdict.

#### Scenario: Downstream failure wins

- **GIVEN** an observation stage that is `healthy` and a delivery stage that is `failure`
- **WHEN** the verdict is computed
- **THEN** the verdict is `failure` at the delivery stage

### Requirement: monitor explain no-daemon fallback

On a genuine daemon connection failure, `monitor explain` SHALL run the same explain in-process against the persisted SQLite store at the workspace-resolved db (#150, #374). The connection failure itself MUST NOT be reported as a stage `failure`; stage statuses come from persisted state.

#### Scenario: No fabricated scheduling failure

- **GIVEN** a monitor that fired on a prior tick and no daemon running
- **WHEN** a user runs `agentmonitors monitor explain <id>`
- **THEN** the stages reflect the persisted state and no stage reports the daemon being down as a `failure`

### Requirement: monitor explain fallback for definition failures

In the no-daemon fallback, when the definition stage is not `ok` (parse error, monitor not found, duplicate ID, unknown source) or the monitor cannot be scheduled at all (no scheduling stage, e.g. an invalid schedule timezone, #297), `monitor explain` SHALL show the report without the no-daemon banner and exit 0.

#### Scenario: Unknown monitor id without a daemon

- **GIVEN** no daemon running
- **WHEN** a user runs `agentmonitors monitor explain nope`
- **THEN** the definition-failure report is shown with no banner and the exit code is 0

### Requirement: monitor explain fallback with persisted state

In the no-daemon fallback, when the definition is `ok` and observation history or materialized events are persisted, `monitor explain` SHALL show the real diagnosis prefixed with `No daemon running — showing persisted state from the last tick.` in text, or with a `"notice"` field holding that text alongside the full report in JSON and TOON, and exit 0.

#### Scenario: JSON notice

- **GIVEN** persisted history for `docs` and no daemon
- **WHEN** a user runs `agentmonitors monitor explain docs --format json`
- **THEN** the object has `"notice": "No daemon running — showing persisted state from the last tick."` plus the full report, and the exit code is 0

### Requirement: monitor explain remediation when nothing is persisted

In the no-daemon fallback, when the definition is `ok` but nothing is persisted (the daemon never ran), `monitor explain` SHALL report the same enabled-workspace or not-enabled remediation text as `monitor history` instead of a raw `connect ENOENT …`, and exit 1.

#### Scenario: Never-ticked monitor

- **GIVEN** an enabled workspace, a valid monitor, no daemon, and no persisted rows
- **WHEN** a user runs `agentmonitors monitor explain <id>`
- **THEN** the error begins `No daemon running for this workspace and no persisted state to show.` and the exit code is 1

### Requirement: monitor explain surfaces daemon application errors

When the daemon answers with an error, `monitor explain` SHALL report it verbatim as `Explain failed: <message>` with exit code 1 and MUST NOT mask it as "daemon not running"; malformed command arguments remain normal CLI errors.

#### Scenario: Daemon-side explain failure

- **GIVEN** a reachable daemon that answers `monitor.explain` with an error
- **WHEN** a user runs `agentmonitors monitor explain docs`
- **THEN** the error is `Explain failed: <message>` and the exit code is 1
