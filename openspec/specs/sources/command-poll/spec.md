# sources/command-poll Specification

## Purpose

The bundled `command-poll` observation source (`@agentmonitors/source-command-poll`), the local-process
sibling of `api-poll`: runs a configured argv command on each due tick, captures its result, and reports
change via snapshot-diff strategies, so any CLI-backed system can be monitored purely through
`MONITOR.md` with no domain-specific source code in this repo. The scaffolded recipes built on it
(upstream branch tip, `pr-review` / `my-prs` PR alerting) are specified by `cli/authoring-commands`.

## Requirements

### Requirement: command-poll source registration

The system SHALL register the bundled source under the name `command-poll` from package `@agentmonitors/source-command-poll`, as part of the core source set, with an `agentmonitors init --type command-poll` template per the `cli/authoring-commands` capability (issues #81, #86).

#### Scenario: Scaffolded command-poll monitor validates

- **WHEN** a user runs `agentmonitors init <name> --type command-poll` and then `agentmonitors validate`
- **THEN** the scaffolded monitor passes validation

#### Scenario: Well-formed monitor accepted, missing command rejected

- **WHEN** `agentmonitors validate` runs on a `command-poll` monitor with `command: ['git', 'status']`
- **THEN** it is accepted
- **AND WHEN** it runs on a `command-poll` monitor without `command`
- **THEN** it is rejected

### Requirement: command-poll command is an argv array run without a shell

The scope SHALL require `command`, a non-empty array of strings (`minItems: 1`) whose first element is the executable resolved via `PATH`. The child SHALL be spawned directly with no shell (`shell: false`): no word-splitting, globbing, quoting, or injection surface. A bare-string `command` SHALL be rejected.

#### Scenario: Shell metacharacters pass through literally

- **WHEN** `command: ['echo', '$(whoami); rm -rf /tmp/x']` is executed
- **THEN** stdout contains `$(whoami); rm -rf /tmp/x` verbatim, proving no shell was involved

#### Scenario: Bare-string command is rejected with the sh -c hint

- **WHEN** a monitor declares `command: 'git status -sb | grep ahead'`
- **THEN** parsing throws `scope.command must be a non-empty array of strings (argv form, e.g. ["git", "status"]). A bare string is not run as a shell. For a pipeline or other shell operators, wrap it in argv: ["sh", "-c", "git status -sb | grep ahead"].`

### Requirement: command-poll shell features are explicit opt-in

An author needing a pipeline or shell operator SHALL be able to spawn a shell explicitly in argv form, e.g. `['sh', '-c', 'git status -sb | grep ahead']`, which the source SHALL run verbatim like any other argv; the source SHALL never silently interpose a shell.

#### Scenario: Explicit sh -c argv form is accepted

- **WHEN** a monitor declares `command: ['sh', '-c', 'printf a | tr a b']`
- **THEN** the command runs and its stdout is `b`

### Requirement: command-poll optional scope fields

The scope SHALL accept optional `interval` (duration hint consumed by the scheduling engine, not the plugin), `cwd`, `env` (object of strings, default `{}`), `timeout` (default `30s`, same grammar and bounds as `api-poll`'s `timeout` per the `sources/api-poll` capability), `key` (overrides `objectKey`), `change-detection.strategy` (`text-diff` default, `json-diff`, `exit-code`), and `change-detection.ignore-paths` (default `[]`).

#### Scenario: Defaults applied

- **WHEN** a monitor declares only `command: ['ofocus', 'today', '--json']`
- **THEN** the strategy is `text-diff`, the timeout is 30000ms, `env` adds nothing, and `objectKey` is `ofocus today --json`

#### Scenario: Zero-length timeout rejected

- **WHEN** a monitor declares `timeout: "0s"`
- **THEN** parsing throws `Invalid timeout: "0s". A zero-length timeout is not allowed; specify at least 1 unit (e.g. "1s").`

### Requirement: command-poll cwd resolution

An absolute `cwd` SHALL be used unchanged. For a project monitor, a relative `cwd` SHALL resolve against the runtime workspace/config root, and an omitted `cwd` SHALL default to that root (issue #444, finding 826). For a user-level monitor (no workspace root), an omitted `cwd` SHALL default to the daemon process working directory. The root SHALL be resolved fresh on every tick, never baked into the file.

#### Scenario: Omitted cwd follows a relocated project

- **GIVEN** a project monitor with no `cwd:` whose workspace root is `/a/proj`
- **WHEN** the project moves so the workspace root becomes `/b/proj` with no change to `MONITOR.md` or monitor state
- **THEN** the next execution runs in `/b/proj`

#### Scenario: Relative cwd resolves against the workspace root

- **WHEN** a project monitor at workspace root `/a/proj` declares `cwd: sub`
- **THEN** the command runs in `/a/proj/sub`

#### Scenario: Absolute cwd is unchanged

- **WHEN** a monitor declares `cwd: /opt/tools`
- **THEN** the command runs in `/opt/tools`

### Requirement: command-poll env is merged and never persisted

`env` values SHALL be merged over the inherited daemon environment (no allow-list). `env` values MUST NOT be persisted in any observation `payload`, `snapshot`, or runtime state row. Secrets SHALL reach the command via the daemon's environment, as `api-poll`'s `auth.token-env` does, never inline in `MONITOR.md`.

#### Scenario: env reaches the child but no persisted artifact

- **WHEN** a monitor declares `env: { SECRET_MARKER: 'x9z' }` and its command echoes `$SECRET_MARKER` via `sh -c`
- **THEN** the child sees `SECRET_MARKER=x9z`
- **AND** the `env` config appears in no `payload`, `snapshot`, or `nextState` the source returns

### Requirement: command-poll execution model

The source SHALL execute `command` once per due tick through `observe()` only (no `watch()`), with the resolved `cwd`/`env`, capturing stdout, stderr, and the exit code. The result of an execution SHALL be `(exitCode, stdout)`; a nonzero exit code with output SHALL be a valid result, not a failure.

#### Scenario: Changed nonzero-exit output is reported

- **GIVEN** a baselined monitor whose command last exited `1` with stdout `a`
- **WHEN** the command exits `1` with stdout `b`
- **THEN** one output-changed observation is emitted

### Requirement: command-poll stdout cap with stable truncation

Stdout capture SHALL retain only the leading 1 MiB (1048576 bytes); output beyond it SHALL be discarded and the result marked `truncated: true`. A truncated result SHALL still diff, and because the same leading bytes are retained each time, two truncated captures with identical leading content SHALL NOT report a change.

#### Scenario: Identical leading content diffs as unchanged

- **GIVEN** a baselined capture of 2 MiB whose first 1 MiB is `X`
- **WHEN** the next execution writes 3 MiB whose first 1 MiB is also `X`
- **THEN** `truncated` is `true` and no observation is emitted

### Requirement: command-poll drains excess output without killing the command

Stdout and stderr SHALL be consumed as they stream; bytes past either cap SHALL be read and discarded, never left to back up the pipe. Stderr SHALL be retained independently under a small fixed cap sized to the diagnostic tail. Neither cap SHALL be a kill trigger: the command SHALL run to completion and its real exit code SHALL be reported (issue #302).

#### Scenario: Side effect after a stdout overflow still lands

- **WHEN** a command writes more than 1 MiB to stdout, then writes a marker file, then exits `7`
- **THEN** the marker file exists and the reported exit code is `7`

#### Scenario: Large stderr with small stdout

- **WHEN** a command writes more than 1 MiB to stderr and a small stdout
- **THEN** stdout is captured intact and the real exit code is reported

#### Scenario: Both streams overflow simultaneously

- **WHEN** a command writes past the caps on stdout and stderr at once
- **THEN** both are drained and the real exit code is reported

#### Scenario: Endless writer still resolves promptly

- **WHEN** a command keeps writing far past both caps before exiting
- **THEN** the observation resolves promptly rather than hanging the tick

### Requirement: command-poll timeout terminates the whole process tree

At `timeout` expiry the source SHALL terminate the command's entire process tree (issue #303) using the escalation, grace period, platform mechanics, and lifetime bound owned by the `reliability/process-hygiene` capability, and SHALL classify the execution as a failure per "command-poll execution failure definition".

#### Scenario: Hung child times out as a failure

- **WHEN** `command: ['sleep', '60']` runs with `timeout: 1s`
- **THEN** the execution is a timed-out failure that keeps prior state
- **AND** the child is terminated within the `reliability/process-hygiene` lifetime bound

### Requirement: command-poll resolves on child exit, not stream close

On timeout, resolution SHALL be driven by the direct child's own `exit` event, never by waiting for stdio streams to close, since a descendant that inherited the pipes can hold them open indefinitely. For ordinary completions a bounded 2s fallback SHALL apply the same principle, so no command can hang the call.

#### Scenario: Descendant holding stdout does not hang a timed-out observation

- **WHEN** a timed-out command's backgrounded descendant keeps stdout open
- **THEN** `observe()` still resolves once the direct child exits

### Requirement: command-poll change-detection strategies

The system SHALL support `text-diff` (default; raw stdout strings), `json-diff` (stdout parsed as JSON, key-order and whitespace insensitive, the same algorithm as `api-poll`, falling back to raw text when either side fails to parse), and `exit-code` (exit codes only; stdout changes ignored). Stderr SHALL never be diffed.

#### Scenario: exit-code ignores stdout-only changes

- **GIVEN** an `exit-code` monitor baselined on exit `0` with stdout `a`
- **WHEN** the command exits `0` with stdout `b`
- **THEN** no observation is emitted

#### Scenario: json-diff ignores key reordering

- **GIVEN** a `json-diff` monitor baselined on `{"a":1,"b":2}`
- **WHEN** stdout becomes `{"b":2,"a":1}`
- **THEN** no observation is emitted

#### Scenario: Each strategy emits exactly one observation on a real change

- **WHEN** a baselined monitor's watched value changes under `text-diff`, `json-diff`, or `exit-code`
- **THEN** exactly one observation is emitted

### Requirement: command-poll records its strategy on the snapshot

The source SHALL set `snapshot.strategy` to its strategy so that `json-diff` selects the runtime's structural `diffText` renderer (issue #437) per the `runtime/event-materialization` capability.

#### Scenario: Compact gh JSON no longer diffs as remove-all/add-all

- **WHEN** a `json-diff` monitor over `gh pr list --json` single-line output sees one array element change
- **THEN** the delivered `diffText` names that element's change rather than replacing the whole line

### Requirement: command-poll ignore-paths for plain json-diff

Plain `json-diff` MAY set top-level `change-detection.ignore-paths` to remove fields before comparison, using the minimal dotted grammar of keyed-collection ignore paths (`$.field` or bare `field`; no wildcards, array indices, filters, or recursive descent). It SHALL be valid only with `strategy: json-diff` (`change-detection.ignore-paths requires strategy: json-diff`); unknown `change-detection` keys SHALL be validation errors.

#### Scenario: Ignored field does not fire, stable field still does

- **GIVEN** a `json-diff` monitor with `ignore-paths: ['duration']` baselined on `{"duration":5,"status":"ok"}`
- **WHEN** stdout becomes `{"duration":9,"status":"ok"}`
- **THEN** no observation is emitted
- **AND WHEN** stdout becomes `{"duration":9,"status":"fail"}`
- **THEN** one observation is emitted

#### Scenario: ignore-paths without json-diff is rejected

- **WHEN** a monitor sets `ignore-paths: ['$.duration']` with `strategy: text-diff`
- **THEN** parsing throws `change-detection.ignore-paths requires strategy: json-diff`

#### Scenario: Unsupported path segment rejected

- **WHEN** `ignore-paths: ['items[0]']` is configured and a comparison runs
- **THEN** the source rejects it with `Invalid change-detection.ignore-paths entry "items[0]": unsupported path segment "items[0]"`

#### Scenario: Misspelled change-detection key rejected

- **WHEN** `agentmonitors validate` runs on a `command-poll` monitor with `change-detection: { strategy: json-diff, ignore-path: ['x'] }`
- **THEN** validation fails on the unknown key

### Requirement: command-poll observation identity

An output-changed observation SHALL carry `title` and `summary` `Command output changed: <objectKey>` (objectKey bounded per the `sources/contract` capability); `objectKey` equal to `key` if set, otherwise the argv joined with single spaces; `payload` `{ command, exitCode, strategy, stdout, truncated }` (never `env`); `snapshotText` the captured stdout; `queryScope` `{ command: <objectKey> }`; `snapshot` `{ command, exitCode, stdoutLength, strategy }`; and `changeKind` `modified`.

#### Scenario: Default objectKey is the joined argv

- **WHEN** `command: ['ofocus', 'today', '--json']` with no `key` changes output
- **THEN** `objectKey` is `ofocus today --json` and `title` is `Command output changed: ofocus today --json`

#### Scenario: key overrides objectKey

- **WHEN** the monitor sets `key: ofocus-today`
- **THEN** `objectKey` and `queryScope.command` are `ofocus-today`

#### Scenario: Authored name overrides the source title

- **WHEN** the monitor declares a `name`
- **THEN** that name is the delivered title per the `runtime/event-materialization` capability and `summary` stays `Command output changed: <objectKey>`

### Requirement: command-poll stateful baseline

The source SHALL declare `stateful: true` (PP6). The first successful execution SHALL store `{ stdout, exitCode }` (with health state) as `nextState` and emit nothing; subsequent executions SHALL diff against `context.previousState` under the configured strategy.

#### Scenario: Baseline run emits nothing

- **WHEN** a `command-poll` monitor executes successfully for the first time
- **THEN** no observation is emitted and the result is stored as `nextState`

### Requirement: command-poll execution failure definition

An execution failure SHALL be an execution that produces no result: a spawn failure (`ENOENT`, `EACCES`, …), `timeout` expiry, or termination of the command by a signal the source did not send. On failure the source SHALL keep prior state (no re-baseline, no state loss).

#### Scenario: Spawn failure keeps the baseline

- **GIVEN** a baselined monitor
- **WHEN** the executable is removed from `PATH` so spawn fails with `ENOENT`
- **THEN** the stored output baseline is unchanged

#### Scenario: Self-signalled command is a failure, not a result

- **WHEN** a command terminates itself with `kill -TERM $$`
- **THEN** the execution is classified as a failure with error `Command terminated by signal SIGTERM`

### Requirement: command-poll reports health only on transition edges

The source SHALL track `health: 'ok' | 'failing'` in its state and emit observations only on edges: on `ok → failing` (or a failing first run) one observation titled `Command failing: <objectKey>` with `payload` `{ command, error, stderrTail }`; nothing on subsequent failing ticks; on `failing → ok` one observation titled `Command recovered: <objectKey>`.

#### Scenario: Three hours of downtime yields exactly two signals

- **GIVEN** a 5-minute monitor whose backing tool is unavailable for three hours
- **THEN** exactly one `Command failing: <objectKey>` and, on return, one `Command recovered: <objectKey>` observation are emitted, not 36 failure events

#### Scenario: Timeout follows the same edge semantics

- **WHEN** a command times out on three consecutive ticks and then succeeds
- **THEN** one failing observation is emitted on the first tick, none on the next two, and one recovered observation on the success

### Requirement: command-poll recovery also reports a missed output change

When a `failing → ok` recovery result differs from the pre-failure baseline under the configured strategy, the source SHALL emit the ordinary output-changed observation as well as the recovered observation (two observations on that tick).

#### Scenario: Output changed while the tool was down

- **GIVEN** a monitor baselined on stdout `a` that then fails for several ticks
- **WHEN** it recovers with stdout `b`
- **THEN** both `Command recovered: <objectKey>` and `Command output changed: <objectKey>` are emitted on that tick

### Requirement: command-poll failing first run establishes no baseline

A failing first run SHALL establish no output baseline; the first successful run after it SHALL baseline silently as usual (after emitting the recovered edge).

#### Scenario: First successful run after an initial failure

- **WHEN** the first-ever execution fails and the next succeeds with stdout `a`
- **THEN** the first tick emits `Command failing: <objectKey>`, the second emits `Command recovered: <objectKey>` and no output-changed observation, and `a` becomes the baseline

### Requirement: command-poll executes without interactive acknowledgment

`command-poll` SHALL execute configured commands without an interactive acknowledgment step: `MONITOR.md` is workspace-resident configuration in the same trust class as `package.json` scripts, git hooks, or `.claude` hooks, and the daemon already scopes evaluation to its workspace.

#### Scenario: New monitor runs on its first due tick

- **WHEN** a new `command-poll` monitor is added to the workspace
- **THEN** its command executes on the first due tick without any approval prompt

### Requirement: command-poll scope boundary

The source SHALL provide `observe()` per tick only, with no `watch()` (no long-lived `--watch`-style child), no mtime/file-based pre-gate, and no monitor chaining as a polling optimization (PP3). Domain-specific integrations (OmniFocus, git, gh, …) SHALL be `MONITOR.md` consumers of `command-poll`, not source code in this repo.

#### Scenario: No watch mode

- **WHEN** the runtime inspects the `command-poll` source
- **THEN** it exposes `observe()` and no `watch()` implementation
