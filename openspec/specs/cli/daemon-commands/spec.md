# cli/daemon-commands Specification

## Purpose

The `agentmonitors daemon` command surface — `daemon once`, `daemon run` (foreground and
`--detach`), `daemon status`, and `daemon stop` — including arguments, flags, defaults, output, and
exit codes. What a tick does is owned by `runtime/tick-scheduling`; the socket protocol by
`daemon/ipc`; socket and db resolution by `cli/conventions`.

## Requirements

### Requirement: daemon once usage

`agentmonitors daemon once [monitorsDir]` SHALL accept an optional `[monitorsDir]` (default `.claude/monitors`), `--workspace <path>` (default: the process cwd, resolved to an absolute path; used for session projection and per-workspace db resolution), and `--format <text|json>` (default `text`).

#### Scenario: Relative workspace is resolved

- **WHEN** a user runs `agentmonitors daemon once --workspace .`
- **THEN** the tick uses the absolute path of the cwd as its workspace

### Requirement: daemon once runs one in-process tick

`daemon once` SHALL run exactly one runtime tick (per `runtime/tick-scheduling`) in-process against the db resolved per `cli/conventions` (so an enabled workspace's per-workspace db, #335), and MUST NOT contact any daemon socket.

#### Scenario: Writes visible to doctor

- **GIVEN** an enabled workspace
- **WHEN** a user runs `agentmonitors daemon once` and then `agentmonitors doctor`
- **THEN** `doctor` reads the db `daemon once` wrote

### Requirement: daemon once text summary

Text output SHALL be `Evaluated <n> monitor(s), emitted <n> event(s).` When one or more monitors' `observe()` errored, the summary MUST instead end with `, <k> errored:` followed by one `  <monitorId>: <message>` line per errored monitor; with nothing errored the line ends with `.` (#117).

#### Scenario: Clean tick

- **WHEN** a tick evaluates 2 monitors, emits 1 event, and nothing errors
- **THEN** stdout is `Evaluated 2 monitor(s), emitted 1 event(s).`

#### Scenario: Errored monitor is never hidden

- **WHEN** a tick evaluates 2 monitors, emits 0 events, and monitor `api` errored with `boom`
- **THEN** stdout is `Evaluated 2 monitor(s), emitted 0 event(s), 1 errored:` followed by `  api: boom`

### Requirement: daemon once reports monitors not yet due

When monitors were found but skipped because they are not yet due, `daemon once` SHALL append ` (<n> not yet due — next due in <s>s)` to the summary line, where `<s>` is the whole seconds (rounded up) until the soonest-due skipped monitor; the wording MUST stay generic for interval and schedule monitors (#152).

#### Scenario: Second run within the interval

- **GIVEN** `daemon once` just evaluated two 30s-interval monitors
- **WHEN** the user runs `agentmonitors daemon once` again 2 seconds later
- **THEN** the summary ends with `(2 not yet due — next due in 28s)`, distinguishable from "no monitors found"

### Requirement: daemon once JSON output

`--format json` SHALL print the raw tick result `{ "evaluatedMonitors": [<monitorId>], "emittedEventIds": [<eventId>], "erroredObservations": [{ "monitorId", "message" }], "skippedMonitors": [{ "monitorId", "nextDueAt": "<iso8601>" }] }`; errors follow the `cli/conventions` error routing.

#### Scenario: Skipped monitors in JSON

- **WHEN** a monitor is not yet due during `daemon once --format json`
- **THEN** it appears in `skippedMonitors` with an ISO-8601 `nextDueAt`

### Requirement: daemon run usage

`agentmonitors daemon run [monitorsDir]` SHALL accept `[monitorsDir]` (default `.claude/monitors`), `--workspace <path>` (default: the process cwd, resolved absolute), `--poll-ms <ms>` (default `30000`), `--socket <path>`, `--reap-after-ms <ms>` (default `300000`; `0` disables idle reaping), `--detach` (default off), and `--log <path>` (default `<workspace data dir>/daemon.log`).

#### Scenario: Defaults

- **WHEN** a user runs `agentmonitors daemon run` with no flags
- **THEN** it wakes every 30000 ms and reaps after 300000 ms with no active session

### Requirement: daemon run validates its numeric and log flags

`daemon run` SHALL reject a non-positive or non-numeric `--poll-ms` with `--poll-ms must be a positive number.`, a negative or non-numeric `--reap-after-ms` with `--reap-after-ms must be a non-negative number (0 disables).`, and `--log` without `--detach` with `--log only applies with --detach (the foreground daemon already writes to this terminal).`, each on stderr with exit code 1, rather than silently discarding the flag.

#### Scenario: --log without --detach

- **WHEN** a user runs `agentmonitors daemon run --log /tmp/d.log`
- **THEN** stderr carries `Error: --log only applies with --detach (the foreground daemon already writes to this terminal).` and the exit code is 1

#### Scenario: Zero poll interval

- **WHEN** a user runs `agentmonitors daemon run --poll-ms 0`
- **THEN** stderr carries `Error: --poll-ms must be a positive number.` and the exit code is 1

### Requirement: daemon run serves the socket and ticks

`daemon run` SHALL create the Unix domain socket server, serve IPC requests per `daemon/ipc`, and invoke a runtime tick every `--poll-ms`. `--poll-ms` is only the loop-wake cadence; per-monitor observation MUST still be gated by each monitor's schedule or `watch.interval` per `runtime/tick-scheduling`.

#### Scenario: poll-ms is not the observe interval

- **GIVEN** a `file-fingerprint` monitor with no `watch.interval` (30s default; `command-poll` also 30s; `api-poll` 5m)
- **WHEN** the daemon runs with `--poll-ms 5000`
- **THEN** the daemon wakes every 5 s but the monitor is observed at most every 30 s

### Requirement: daemon run binds the workspace socket and db

With no `--socket`, `AGENTMONITORS_DB`, or `AGENTMONITORS_SOCKET` override, `daemon run` SHALL bind the enabled workspace's persisted-or-derived socket and db per `cli/conventions` (#335), so a flagless `daemon run` agrees with `doctor`, `session open`/`list`, and `daemon status`.

#### Scenario: Getting Started usage

- **GIVEN** an enabled workspace
- **WHEN** a user runs `agentmonitors daemon run .claude/monitors`
- **THEN** it binds the workspace's per-workspace socket and db, not the global default

### Requirement: daemon run refuses a second daemon

`daemon run` SHALL refuse to start when a daemon already answers at the resolved socket, reporting `AgentMon daemon is already running at <socketPath>.` on stderr with exit code 1. This check MUST run before `--detach` backgrounds anything.

#### Scenario: Already running

- **GIVEN** a daemon answering at the resolved socket
- **WHEN** a user runs `agentmonitors daemon run --detach`
- **THEN** no child is spawned, stderr carries `Error: AgentMon daemon is already running at <socketPath>.`, and the exit code is 1

### Requirement: daemon run --detach spawns an equivalent background daemon

With `--detach`, `daemon run` SHALL resolve monitors dir, workspace, socket, db, `--poll-ms`, and `--reap-after-ms` exactly as the foreground path does, pass them explicitly to a detached, `unref`'d child running plain `daemon run` (no `--detach`), and append (never truncate) the child's stdout and stderr to `--log`, creating the file if missing (#389).

#### Scenario: Child outlives the shell

- **WHEN** a user runs `agentmonitors daemon run --detach` and closes the terminal
- **THEN** the backgrounded daemon keeps running and `agentmonitors daemon stop` reaches it

### Requirement: daemon run --detach waits for readiness

After spawning, `--detach` SHALL poll the socket until something answers, up to 15 s, racing the poll against the child's spawn `error` event. A synchronous spawn failure (e.g. `ENOENT`) MUST be reported immediately with its real cause; a readiness timeout MUST be reported as `Detached daemon (pid <pid>) did not answer on <socket> within 15s.` plus the cleanup outcome and a pointer to the log; both exit non-zero.

#### Scenario: Spawn failure reported immediately

- **WHEN** the OS cannot start the child process
- **THEN** the error begins `Failed to spawn the detached daemon` with the OS cause, without waiting 15 s, and does not point at the never-written log

### Requirement: daemon run --detach proves daemon identity

Once something answers, `--detach` SHALL compare the `pid` reported by `daemon status` with its spawned child's pid, retrying within the same 15 s window. On a match it reports success. On a mismatch it MUST report the other daemon's pid and actual reap setting (not the requested `--reap-after-ms`), suggest `agentmonitors daemon stop` and retry, and exit non-zero. An unproven identity (status keeps failing or reports no pid) MUST be a failure.

#### Scenario: Lost the startup race

- **GIVEN** a concurrent lazy boot binds the socket first
- **WHEN** `agentmonitors daemon run --detach --reap-after-ms 0` finds a different pid serving
- **THEN** the error names the other daemon's pid and its own reap setting, says the spawned child lost the startup race, suggests `agentmonitors daemon stop`, and the exit code is non-zero

### Requirement: daemon run --detach never orphans its child on failure

Every non-success `--detach` outcome (readiness timeout, spawn error, race loss, unproven identity) SHALL terminate the process that invocation spawned — `SIGTERM`, escalating to `SIGKILL` after a short grace window — and confirm it is gone before returning. Only the spawned pid MUST be signalled; a daemon proven to serve under a different pid is left untouched. The error MUST state whether cleanup succeeded.

#### Scenario: Cleanup outcome is reported

- **WHEN** a `--detach` readiness timeout occurs and the spawned child is terminated
- **THEN** the error includes `The process we spawned (pid <pid>) has been terminated.`

#### Scenario: Cleanup failure is flagged

- **WHEN** the spawned child cannot be terminated
- **THEN** the error includes `WARNING: the process we spawned (pid <pid>) could not be terminated and may still be running — check it before retrying.`

### Requirement: daemon run --detach success output

On success `--detach` SHALL print `AgentMon daemon started in the background.` followed by the pid, socket, and log path, and either `reaping disabled — it runs until \`agentmonitors daemon stop\`.`(for`--reap-after-ms 0`) or `stops after <n>s with no active session; use --reap-after-ms 0 to keep it up.`, then exit 0.

#### Scenario: Persistent background daemon

- **WHEN** a user runs `agentmonitors daemon run --detach --reap-after-ms 0` and the spawned daemon is proven to serve the socket
- **THEN** stdout includes `AgentMon daemon started in the background.`, `pid:`, `socket:`, `log:`, and `reaping disabled`

### Requirement: daemon run signal handling

`SIGINT` and `SIGTERM` SHALL trigger a graceful stop of `daemon run`: the socket is closed and the loop exits.

#### Scenario: Ctrl-C

- **WHEN** a foreground `daemon run` receives `SIGINT`
- **THEN** it closes its socket and exits the loop

### Requirement: daemon run idle reaping

`daemon run` SHALL stop itself after `--reap-after-ms` ms with no active session, with `--reap-after-ms 0` disabling reaping; the idle-window, boot-grace, and channel-heartbeat exemption rules are per the `daemon/ipc` capability ("Idle self-termination").

#### Scenario: Idle daemon stops

- **GIVEN** `daemon run --reap-after-ms 60000` and no active session
- **WHEN** 60000 ms pass with no active session
- **THEN** the daemon stops itself

#### Scenario: Reaping disabled

- **GIVEN** `daemon run --reap-after-ms 0`
- **WHEN** no session is active for any length of time
- **THEN** the daemon keeps running

### Requirement: daemon run per-tick output

When a tick emits events or a monitor errors, `daemon run` SHALL print `Emitted <n> event(s) from <n> monitor(s).`, or, when a monitor's `observe()` errored, that line ending with `, <k> errored:` followed by one `  <monitorId>: <message>` line per errored monitor. A tick that neither emits nor errors MUST print nothing.

#### Scenario: Quiet tick

- **WHEN** a tick emits no events and nothing errors
- **THEN** nothing is printed for that tick

### Requirement: daemon run survives tick failures

A failure of a whole tick (not a single monitor's `observe()`) SHALL be logged to stderr as `AgentMon runtime tick failed: <message>` and MUST NOT stop the loop.

#### Scenario: Tick throws

- **WHEN** a tick fails with `database is locked`
- **THEN** stderr carries `AgentMon runtime tick failed: database is locked` and the next tick still runs

### Requirement: daemon status usage and resolution

`agentmonitors daemon status` SHALL accept `--socket <path>` and `--format <text|json>` (default `text`) and no `--workspace` flag; its socket is resolved workspace-aware via `CLAUDE_PROJECT_DIR` or the cwd per `cli/conventions` (#335). If a `ping` succeeds it queries status over the socket; otherwise it MUST report in-process status from the same per-workspace db `doctor` reads.

#### Scenario: No daemon running

- **GIVEN** no daemon on the resolved socket
- **WHEN** a user runs `agentmonitors daemon status`
- **THEN** it reports `Daemon running: no` with session and event counts from the workspace db, and exits 0

### Requirement: daemon status text output

Text output SHALL print `Daemon running: yes|no`, `Socket: <path>`, `Sessions: <n>`, `Active sessions: <n>`, `Dormant sessions: <n>`, `Events: <n>`, and, only when a live daemon answered, `Pid: <n>` (after `Socket`) and `Reaping: disabled` or `Reaping: stops after <n>s idle` (last).

#### Scenario: Live daemon with reaping disabled

- **GIVEN** a daemon started with `--reap-after-ms 0`
- **WHEN** a user runs `agentmonitors daemon status`
- **THEN** stdout includes `Daemon running: yes`, a `Pid:` line, and `Reaping: disabled`

### Requirement: daemon status JSON output

JSON output SHALL be `{ "running", "socketPath", "pid", "sessions", "activeSessions", "dormantSessions", "events", "reapAfterMs" }`, where `pid` is the answering OS process and `reapAfterMs` the running daemon's `--reap-after-ms` (`0` = disabled) (#389). `pid` and `reapAfterMs` MUST be absent from the in-process fallback.

#### Scenario: Fallback omits live-only fields

- **GIVEN** no daemon running
- **WHEN** a user runs `agentmonitors daemon status --format json`
- **THEN** the object has `"running": false` and no `pid` or `reapAfterMs` keys

### Requirement: daemon stop

`agentmonitors daemon stop [--socket <path>]` SHALL resolve its socket the same workspace-aware way as `daemon status` (#335), send a `stop` request over it, and print `AgentMon daemon stopping.` on success. On any error it MUST report `Error: <message>` on stderr and exit 1.

#### Scenario: Stop a running daemon

- **GIVEN** a daemon running for the enabled workspace in the cwd
- **WHEN** a user runs `agentmonitors daemon stop`
- **THEN** stdout is `AgentMon daemon stopping.` and the daemon exits

#### Scenario: Nothing to stop

- **GIVEN** no daemon on the resolved socket
- **WHEN** a user runs `agentmonitors daemon stop`
- **THEN** stderr carries `Error: ` followed by the connection failure message and the exit code is 1
