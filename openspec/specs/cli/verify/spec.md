# cli/verify Specification

## Purpose

The `agentmonitors verify` command: an active, stateful end-to-end proof that one monitor delivers
right now — boot a daemon, register a session, trigger a real change, and confirm it is observed,
materialized, and delivered — printing one PASS (with the delivered `additionalContext`) or one
FAIL naming the failing stage. It is the canonical replacement for the manual "prove it" recipe.

## Requirements

### Requirement: verify is a top-level command

`verify` SHALL be a top-level command, a sibling of `doctor`, not a `monitor` subcommand. Rationale: `monitor test`/`history`/`explain` are read-only inspectors that never mutate state or boot a daemon, while `verify` boots a daemon, registers a session, and triggers a real change.

#### Scenario: Invocation

- **WHEN** the author runs `agentmonitors verify docs-watch`
- **THEN** the end-to-end proof runs for monitor `docs-watch`

### Requirement: verify flags

`agentmonitors verify [monitor]` SHALL accept `--dir <path>` (default `<workspace>/.claude/monitors`), `--workspace <path>` (default: current working directory, resolved to an absolute path), `--manual`, `--trigger-cmd <shell>`, `--use-workspace-daemon`, `--timeout-ms <ms>` (default: derived budget), and `--format <format>` (choices `text`, `json`; default `text`).

#### Scenario: Invalid format

- **WHEN** `agentmonitors verify --format yaml` runs
- **THEN** the command rejects the value and exits non-zero

### Requirement: verify resolves the monitor and its source

`[monitor]` SHALL default to the sole monitor when exactly one exists; omitting it with zero or more than one monitor SHALL be a `setup` failure naming the choices. The monitor's `watch.type` SHALL be a registered source, else a `setup` failure listing the available sources.

#### Scenario: Ambiguous monitor

- **GIVEN** monitors `a` and `b`
- **WHEN** `agentmonitors verify` runs with no monitor argument
- **THEN** it fails as `setup`, names `a` and `b`, and exits 1

#### Scenario: Sole monitor

- **GIVEN** exactly one monitor `docs-watch`
- **WHEN** `agentmonitors verify` runs with no monitor argument
- **THEN** it verifies `docs-watch`

### Requirement: verify trigger mode selection

`verify` SHALL produce the change in exactly one mode: `auto` (default), `command` (`--trigger-cmd`), or `manual` (`--manual`). Passing both `--manual` and `--trigger-cmd` SHALL be a setup error, and an empty or whitespace-only `--trigger-cmd` SHALL be an error.

#### Scenario: Both trigger flags

- **WHEN** `agentmonitors verify m --manual --trigger-cmd 'touch x'` runs
- **THEN** it reports `Pass either --manual or --trigger-cmd, not both: --manual waits for you to make the change, --trigger-cmd makes it for you.` and exits non-zero

#### Scenario: Empty trigger command

- **WHEN** `agentmonitors verify m --trigger-cmd '  '` runs
- **THEN** it reports `--trigger-cmd requires a non-empty shell command.` and exits non-zero

### Requirement: Auto trigger fabricates a file-fingerprint change

In `auto` mode only `file-fingerprint` monitors SHALL be auto-triggered: `verify` creates a scratch file `agentmonitors-verify-<token><ext>` under the first pattern glob's static directory prefix (segments before the first glob-magic segment) with the glob's extension; for a literal single-file glob it creates the watched file if absent, or briefly edits and restores it if present.

#### Scenario: Recursive glob

- **GIVEN** a monitor watching `docs/**/*.md`
- **WHEN** `agentmonitors verify` auto-triggers
- **THEN** it creates `docs/agentmonitors-verify-<token>.md`

#### Scenario: Literal file that already exists

- **GIVEN** a monitor watching the existing literal file `config.json`
- **WHEN** `agentmonitors verify` auto-triggers
- **THEN** it edits `config.json` and restores its original bytes on exit

### Requirement: Auto trigger fails fast on underivable globs

When the glob's filename segment is itself a wildcard (e.g. `file-?.md`, `data-[0-9].json`) or its only variability is a wildcard directory with a literal filename, no scratch file can match; `verify` SHALL then fail fast with `no-change` or `no-files-matched` and point at `--manual`.

#### Scenario: Wildcard filename

- **GIVEN** a monitor watching `file-?.md`
- **WHEN** `agentmonitors verify` auto-triggers
- **THEN** it fails with `no-change` or `no-files-matched` and the message names `--manual`

### Requirement: Command trigger runs the operator's shell command

With `--trigger-cmd`, `verify` SHALL run the command itself after baseline, through the OS default shell (`/bin/sh -c` on POSIX) with cwd set to the workspace, then observe, materialize, and deliver in one non-interactive run. It SHALL NOT revert the command's effects. A non-zero exit SHALL be a `setup` failure on the `trigger` stage, distinct from a `no-change` verdict.

#### Scenario: Command-poll monitor verified in one call

- **GIVEN** a `command-poll` monitor watching for new files in the workspace
- **WHEN** `agentmonitors verify m --trigger-cmd 'touch new-file.txt'` runs
- **THEN** `new-file.txt` is created in the workspace and remains after the run

#### Scenario: Failing trigger command

- **WHEN** `agentmonitors verify m --trigger-cmd 'exit 3'` runs
- **THEN** the `trigger` stage fails with kind `setup`, not `no-change`, and the exit code is 1

### Requirement: Manual trigger blocks without reading stdin

With `--manual`, `verify` SHALL block for the detect budget while the operator makes the change out of band, then watch for it; it SHALL NOT read stdin. Its `budget-exceeded` failure message SHALL point call-and-return agents at `--trigger-cmd`.

#### Scenario: No change made

- **WHEN** `agentmonitors verify m --manual` runs and nobody changes anything
- **THEN** it fails with `budget-exceeded` and the message names `--trigger-cmd`

### Requirement: verify boots an isolated daemon by default

By default `verify` SHALL run an isolated daemon on a temporary socket and db as a supervised child (piped stderr, reaping disabled) and fully tear it and its db down on exit (#398). With `--use-workspace-daemon` it SHALL reuse the workspace daemon, or detach-boot one, never tear it down, and require an enabled workspace.

#### Scenario: Isolated run leaves no trace

- **WHEN** `agentmonitors verify m` completes
- **THEN** the temporary socket and db no longer exist and the workspace db has no events from the run

#### Scenario: Workspace daemon persists

- **GIVEN** an enabled workspace
- **WHEN** `agentmonitors verify m --use-workspace-daemon` completes
- **THEN** the workspace daemon is still running and a following `doctor` reflects the delivery

### Requirement: verify registers a throwaway session

`verify` SHALL register a throwaway lead session for the run and close it on exit.

#### Scenario: Session closed after run

- **WHEN** `agentmonitors verify m --use-workspace-daemon` completes
- **THEN** its `agentmonitors-verify-*` session is no longer active

### Requirement: verify waits for a baseline before triggering

`verify` SHALL wait for the monitor's first observation (which emits no event) to land before triggering.

#### Scenario: Trigger after baseline

- **WHEN** `agentmonitors verify m` runs
- **THEN** the `baseline` stage passes before the `trigger` stage starts

### Requirement: verify observe-stage outcomes

`verify` SHALL poll observation history for a post-trigger row: `triggered` is success; `no-files-matched` always fails fast; `no-change` fails fast pointing at `--manual`; `suppressed` (a debounce/throttle window settling) SHALL keep the wait alive and suppress the `no-change` fail-fast until the flush or the budget (#399 criterion 4).

#### Scenario: Debounced change

- **GIVEN** a monitor with a debounce notify window
- **WHEN** post-trigger history reads `[suppressed, no-change, triggered]`
- **THEN** `verify` keeps waiting through the `no-change` row and the `observe` stage passes on `triggered`

### Requirement: No-change requires two distinct post-trigger rows

A `no-change` verdict SHALL require two distinct post-trigger observation-history rows (different ids) both reporting `no-change`; one row re-read across polls is not sufficient. A `triggered` row SHALL still win immediately (#442 round 19).

#### Scenario: Stale in-flight tick

- **GIVEN** a tick in flight at trigger time records one `no-change` row after the trigger timestamp
- **WHEN** `verify` polls and re-reads only that row
- **THEN** it does not fail with `no-change` until a second, different `no-change` row appears

### Requirement: verify budget derivation

The budget SHALL derive from the monitor's own timing (#399 criterion 2): `interval` (explicit `watch.interval`, else file-fingerprint 30s, api-poll 300s, schedule's 60s tick), `settle` (debounce `settle-for`; 0 for throttle; high urgency without `notify` uses the runtime's default 15s debounce, #406), `highClaimSettle` (15s for high, else 0), and `margin = max(5s, 25% of interval)`.

#### Scenario: Default high-urgency file monitor

- **GIVEN** a `high` file-fingerprint monitor with no `watch.interval` and no `notify`
- **WHEN** the budget is derived
- **THEN** interval is 30s, settle 15s, highClaimSettle 15s, margin 7.5s, baseline 37.5s, and detect 67.5s

#### Scenario: Throttled normal monitor

- **GIVEN** a `normal` monitor with `watch.interval` `40s` and a throttle notify
- **WHEN** the budget is derived
- **THEN** settle is 0, highClaimSettle is 0, margin is 10s, and detect is 50s

### Requirement: verify phase budgets

`verify` SHALL budget `baseline = interval + margin` and `detect = interval + settle + highClaimSettle + margin`, plus `noChangeConfirmMs = 2 × interval + margin`, `postObserveBudgetMs = settle + highClaimSettle + margin`, and worst-case `totalMs = baseline + max(detect, noChangeConfirmMs) + postObserveBudgetMs`. Interval and settle defaults SHALL come from `@agentmonitors/core`'s `schedulingDefaults` and the runtime's notify defaults, never a hand-mirrored copy.

#### Scenario: Total for a 20s normal debounce-free monitor

- **GIVEN** interval 20s, settle 0, normal urgency
- **WHEN** the budget is derived
- **THEN** margin is 5s, baseline 25s, detect 25s, noChangeConfirmMs 45s, postObserveBudgetMs 5s, and totalMs 75s

### Requirement: Observe deadline extension under the default budget

With the default derived budget, `verify` SHALL extend the observe stage's deadline to at least `noChangeConfirmMs` so a genuine `no-change` verdict can gather its second row. An explicit `--timeout-ms` SHALL never be extended; a value shorter than one interval SHALL fail fast with `budget-exceeded`.

#### Scenario: Explicit short timeout

- **GIVEN** a monitor with a 30s interval
- **WHEN** `agentmonitors verify m --timeout-ms 5000` runs and no change lands within 5s
- **THEN** it fails with `budget-exceeded` without waiting for a second `no-change` row

### Requirement: Materialize and deliver re-granted after a late observe

With the default derived budget, materialize and deliver SHALL get the deadline `max(detect deadline, observe resolution time + postObserveBudgetMs)` (#442 round 20). An explicit `--timeout-ms` SHALL keep the detect deadline as the hard total cap for materialize and deliver.

#### Scenario: Real change lands in the extended window

- **GIVEN** a 20s-interval monitor whose real change is observed about 40s after trigger, past the 25s detect deadline
- **WHEN** `verify` runs with the default budget
- **THEN** materialize and deliver still have `postObserveBudgetMs` from the observe resolution and the run can PASS

### Requirement: verify progress on stderr

`verify` SHALL print elapsed/ETA progress lines to stderr and the report to stdout. `--timeout-ms <ms>` SHALL override the detect-phase budget.

#### Scenario: Long wait

- **WHEN** `agentmonitors verify m --format json` waits for a slow monitor
- **THEN** progress lines appear on stderr and stdout holds only the JSON report

### Requirement: verify materialize stage

After observe succeeds, `verify` SHALL confirm an unread event exists for its session.

#### Scenario: Event materialized

- **WHEN** a `triggered` row is observed
- **THEN** the `materialize` stage passes once an unread event exists for the verify session

### Requirement: verify deliver stage uses the real hook path

`verify` SHALL claim through the real `hook deliver` path: `high` urgency at `turn-interruptible` (previewing settled high events and packing them under the 4000-char cap as `hook deliver` does), otherwise the `post-compact` recap; and render the same `additionalContext` a hook would inject. A claim that surfaces nothing SHALL fail as `delivery-empty`.

#### Scenario: Normal-urgency proof

- **GIVEN** a `normal` monitor
- **WHEN** `verify` reaches the deliver stage
- **THEN** it claims at `post-compact` and the PASS output echoes the recap `additionalContext`

### Requirement: verify reverts its trigger

The auto-trigger scratch file or edit SHALL be reverted on exit and on SIGINT/SIGTERM. A `--trigger-cmd`'s effects SHALL NOT be reverted.

#### Scenario: Interrupted isolated run

- **GIVEN** `verify` created a scratch file
- **WHEN** the run receives SIGINT
- **THEN** the scratch file is removed before exit

### Requirement: Workspace-daemon cleanup of a synthetic scratch key

Under `--use-workspace-daemon`, for a scratch sibling key, `verify` SHALL delete the file and, in one non-blocking call, retract its delivered create event and install a durable self-expiring object-event suppression (tombstone) so the tick sweeps the pending `File deleted: …` before any session sees it (#407, #414). The tombstone TTL SHALL be `detect + interval + settle`, minimum 60s.

#### Scenario: No spurious deletion event

- **GIVEN** `verify --use-workspace-daemon` triggered via a scratch file
- **WHEN** a later session opens after the run
- **THEN** it receives no `File deleted: …/agentmonitors-verify-…` event

### Requirement: Workspace-daemon cleanup of a real watched path

Under `--use-workspace-daemon`, for a literal single-file glob whose file `verify` created, `verify` SHALL wait for its own create and delete events to materialize and retract only those exact event ids, never by object key (#407, #418). A literal file that pre-existed (edited and restored) SHALL never have its events erased.

#### Scenario: Genuine change at the same path survives

- **GIVEN** `verify --use-workspace-daemon` created and removed the watched literal file `notes.md`
- **WHEN** the user edits `notes.md` shortly afterwards
- **THEN** the user's change is delivered and only verify's two events were retracted

### Requirement: Object-event suppression accepts only synthetic keys

The durable tombstone entry points (`AgentMonitorRuntime.suppressObjectEvents` and the `events.suppressObject` IPC verb) SHALL reject a non-synthetic object key outright. Retracting an event in either cleanup mechanism SHALL also drop the per-recipient cursor its projection seeded, only for the sessions that received it.

#### Scenario: Real path rejected

- **WHEN** `events.suppressObject` is called with a real watched path as the object key
- **THEN** the request is rejected and nothing is suppressed

### Requirement: Interrupted workspace-daemon runs leave no permanent stray state

On SIGINT/SIGTERM, `verify` SHALL run the object-appropriate cleanup best-effort (revert, then tombstone or id-retract) and end its session before exiting (#414). After an uncatchable kill, the daemon's session-reap backstop, when it marks a stale `agentmonitors-verify-*` session dormant, SHALL tombstone and retract that session's synthetic scratch objects with TTL `max(5min, interval + settle + margin)`.

#### Scenario: SIGKILL mid-run

- **GIVEN** `verify --use-workspace-daemon` is killed with SIGKILL after its scratch events materialize
- **WHEN** the daemon later reaps the stale `agentmonitors-verify-*` session
- **THEN** the scratch objects are tombstoned and retracted and never delivered to another session

### Requirement: verify fails fast when the daemon dies

If the daemon exits at any point, `verify` SHALL fail with kind `daemon-died` and print the daemon's captured output, never an ambiguous empty result.

#### Scenario: Daemon crash

- **GIVEN** the isolated daemon crashes during observe
- **WHEN** `verify` notices the exit
- **THEN** it prints a FAIL line and, under `Daemon output:`, the daemon's stderr, and `daemonStderr` is populated in JSON

### Requirement: verify text output

Text output SHALL list the stages `daemon`, `session`, `baseline`, `trigger`, `observe`, `materialize`, `deliver` as a checklist, then either a `PASS` line followed by the delivered `additionalContext`, or a `FAIL` line naming the failing stage (and, for `daemon-died`, the daemon's own output).

#### Scenario: Passing run

- **WHEN** `agentmonitors verify docs-watch` succeeds
- **THEN** stdout contains `PASS  docs-watch delivers end-to-end` and then the delivered `additionalContext`

### Requirement: verify JSON output

`--format json` SHALL emit `{ ok, monitorId, stages: [{ name, status: pass|fail|pending|skip, detail }], failure: { kind: no-change|no-files-matched|budget-exceeded|daemon-died|delivery-empty|setup, message } | null, additionalContext, daemonStderr, elapsedMs }`. `failure` SHALL be `null` on success; `additionalContext` SHALL be the delivered proof on success and `null` on failure.

#### Scenario: Failed run JSON

- **WHEN** `agentmonitors verify m --format json` fails with `no-change`
- **THEN** `ok` is `false`, `failure.kind` is `no-change`, and `additionalContext` is `null`

### Requirement: verify exit codes

`verify` SHALL exit 0 on PASS and 1 on any FAIL (`no-change`, `no-files-matched`, `budget-exceeded`, `daemon-died`, `delivery-empty`) or setup error (monitor not found or ambiguous, unknown source, boot failure), so a non-zero exit always means the setup does not currently deliver.

#### Scenario: Unknown monitor id

- **WHEN** `agentmonitors verify does-not-exist` runs
- **THEN** it fails as `setup` and exits 1

### Requirement: verify does not alter runtime timing

`verify` SHALL NOT change runtime notify or debounce timing; it measures delivery under the monitor's real configuration. It complements, and does not replace, `doctor`'s static checks.

#### Scenario: High-urgency settle preserved

- **GIVEN** a `high` monitor
- **WHEN** `verify` runs
- **THEN** delivery happens only after the runtime's normal 15s debounce settle and 15s claim settle
