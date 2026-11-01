# cli/doctor Specification

## Purpose

The `agentmonitors doctor` command: a read-only, one-command workspace health check that answers
"is my monitoring working, and if not, where is it broken?" and "what is the listening method for
this workspace, and is it healthy right now?". It owns the command's flags, data source, ordered
checks, delivery-transport section, per-monitor rollup, output shapes, and exit codes; heartbeat and
transport-health semantics are owned by the `delivery/transport-health` capability.

## Requirements

### Requirement: doctor flags

`agentmonitors doctor` SHALL accept `--dir <path>` (default `<workspace>/.claude/monitors`), `--workspace <path>` (default: current working directory, resolved to an absolute path; selects session projection and event scoping), `--socket <path>` (default: resolved; used for the `doctor.report` RPC), and `--format <format>` (choices `text`, `json`; default `text`).

#### Scenario: Default monitors directory

- **WHEN** `agentmonitors doctor --workspace ./repo` runs from `/home/u`
- **THEN** the report's `workspace` is `/home/u/repo` and `monitorsDir` is `/home/u/repo/.claude/monitors`

### Requirement: doctor only diagnoses

`doctor` SHALL never mutate state: it has no `--fix`, never removes or rewrites transport heartbeat records it reads (registry reads never reap, per the `delivery/transport-health` capability), does not check host-plugin installation, and does not change `monitor explain`.

#### Scenario: Expired heartbeat is reported, not reaped

- **GIVEN** a transport heartbeat record expired past its own TTL and no transport writing heartbeats
- **WHEN** `doctor` runs twice in a row
- **THEN** both runs report `heartbeat-stale` for that transport
- **AND** the record is still present after both runs

### Requirement: doctor resolves the same db and socket as the daemon

`doctor` SHALL resolve the workspace's db and socket the way `daemon run`/`daemon once` resolve them for binding: `AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` first, then an enabled workspace's persisted `db:`/`socket:` in `.claude/agentmonitors.local.md` or the derived per-workspace paths, then the global defaults, per the `cli/conventions` capability (#335).

#### Scenario: Directly started workspace daemon is found

- **GIVEN** an enabled workspace and a daemon started with `agentmonitors daemon run` and no overrides
- **WHEN** `agentmonitors doctor` runs from the workspace with no `--socket`
- **THEN** `daemon-reachable` passes against that daemon's socket

### Requirement: doctor prefers the live daemon's report

`doctor` SHALL request its report via the `doctor.report` RPC when a daemon is reachable and SHALL read the persisted SQLite store in-process only when the daemon is unreachable or answers that it does not understand the request. Rationale: a fresh reader connection can lag a live writer's WAL commits, freezing the rollup at a stale snapshot (#373).

#### Scenario: Rollup current after a live delivery

- **GIVEN** a running daemon that has just materialized and delivered an event
- **WHEN** `doctor --format json` runs
- **THEN** the monitor's `lastEventAt` and `delivery` counts match what `events list` reports from the same daemon

### Requirement: doctor falls back precisely on version skew

`doctor` SHALL treat a daemon reply equal to the legacy unparseable-request sentinel `{ id: "invalid", error: "Invalid JSON request." }` (optionally with `code: "unsupported_request"`) as unsupported and fall back in-process exactly as for an unreachable daemon (#382). It SHALL match the sentinel precisely, never by substring, so a genuine daemon-side application error surfaces as a command error.

#### Scenario: Older daemon without doctor.report

- **GIVEN** a running daemon build that predates `doctor.report`
- **WHEN** `doctor` runs
- **THEN** it produces a report from the persisted store instead of crashing on the sentinel text
- **AND** `daemon-reachable` detail names the version-skewed, unsupported-request rejection

#### Scenario: Application error is not masked

- **GIVEN** a daemon that returns an application error message containing the words "Invalid JSON"
- **WHEN** `doctor` runs
- **THEN** the error is reported as a command error, not as a down daemon

### Requirement: daemon-reachable derives from the report call

The `daemon-reachable` check's pass/fail SHALL be derived from whether the `doctor.report` call itself reached the daemon, not from a separate ping, so the check and the report source never disagree.

#### Scenario: Report served by daemon

- **WHEN** `doctor.report` succeeds over the socket
- **THEN** `daemon-reachable` is `pass` and JSON `daemon.running` is `true`

### Requirement: doctor check statuses

Each check SHALL have status `pass` (`✓`), `fail` (`✗`), `skip` (`○`), or `idle` (`◇`), printed one line per check, with an actionable remediation on `fail` and `idle`. `idle` SHALL mean the check legitimately does not apply right now, not a problem.

#### Scenario: Idle line carries remediation

- **GIVEN** no lead session is registered
- **WHEN** `doctor` runs in text format
- **THEN** the `lead-session` line shows `◇` followed by an indented `↳` remediation line

### Requirement: doctor check order

`checks[]` SHALL always appear in this order: `project-enabled`, `monitors-directory`, `monitors-valid`, `daemon-reachable`, `lead-session`, one `monitor:<id>` per discovered monitor, then `transport:hook`, `transport:channel`, `delivery-verdict`.

#### Scenario: Two monitors

- **GIVEN** monitors `a` and `b`
- **WHEN** `doctor --format json` runs
- **THEN** the check names are `project-enabled`, `monitors-directory`, `monitors-valid`, `daemon-reachable`, `lead-session`, `monitor:a`, `monitor:b`, `transport:hook`, `transport:channel`, `delivery-verdict` in that order

### Requirement: project-enabled check

`project-enabled` SHALL pass when `.claude/agentmonitors.local.md` has `enabled: true`, and otherwise fail with the remediation to run `agentmonitors init --enable-only` or create that file with `enabled: true` — the same enable step the `SessionStart` monitors-found-but-disabled advisory names.

#### Scenario: Workspace not enabled

- **GIVEN** no `.claude/agentmonitors.local.md`
- **WHEN** `doctor` runs
- **THEN** `project-enabled` is `fail` and its remediation names `agentmonitors init --enable-only`

### Requirement: monitors-directory check

`monitors-directory` SHALL pass when the monitors directory exists, and otherwise fail with the remediation to create the directory and scaffold a monitor with `agentmonitors init`.

#### Scenario: Missing monitors directory

- **GIVEN** `<workspace>/.claude/monitors` does not exist
- **WHEN** `doctor` runs
- **THEN** `monitors-directory` is `fail` and its remediation names `agentmonitors init`

### Requirement: monitors-valid check

`monitors-valid` SHALL pass when every discovered monitor validates (no scope, parse, or duplicate-id errors), SHALL be `skip` when there are no monitors, and otherwise SHALL fail listing each failing id once with the remediation `agentmonitors validate <dir>`.

#### Scenario: Monitor failing two ways

- **GIVEN** monitor `x` has both an invalid scope and a duplicate id
- **WHEN** `doctor` runs
- **THEN** `monitors-valid` is `fail` and its detail counts and lists `x` exactly once

#### Scenario: No monitors

- **GIVEN** an existing but empty monitors directory
- **WHEN** `doctor` runs
- **THEN** `monitors-valid` is `skip`

#### Scenario: Invalid schedule timezone (issue #297)

- **GIVEN** a `schedule` monitor with `timezone: Not/AZone` and a healthy sibling monitor
- **WHEN** `doctor --format json` runs
- **THEN** it does not crash, `monitors-valid` is `fail` listing the invalid monitor, and that monitor's `monitors[]` entry has `valid: false` with a `validationError` naming `Not/AZone`
- **AND** the sibling's entry has `valid: true` and `validationError` `null`

### Requirement: daemon-reachable status

`daemon-reachable` SHALL be `pass` when the report reached a daemon; `idle` when it did not and no active lead session is registered (detail says this is expected when no agent session is open); and `fail` when it did not but an active lead session IS registered, with detail naming that lead session (#382). The remediation SHALL name `agentmonitors daemon run` or letting a Claude Code session start it.

#### Scenario: Daemon down with an open lead session

- **GIVEN** an active lead session registered for the workspace and no reachable daemon
- **WHEN** `doctor` runs
- **THEN** `daemon-reachable` is `fail`, its detail does not use the "expected when no agent session is currently open" wording, and the exit code is non-zero

#### Scenario: Daemon down with no session

- **GIVEN** no lead session and no reachable daemon
- **WHEN** `doctor` runs
- **THEN** `daemon-reachable` is `idle` and the exit code is 0 if nothing else fails

### Requirement: daemon-reachable explains why the daemon looks down

When the underlying connection error is available, `daemon-reachable` detail SHALL distinguish a timeout (daemon present but not answering), no daemon process, and a version-skewed daemon that rejected the request as unsupported.

#### Scenario: Timeout

- **GIVEN** a daemon that accepts the connection but does not answer in time
- **WHEN** `doctor` runs
- **THEN** the `daemon-reachable` detail carries the timeout cause rather than a generic "not running"

### Requirement: Down daemon does not stop the diagnosis

With an unreachable daemon, `doctor` SHALL still produce every check and the per-monitor rollup from the in-process fallback, and the `daemon-reachable` line SHALL say explicitly that no daemon is reachable.

#### Scenario: Rollup without a daemon

- **GIVEN** a prior `daemon once` tick and no running daemon
- **WHEN** `doctor --format json` runs
- **THEN** `monitors[]` contains each monitor with its last persisted `lastObservedAt`

### Requirement: lead-session check

`lead-session` SHALL pass when an active lead session is registered for the workspace and otherwise be `idle` (never `fail`), with detail "expected when no agent session is currently open". Detail and remediation SHALL name the exact workspace path searched (#335), and the remediation SHALL recommend `agentmonitors session start` (piping a hook payload by hand), not `session open` (#387).

#### Scenario: Manual remediation command

- **GIVEN** no lead session for workspace `/repo`
- **WHEN** `doctor` runs
- **THEN** the remediation includes `echo '{"session_id":"manual-cli-session","cwd":"/repo"}' | agentmonitors session start`
- **AND** does not recommend `agentmonitors session open`

### Requirement: doctor counts only active lead sessions

Every `doctor` gate that depends on a lead session — `lead-session`, the `daemon-reachable` idle/fail split, the transport checks, the per-monitor delivery counts, JSON `leadSession`, and the delivery-diagnosis fetch — SHALL use the same set of ACTIVE lead sessions, per the `delivery/transport-health` capability; a dormant (closed) session SHALL count as no lead session.

#### Scenario: Closed session only

- **GIVEN** the workspace's only lead session was closed with `session close`
- **WHEN** `doctor --format json` runs
- **THEN** `leadSession` is `false`, `lead-session` is `idle`, and the exit code is 0 if nothing else fails

### Requirement: monitor check

Each `monitor:<id>` check SHALL embed the per-monitor rollup and be `skip` for an invalid monitor (pointing at `monitors-valid`), `fail` for a valid monitor never observed (remediation: start the daemon or wait for the next tick, then check `agentmonitors monitor history <id>`; `monitor test` dry-runs it), and otherwise `pass`.

#### Scenario: Never observed

- **GIVEN** a valid monitor `m` with no observation history
- **WHEN** `doctor` runs
- **THEN** `monitor:m` is `fail` with `never observed` in its detail and a remediation naming `agentmonitors monitor history m`

### Requirement: transport check status

`transport:<name>` (`hook`, `channel`) SHALL pass when the transport is within its heartbeat lease and bound to this workspace's daemon. It SHALL be `fail` only when the transport reported in, is broken by a blocking code, and an active lead session is registered; `idle` when a lead is open but it never reported in, or when no lead is open even if it reported in; `skip` when it never reported in and no lead is open.

#### Scenario: Lead open, transport not yet reported

- **GIVEN** an active lead session and no hook heartbeat yet
- **WHEN** `doctor` runs
- **THEN** `transport:hook` is `idle`, not `fail`

#### Scenario: Leftover misbound heartbeat with no session

- **GIVEN** a channel heartbeat bound to another workspace and no lead session
- **WHEN** `doctor` runs
- **THEN** `transport:channel` is `idle` and the exit code is 0 if nothing else fails

### Requirement: Idle transport checks name a next step

Every `idle` transport check, configured or not, SHALL carry a non-null `remediation` naming a concrete next step; per-problem remediations SHALL re-resolve the workspace or respawn the transport as each problem code requires.

#### Scenario: Unconfigured idle transport

- **GIVEN** an active lead session and no channel heartbeat
- **WHEN** `doctor --format json` runs
- **THEN** the `transport:channel` check's `remediation` is a non-empty string

### Requirement: delivery-verdict check

`delivery-verdict` SHALL pass when some transport is listening and delivery is not currently blocked; SHALL fail naming the specific blocker (a down daemon, a misbound transport, or a legacy `already-claimed` / `coalesced-until-ack` suppression reported by an older daemon); and SHALL be `idle` when no lead session or no transport has reported in.

#### Scenario: Legacy muted reminders from an older daemon

- **GIVEN** a healthy hook transport and an older daemon reporting a `coalesced-until-ack` hold
- **WHEN** `doctor` runs
- **THEN** `delivery-verdict` is `fail` and names the `coalesced-until-ack` suppression

#### Scenario: Claimed backlog is not a delivery failure

- **GIVEN** a healthy hook transport and a lead whose unread normal events are all claimed, reported as `no-new-work`
- **WHEN** `doctor` runs
- **THEN** `delivery-verdict` does not fail on that account and no `reminders-suppressed` problem is reported

### Requirement: Suppression remediation is a scoped acknowledgement

The `reminders-suppressed` remediation SHALL be `agentmonitors events ack --session <id> --event-ids <id1,id2,...> --socket <path>`, naming the exact claimed event ids a legacy suppressing hold reports and the socket this run resolved; it SHALL NEVER be a bare `--session <id>` acknowledgement without `--event-ids`.

#### Scenario: Two claimed events hold the reminder

- **GIVEN** claimed unacknowledged events `e1`, `e2` suppressing session `s1`'s reminder and resolved socket `/w/a.sock`
- **WHEN** `doctor` runs
- **THEN** the remediation is `agentmonitors events ack --session s1 --event-ids e1,e2 --socket /w/a.sock`

### Requirement: doctor exit code

`doctor` SHALL exit 0 when every check is `pass`, `skip`, or `idle`, and non-zero when any check is `fail` (#373, #382).

#### Scenario: Idle-only report

- **GIVEN** an enabled workspace with valid, observed monitors, no daemon, and no lead session
- **WHEN** `doctor` runs
- **THEN** the exit code is 0

### Requirement: Delivery transports section reports each cause distinctly

`doctor` SHALL print a Delivery transports section above the checks, built from transport heartbeats per the `delivery/transport-health` capability, reporting each cause with its own problem code and remediation, never a generic "unhealthy". Blocking codes: `daemon-unreachable`, `workspace-mismatch`, `socket-mismatch`, `environment-mismatch`, `reminders-suppressed`, `heartbeat-stale`, `channel-session-unmatched`, `channel-lead-uncovered`, `hook-lead-uncovered`, `delivery-diagnosis-unavailable`.

#### Scenario: Workspace mismatch

- **GIVEN** this session's channel transport is bound to a different workspace than the monitors
- **WHEN** `doctor` runs
- **THEN** the channel transport reports `workspace-mismatch`, distinct from `socket-mismatch`

#### Scenario: Environment mismatch

- **GIVEN** the hook transport resolved a different `HOME`/data root
- **WHEN** `doctor` runs
- **THEN** the hook transport reports `environment-mismatch`

#### Scenario: Lapsed lease

- **GIVEN** a transport whose heartbeat lease lapsed
- **WHEN** `doctor` runs
- **THEN** it reports `heartbeat-stale`

#### Scenario: Uncovered lead sessions

- **GIVEN** two active lead sessions and a channel heartbeat for only one
- **WHEN** `doctor` runs
- **THEN** the channel reports `channel-lead-uncovered` naming the uncovered lead

### Requirement: Advisory transport codes are non-blocking

`version-skew` (a long-lived transport serving an older CLI build) and `channel-registration-unverified` (the host never confirms channel registration; prove delivery end to end) SHALL be reported when present but SHALL NOT count toward a transport's `healthy`, its `fail` status, or `deliverable`. Rationale: the hook heartbeat legitimately carries the pre-upgrade version for up to its 24h TTL.

#### Scenario: Just upgraded CLI

- **GIVEN** a hook heartbeat reporting the previous CLI version and otherwise healthy
- **WHEN** `doctor` runs
- **THEN** `version-skew` is reported, `healthy` is `true`, and the exit code is 0 if nothing else fails

### Requirement: Pipeline-wide problems

`daemon-unreachable`, `reminders-suppressed`, and `delivery-diagnosis-unavailable` are pipeline-wide. JSON SHALL list each once in top-level `pipelineProblems[]` (present even when no transport is configured) and again in `problems[]` of every configured transport. Text output SHALL render them once, below the transport rows, not per row.

#### Scenario: No transport configured, daemon down

- **GIVEN** no transport heartbeat and no reachable daemon
- **WHEN** `doctor --format json` runs
- **THEN** `pipelineProblems` contains `daemon-unreachable` while both `transports[].problems` are empty

#### Scenario: Both transports configured

- **GIVEN** both transports reported in and an older daemon reports a legacy suppressing hold
- **WHEN** `doctor --format json` runs
- **THEN** `reminders-suppressed` appears once in `pipelineProblems` and once in each transport's `problems`
- **AND** text output prints it once

### Requirement: Unknown suppression state is never healthy

`doctor` SHALL report `delivery-diagnosis-unavailable` whenever the transport-health verdict yields it — a failed `hook.diagnose` for any lead session, or an untrustworthy suppressing hold, with both trigger rules per the `delivery/transport-health` capability — and SHALL treat it as blocking: `deliverable` SHALL NOT be `true` while it is present.

#### Scenario: Older daemon rejects hook.diagnose

- **GIVEN** a daemon that rejects `hook.diagnose` as unsupported
- **WHEN** `doctor` runs with an active lead session
- **THEN** `delivery-diagnosis-unavailable` is reported and `deliverable` is `false`

#### Scenario: Empty claimedEventIds

- **GIVEN** a `coalesced-until-ack` hold whose `claimedEventIds` is `[]`
- **WHEN** `doctor` runs
- **THEN** it reports `delivery-diagnosis-unavailable`
- **AND** no remediation contains `events ack --session <id>` without `--event-ids` or with a blank `--event-ids`

### Requirement: Delivery verdict line

The Delivery transports section SHALL close with one verdict line `delivery to active sessions in this workspace → via {hook | channel | both | none}` plus whether delivery is possible right now. The verdict is workspace-scoped, and the listening method SHALL be reported separately from deliverability.

#### Scenario: Listening but muted

- **GIVEN** a healthy hook transport whose reminders an older daemon reports as suppressed (`coalesced-until-ack`)
- **WHEN** `doctor --format json` runs
- **THEN** `deliveryWillReachThisSession` is `hook` and `deliverable` is `false`

### Requirement: Per-monitor rollup

For each monitor `doctor` SHALL report id, source type, urgency, cadence (the cron expression for `schedule` sources, else the observe interval), last-observed time or `never`, next-due time, last-event time or `none`, and the unread / claimed / acknowledged counts for the workspace's lead session (distinct states, SP4), or an explicit `never observed` / `lead-session=none` marker.

#### Scenario: Schedule cadence

- **GIVEN** a `schedule` monitor with cron `0 9 * * 1`
- **WHEN** `doctor --format json` runs
- **THEN** that monitor's `cadence` is `0 9 * * 1`

#### Scenario: No lead session

- **GIVEN** no active lead session
- **WHEN** `doctor --format json` runs
- **THEN** every monitor's `delivery` is `{ "unread": 0, "claimed": 0, "acknowledged": 0 }` and text output shows `lead-session=none`

### Requirement: doctor text output

Text output SHALL print a workspace/monitors/daemon header, the Delivery transports section, one line per check with an indented `↳` remediation line where a remediation exists, and a closing `Summary: <n> passed, <n> failed, <n> skipped, <n> idle.` line.

#### Scenario: Summary line

- **GIVEN** 6 passing, 1 failing, 1 skipped, and 2 idle checks
- **WHEN** `doctor` runs in text format
- **THEN** the last line is `Summary: 6 passed, 1 failed, 1 skipped, 2 idle.`

### Requirement: doctor JSON top-level shape

`--format json` SHALL emit an object with `ok` (true iff no check failed), `generatedAt`, `workspace`, `monitorsDir`, `daemon` (`running`, `socketPath`), `leadSession`, `transports`, `pipelineProblems`, `deliveryWillReachThisSession` (`hook|channel|both|none`), `deliverable`, `verdict`, `remediation` (string array), `checks`, `monitors`, and `summary` (`passed`, `failed`, `skipped`, `idle`). Dates SHALL be ISO-8601 strings or `null`.

#### Scenario: Failing report

- **GIVEN** any check is `fail`
- **WHEN** `doctor --format json` runs
- **THEN** `ok` is `false` and `summary.failed` is at least 1

### Requirement: doctor JSON check and monitor entries

Each `checks[]` entry SHALL have `name`, `status` (`pass|fail|skip|idle`), `detail`, and `remediation` (string or `null`). Each `monitors[]` entry SHALL have `id`, `sourceType`, `urgency`, `valid`, `validationError`, `lastObservedAt`, `neverObserved`, `nextDueAt`, `cadence`, `lastEventAt`, and `delivery` (`unread`, `claimed`, `acknowledged`).

#### Scenario: Passing check has null remediation

- **WHEN** `project-enabled` passes
- **THEN** its JSON entry's `remediation` is `null`

### Requirement: doctor JSON transport entries

`transports[]` SHALL always contain exactly two entries, `hook` then `channel`, present with `configured: false` when a transport never reported in. Each SHALL have `name`, `configured`, `running`, `healthy`, `boundTo` (`workspacePath`, `socketPath`, `home`, `dataRoot`, `pid`, `cliPath`, optional `hostSessionId`), `version`, `lastDelivery`, and `problems[]` of `{ code, detail, remediation }`.

#### Scenario: Nothing reported in

- **GIVEN** no transport heartbeats
- **WHEN** `doctor --format json` runs
- **THEN** `transports` is `[{ "name": "hook", "configured": false, … }, { "name": "channel", "configured": false, … }]`

### Requirement: Channel entry covers every matching session

The `channel` entry SHALL derive from every heartbeat matching an active lead session of the workspace: problems from every matching record SHALL be unioned and prefixed with their host session id, with the representative `boundTo`/`version` chosen per the `delivery/transport-health` capability. A workspace channel record matching no active lead SHALL be `configured: true` with `channel-session-unmatched` and never count toward `deliveryWillReachThisSession`.

#### Scenario: One healthy and one misbound channel

- **GIVEN** two active leads, one with a healthy channel and one with a channel bound to another workspace
- **WHEN** `doctor --format json` runs
- **THEN** the channel entry's `problems` include `workspace-mismatch` prefixed with the broken session's host session id

#### Scenario: Somebody else's listener

- **GIVEN** a channel heartbeat for this workspace whose host session matches no active lead
- **WHEN** `doctor --format json` runs
- **THEN** the channel entry has `configured: true` and `channel-session-unmatched`, and `deliveryWillReachThisSession` is not `channel`

### Requirement: doctor errors

Command errors such as an unreadable store SHALL use the standard error shape — `{ "error": "..." }` on stdout in JSON mode, `Error: …` on stderr otherwise — and exit 1.

#### Scenario: Unreadable store in JSON mode

- **GIVEN** the resolved db file cannot be read
- **WHEN** `doctor --format json` runs with no reachable daemon
- **THEN** stdout is `{ "error": "<message>" }` and the exit code is 1
