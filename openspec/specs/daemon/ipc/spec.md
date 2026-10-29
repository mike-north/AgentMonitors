# daemon/ipc Specification

## Purpose

Defines the long-running daemon and its local Unix-socket IPC: single-tick versus continuous modes, idle self-termination, per-workspace daemon isolation and lazy boot, socket path resolution, the newline-delimited JSON wire protocol, the exposed socket methods, and the read-only monitor pipeline diagnosis served over the socket. CLI flags and output text for `daemon` commands are owned by the `cli/daemon-commands` capability.

## Requirements

### Requirement: Single-tick mode runs in process without a socket

`agentmonitors daemon once [monitorsDir]` SHALL create a local `AgentMonitorRuntime` in-process and run exactly one tick. It SHALL NOT start a socket server and SHALL NOT contact the daemon IPC socket. Its output (including errored-observation lines) is defined by the `cli/daemon-commands` capability.

#### Scenario: daemon once does not start a socket server

- **GIVEN** no daemon is running for the workspace
- **WHEN** `agentmonitors daemon once` runs
- **THEN** one tick is evaluated against the workspace database
- **AND** no socket file is created and no IPC request is sent

### Requirement: Continuous daemon mode

`agentmonitors daemon run [monitorsDir]` SHALL create a local `AgentMonitorRuntime`, start a Unix domain socket server (socket, its directory, and the startup-lock directory owner-only, per the `runtime/local-data-permissions` capability), then loop calling one tick per iteration, sleeping `--poll-ms` milliseconds (default `30000`) between ticks on a cancellable timer, and SHALL stop cleanly on `SIGINT` or `SIGTERM`.

#### Scenario: SIGTERM stops the loop during a sleep

- **GIVEN** `daemon run` is sleeping between ticks with `--poll-ms 30000`
- **WHEN** the process receives `SIGTERM`
- **THEN** the sleep is cancelled, the socket is closed, and the process exits cleanly without waiting out the interval

### Requirement: Daemon refuses to start on a socket already in use

`daemon run` SHALL refuse to start when another daemon is already listening on its resolved socket path.

#### Scenario: Second daemon on the same socket is refused

- **GIVEN** a daemon is listening on socket `P`
- **WHEN** a second `daemon run` resolves to socket `P`
- **THEN** it exits with an error and does not bind or tick

### Requirement: Daemon tick logging is owned by the CLI surface

After each tick, `daemon run` SHALL log a summary line only when the tick emitted events or had errored observations, using the same errored-monitor surfacing as `daemon once`; a clean no-change tick SHALL log nothing. The exact text is defined by the `cli/daemon-commands` capability.

#### Scenario: Clean tick is silent

- **WHEN** a tick emits no events and has no errored observations
- **THEN** `daemon run` prints nothing for that tick

### Requirement: Idle self-termination

After each tick the daemon SHALL count sessions with `status` `active` whose `workspacePath` equals its workspace. If that count stays zero continuously for `--reap-after-ms` milliseconds (default `300000`; `0` disables reaping), the daemon SHALL stop itself cleanly. Before any session has been seen, the idle window SHALL be `max(reapAfterMs, bootGraceMs)`.

#### Scenario: Daemon stops after the idle window

- **GIVEN** `daemon run --reap-after-ms 300000` whose only session has gone dormant
- **WHEN** no active session exists for the workspace for 300000 ms
- **THEN** the daemon stops cleanly

#### Scenario: Reaping disabled

- **GIVEN** `daemon run --reap-after-ms 0`
- **WHEN** no session is active for any length of time
- **THEN** the daemon keeps running

### Requirement: Live channel heartbeat defers idle reaping

The reaper SHALL treat its workspace as active, resetting the idle clock, whenever a non-stale `channel` transport heartbeat exists whose `workspacePath` equals the daemon's workspace and whose socket equals the daemon's own `socketPath`. Staleness SHALL be re-evaluated against `now` and the heartbeat's TTL lease on every check (lease and staleness rules per `delivery/transport-health`); a `hook` heartbeat SHALL never exempt (issue #435).

#### Scenario: Live channel keeps a dormant-session daemon alive

- **GIVEN** the workspace's only session is dormant and a channel heartbeat for this workspace and socket is within its TTL
- **WHEN** the idle window elapses
- **THEN** the daemon keeps running and ticking

#### Scenario: Stale channel lease lets reaping resume

- **GIVEN** the channel process died uncleanly, so its record stops counting once its 30s channel TTL lapses
- **WHEN** the idle window elapses with no active session
- **THEN** the daemon stops

#### Scenario: Hook heartbeat or foreign socket does not exempt

- **WHEN** the only fresh heartbeat is a `hook` heartbeat, or a `channel` heartbeat naming a different daemon's socket
- **THEN** reaping proceeds as if no heartbeat existed

### Requirement: Channel exemption does not end the boot grace window

A channel-only exemption SHALL NOT count as having seen a session; only an actually-open session ends the boot-grace window. When reaping is disabled (`--reap-after-ms 0`) the reaper SHALL skip reading the transport heartbeat registry entirely.

#### Scenario: Channel attaches and detaches before any session

- **GIVEN** a channel attached and detached cleanly before any session registered
- **WHEN** the next reap check runs
- **THEN** the boot-grace window `max(reapAfterMs, bootGraceMs)` still applies

### Requirement: Registry read failure fails closed for reaping

A transient failure reading the transport registry (e.g. `EMFILE`, `EACCES`) SHALL be treated as "channel
attached" for that reap check only, and the next check re-scans; the binding comparison SHALL be one
shared predicate used by both reaping and the `delivery/transport-health` checks.

#### Scenario: Registry unreadable for one tick

- **WHEN** the registry directory read fails with `EMFILE` on one reap check
- **THEN** that check does not advance toward reaping, and the next successful read decides normally

### Requirement: Per-workspace daemon isolation

With no `--socket`, `AGENTMONITORS_DB`, or `AGENTMONITORS_SOCKET` override, an enabled workspace's daemon SHALL use paths under `<XDG_DATA_HOME or ~/.local/share>/agentmonitors/workspaces/<hash>/`, where `<hash>` is the first 16 hex chars of SHA-256 of the resolved workspace path. This SHALL hold whether the daemon was lazily booted or invoked directly (issue #335).

#### Scenario: Same repo shares, distinct repos isolate

- **WHEN** two sessions open in `/repo-a` and one in `/repo-b`
- **THEN** both `/repo-a` sessions use one daemon and database
- **AND** `/repo-b` uses a separate daemon and database

#### Scenario: Directly-run daemon agrees with lazy boot

- **GIVEN** an enabled workspace and no path overrides
- **WHEN** the user runs `agentmonitors daemon run` directly
- **THEN** it binds the same per-workspace socket and database that `session start` would, so `doctor`, `session list`, and `daemon status` agree

### Requirement: Lazy daemon boot from session start

When no daemon is listening at the per-workspace socket, `session start` SHALL spawn `daemon run` as a detached, unref'd background process (`stdio` ignored), wait up to 8 seconds for the socket to appear, then open the session. The coordination file `.claude/agentmonitors.local.md` SHALL hold `enabled`, `socket`, `db`, and `reap-after-ms` so sibling hooks locate the daemon without re-deriving paths. Command output, exit codes, and the boot-failure marker are per `cli/session-commands`.

#### Scenario: Hook process exits while the daemon keeps running

- **GIVEN** an enabled workspace with no running daemon
- **WHEN** `session start` runs from a hook and returns
- **THEN** a daemon is listening at the per-workspace socket and continues after the hook process exits

### Requirement: Session start is a no-op when not enabled

If `.claude/agentmonitors.local.md` is absent or its `enabled` is unset or `false`, `session start` SHALL return without opening a session or spawning a daemon. A project with no monitor definitions SHALL stay fully silent; a project with unwatched monitor definitions emits the advisory defined by the `delivery/hook-transport` capability (issue #269).

#### Scenario: Disabled workspace without monitors is silent

- **GIVEN** no `.claude/agentmonitors.local.md` and no monitor definitions
- **WHEN** `session start` runs
- **THEN** no daemon is spawned, no session is opened, and nothing is printed

### Requirement: Socket path resolution precedence

The daemon socket path SHALL resolve in priority order: a caller-supplied override path; then the `AGENTMONITORS_SOCKET` environment variable; then `<dbDir>/agentmonitors.sock`, where `<dbDir>` is the directory containing the SQLite file, or `~/.local/share/agentmonitors` for a `:memory:` database.

#### Scenario: Environment variable beats the db-derived default

- **GIVEN** no override and `AGENTMONITORS_SOCKET=/tmp/x.sock`
- **WHEN** the socket path is resolved
- **THEN** it is `/tmp/x.sock`

### Requirement: Over-long socket paths hash into an owner-only per-uid directory

If the resolved path exceeds 100 characters, it SHALL be replaced by `/tmp/agentmonitors-<uid>/agentmonitors-<hash>.sock` (`<hash>` = first 16 hex chars of SHA-256 of the candidate). The `0700` per-uid directory SHALL be created atomically, and an existing one SHALL be refused unless it is a real, non-symlink directory owned by the current user (issue #292).

#### Scenario: Planted directory fails closed

- **GIVEN** `/tmp/agentmonitors-<uid>` exists as a symlink or is owned by another user
- **WHEN** an over-long socket path is resolved for binding
- **THEN** resolution fails rather than binding inside that directory

#### Scenario: Over-long candidate is substituted consistently

- **WHEN** the same 144-character candidate is resolved twice
- **THEN** both resolve to the same `/tmp/agentmonitors-<uid>/agentmonitors-<hash>.sock`

### Requirement: Legacy hashed socket location is honored during upgrade

On the hashed-fallback branch, resolution SHALL first probe the pre-#292 path `/tmp/agentmonitors-<hash>.sock` (only if it exists): if a live daemon answers there, it SHALL return the legacy path; otherwise the new per-uid path. A daemon SHALL only ever bind the new path, so one restart of a legacy daemon completes the migration without a second daemon on the same database.

#### Scenario: Running legacy daemon is reused, not duplicated

- **GIVEN** a pre-upgrade daemon is live on `/tmp/agentmonitors-<hash>.sock`
- **WHEN** an upgraded client resolves the same over-long candidate
- **THEN** it talks to the legacy daemon and no second daemon is lazily booted

### Requirement: Explicit over-long socket substitution is announced

When an override path came from a literal `--socket` flag and exceeds the limit, the CLI SHALL print one stderr line naming the requested path, the limit, and the substituted path before falling back to the hash; the exact text is owned by the `cli/conventions` capability. Env-derived, local-state-derived, and default-derived candidates SHALL hash silently (issue #337).

#### Scenario: Typed --socket substitution warns

- **WHEN** `daemon run --socket <144-char path>` runs
- **THEN** stderr names the requested path, the 100-character limit, and the substituted path, and the daemon still binds the substituted path

### Requirement: Hashed socket identity is the candidate string only

The hashed fallback SHALL identify a daemon only by the exact over-long candidate string, not by workspace: the same over-long `--socket` value reused across unrelated workspaces resolves to the same socket, and the IPC SHALL NOT verify a reachable daemon's workspace identity. Callers using an explicit over-long `--socket` own that disambiguation.

#### Scenario: Shared templated --socket reaches the same daemon

- **GIVEN** workspaces `/a` and `/b` both pass the same over-long `--socket` value
- **WHEN** each resolves its socket
- **THEN** both resolve to the same substituted path and reach whichever daemon is listening there

### Requirement: Newline-delimited JSON wire protocol

Each IPC exchange SHALL be one connection carrying a single newline-delimited JSON request; the server reads to the first `\n`, dispatches the method, writes one JSON response terminated by `\n` — `{ id, result? }` on success or `{ id, error }` on failure, optionally with a machine-readable `code` — then closes the connection.

#### Scenario: Successful ping round trip

- **WHEN** a client writes `{"id":"1","method":"ping"}\n`
- **THEN** the daemon replies `{"id":"1","result":{"ok":true}}\n` and closes the connection

### Requirement: Unparseable requests get a stable sentinel

A request that is not valid JSON or does not match the request schema (including an unknown method) SHALL receive `{ "id": "invalid", "error": "Invalid JSON request.", "code": "unsupported_request" }`. The `error` text SHALL stay byte-identical so older clients keep recognizing it; `code` is additive (issue #382).

#### Scenario: Older daemon rejects a newer method

- **WHEN** a client sends a method the daemon's schema does not know
- **THEN** the reply is `{"id":"invalid","error":"Invalid JSON request.","code":"unsupported_request"}`

### Requirement: Daemon control and session socket methods

The `DaemonMethod` enum SHALL include: `ping` (health check, returns `{ ok: true }`); `status` (returns `RuntimeStatus`: session counts and event count); `stop` (graceful shutdown); `session.open` (opens or resumes, returns `AgentSessionRecord`); `session.close` (marks dormant, returns `AgentSessionRecord`); `session.list` (returns all `AgentSessionRecord[]`).

#### Scenario: session.open resumes over the socket

- **WHEN** `session.open` is called twice with the same adapter and host session id
- **THEN** both calls return the same `AgentSessionRecord.id`

### Requirement: Daemon event, delivery, and diagnosis socket methods

The `DaemonMethod` enum SHALL include: `events.list` (optional filters, returns `MonitorEventRecord[]`); `events.ack` (acknowledges events for a session); `hook.claim` (claims a delivery at a lifecycle, returns `DeliveryClaim | null`); `history.list` (recent observation-history rows, optionally by monitor id); `monitor.explain` (read-only staged diagnosis); `daemon.tick` (one tick on a monitors directory).

#### Scenario: Scope filters match queryScope

- **GIVEN** two events whose `query_scope` differ but whose source payloads share the filtered key
- **WHEN** `events.list` is called with a scope filter
- **THEN** only the event whose `query_scope` matches is returned, independent of payload internals

### Requirement: Additional socket methods owned by other capabilities

The `DaemonMethod` enum SHALL also include `events.retractObject`, `events.suppressObject` (per `cli/verify`), `hook.reserve`, `hook.commit`, `hook.release`, `hook.preview`, `hook.previewReminder`, `hook.diagnose` (per the delivery transport capabilities), `doctor.report` (per `cli/doctor`), and `watch.declare`, `watch.list`, `watch.cancel` (per `agent/ephemeral-monitors`). Their semantics are owned there.

#### Scenario: Ephemeral watch methods are reachable over the socket

- **WHEN** a client sends a `watch.list` request with valid params
- **THEN** the daemon dispatches it rather than replying with the unsupported-request sentinel

### Requirement: Session, events, and hook commands round-trip through the socket

The CLI SHALL route these commands through the daemon socket rather than a local runtime: `session open`/`close`/`list` → `session.open`/`session.close`/`session.list`; `events list`/`events ack` → `events.list`/`events.ack`; `hook claim` → `hook.claim`; `monitor history` → `history.list`; `monitor explain` → `monitor.explain`. In-process fallbacks are defined per command by the `cli/*` capabilities.

#### Scenario: hook claim uses the daemon

- **GIVEN** a daemon is running for the workspace
- **WHEN** `agentmonitors hook claim` runs
- **THEN** the claim is served by the daemon's `hook.claim` method

### Requirement: Monitor pipeline diagnosis stages

`monitor.explain` SHALL walk one monitor through persisted pipeline state and return stages: definition (scanned `MONITOR.md`, source resolution, scope validation); scheduling (`monitor_state.last_observation_at`, due state, next due time); observation (recent `observation_history`, latest outcome); notify state (debounce/throttle in `notify_state`); materialization (recent `monitor_events`); projection and delivery.

#### Scenario: Invalid schedule timezone is an observation-stage failure

- **GIVEN** a schedule monitor whose timezone is not a valid IANA zone
- **WHEN** `monitor.explain` runs for it
- **THEN** the observation stage reports `failure` naming the invalid timezone and the method does not crash (issue #297)

### Requirement: Projection and delivery stage reports per-session state

The projection-and-delivery stage SHALL report `session_event_state` joined to `agent_sessions` as `unread`, `claimed`, or `acknowledged`. If events exist but no lead session matches the workspace (including global sessions), the stage SHALL report that no lead session is registered.

#### Scenario: Events without a lead session

- **GIVEN** monitor `m` has materialized events and no lead session is registered for the workspace
- **WHEN** `monitor.explain` runs for `m`
- **THEN** the delivery stage reports that no lead session is registered

### Requirement: Reminder suppression is explained

When a session's unread normal or low events are claimed or leased so the coalesced reminder is suppressed, the delivery stage SHALL add a `reminderSuppression` finding per session and band: `already-claimed` or `coalesced-until-ack` when a band event is durably claimed, else `reserved-in-flight` when one is leased by an in-flight channel push (issue #300). The stage stays `ok`.

#### Scenario: Fully claimed band

- **GIVEN** every unread normal event of session S is claimed
- **WHEN** `monitor.explain` runs
- **THEN** the delivery stage is `ok` with a `reminderSuppression` of `already-claimed` for S's `normal` band

#### Scenario: Mixed claimed and unclaimed band

- **GIVEN** S has one claimed and one unclaimed unread normal event
- **WHEN** `monitor.explain` runs
- **THEN** the finding reason is `coalesced-until-ack`

### Requirement: Leased-only suppression never recommends acknowledging

A `reserved-in-flight` finding SHALL NOT recommend `events ack`: a lease is not a claim and resolves itself, and acknowledging a leased-but-unseen row before the push resolves could lose it permanently if the push fails.

#### Scenario: Leased band guidance

- **GIVEN** S's only unread normal event is leased by an in-flight channel push
- **WHEN** `monitor.explain` runs
- **THEN** the finding is `reserved-in-flight` and its guidance does not mention `events ack`

### Requirement: Diagnosis stage statuses

Each stage SHALL carry a `status` of `ok` (produced the signal the next stage needs), `pending` (intentionally holding, or upstream has not produced input), `healthy` (ran successfully and correctly found no work), or `failure` (a real fault: invalid definition, errored observe, zero-file match, or missing expected projection). An unreachable daemon is not itself a stage failure.

#### Scenario: Debounced monitor is pending

- **GIVEN** monitor `m` has observations held in a debounce batch
- **WHEN** `monitor.explain` runs
- **THEN** the notify-state stage is `pending`

### Requirement: Idle monitor is diagnosed as healthy

A latest observation outcome of `no-change` or `rebaselined` SHALL be `healthy`, not `failure`, and the downstream materialization and delivery stages SHALL then report `healthy` for the expected absence of events and projections.

#### Scenario: Genuinely idle monitor

- **GIVEN** monitor `m`'s latest observation is `no-change`
- **WHEN** `monitor.explain` runs
- **THEN** the observation stage is `healthy` and states the watched target has not changed (not a bug)
- **AND** the materialization and delivery stages are `healthy`

### Requirement: Diagnosis is read-only and workspace-scoped

`monitor.explain` MUST NOT mutate runtime state and MUST scope to the requested workspace: materialization counts only `monitor_events` for that `workspacePath` plus workspace-agnostic events, and delivery counts only projections to that workspace's sessions plus global sessions, because the database is shared across workspaces.

#### Scenario: Same monitor id in another workspace does not leak

- **GIVEN** monitor id `my-first-monitor` exists in `/a` and `/b`, and only `/b` has events
- **WHEN** `monitor.explain my-first-monitor` runs for `/a`
- **THEN** no `/b` events or projections are counted

### Requirement: Diagnosis falls back to an in-process read

If the daemon socket is unavailable (connection refused, absent, or timeout), the CLI SHALL run the same diagnosis in-process against the local SQLite store and return the real per-stage report from the last persisted tick, never a fabricated scheduling failure (#150). Only if the store has no `observation_history` and no `monitor_events` for the monitor SHALL it print a remediation message. Daemon-side application errors SHALL surface verbatim.

#### Scenario: Monitor that fired before the daemon stopped

- **GIVEN** monitor `m` emitted events and then the daemon stopped
- **WHEN** `monitor explain m` runs
- **THEN** the report reflects the persisted pipeline state and no scheduling failure is invented

#### Scenario: Daemon application error is not masked

- **WHEN** the daemon answers `monitor.explain` with an error
- **THEN** the CLI surfaces that error and does not fall back or claim the daemon is not running
