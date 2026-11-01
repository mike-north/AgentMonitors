# runtime/tick-scheduling Specification

## Purpose

Defines the runtime tick: how the runtime scans monitors, decides which are due (interval defaults,
cron schedule matching), drives continuous `watch()` sources and their durable checkpoints, and
reports each tick's outcome. Notify timing is `runtime/notify-dispatch`; event rows are
`runtime/event-materialization`.

## Requirements

### Requirement: Tick scans and parses monitors

On each tick the system SHALL scan the supplied monitors directory for `**/MONITOR.md`, parse the
valid monitor definitions, and collect parse errors separately from the parsed monitors.

#### Scenario: Parse errors do not hide valid monitors

- **GIVEN** a monitors directory with one valid and one malformed `MONITOR.md`
- **WHEN** a tick runs
- **THEN** the valid monitor is evaluated and the malformed one is reported as a parse error

### Requirement: Unknown source fails the tick

The system SHALL resolve each parsed monitor's source name (`watch.type`) against the source
registry and SHALL fail the tick when a parsed monitor references a source that is not registered.

#### Scenario: Unregistered source

- **WHEN** a parsed monitor declares a `watch.type` absent from the registry
- **THEN** the tick fails with the error `Monitor "<id>" references unknown source "<name>".`

### Requirement: Due monitors are observed with scope, prior state, and now

For each monitor the system SHALL decide whether it is due and, when due, call the source's
`observe()` with the monitor's scope (its per-source `watch` configuration), its previously persisted
source state if any, and the runtime-supplied `now`.

#### Scenario: Prior state is threaded

- **GIVEN** a stateful monitor whose previous tick persisted source state
- **WHEN** it is next due
- **THEN** `observe()` receives that persisted state and the tick's `now`

### Requirement: Tick processes observations in a fixed order

After `observe()` returns, the system SHALL route the observations through notify dispatch, persist
the updated source state and notify state, materialize the emitted observations as durable events,
and then refresh hook state for sessions in the affected workspace — in that order.

#### Scenario: Emitted observation reaches hook state

- **WHEN** a due monitor's observation is emitted immediately
- **THEN** its source and notify state are persisted, its event row exists, and the workspace's lead-session hook state reflects it by the end of the tick

### Requirement: Default due intervals

When a monitor declares no `watch.interval`, the system SHALL use these due intervals: `schedule`
monitors are evaluated once per minute (60s); `api-poll` monitors every 5 minutes (300s); every other
source every 30 seconds (the exported `schedulingDefaults` values).

#### Scenario: Defaults per source class

- **WHEN** a `file-fingerprint` monitor, an `api-poll` monitor, and a `schedule` monitor all omit `watch.interval`
- **THEN** they are due at most every 30s, 300s, and 60s respectively

### Requirement: Declared interval is parsed as a duration

When a non-schedule monitor declares a string `watch.interval`, the system SHALL parse it as a
duration and use the result as the monitor's due interval.

#### Scenario: Custom interval

- **WHEN** a `file-fingerprint` monitor declares `watch.interval: 2m` and 90 seconds have elapsed since its last observation
- **THEN** it is not yet due, and it becomes due once 120 seconds have elapsed

### Requirement: Schedule monitors are due by runtime cron matching

The system, not the schedule source, SHALL decide when a `schedule` monitor is due, by interpreting
`watch.cron` as a five-field cron expression evaluated in `watch.timezone` (default `UTC`). Malformed
cron fields SHALL be treated as non-matching.

#### Scenario: Timezone-aware matching

- **GIVEN** a schedule monitor with `watch.cron: "0 9 * * *"` and `watch.timezone: America/New_York`
- **WHEN** the tick runs at 09:00 New York time
- **THEN** the monitor is due, and it is not due at 09:00 UTC

#### Scenario: Malformed cron never matches

- **WHEN** a schedule monitor's cron has a malformed field
- **THEN** the monitor is never due and the tick does not throw

### Requirement: Schedule fires at most once per minute without backfill

The system SHALL require at least 60,000 ms to have elapsed since a schedule monitor's last
observation in addition to a cron match, so it cannot fire twice in the same minute, and SHALL NOT
backfill cron windows missed while the runtime was not ticking (per BP1).

#### Scenario: Two ticks in one minute

- **WHEN** two ticks run within the same matching minute
- **THEN** the schedule monitor is observed only on the first

#### Scenario: Missed window is not replayed

- **GIVEN** the daemon was stopped across a matching cron minute
- **WHEN** it restarts after that minute
- **THEN** no observation is produced for the missed window

### Requirement: Invalid schedule timezone is isolated to its monitor

When cron evaluation fails because a timezone is rejected, the system SHALL NOT throw out of the
tick (issue #297): it SHALL treat that monitor as not schedulable this tick, push a `{ monitorId,
message }` onto `erroredObservations`, write an `errored` `observation_history` row, skip that
monitor, and evaluate every other monitor normally.
Rationale: authoring-time validation is primary; this is a defensive backstop for hand-edited files.

#### Scenario: Sibling still emits

- **GIVEN** two monitors, one schedule monitor with an invalid `watch.timezone` and one healthy monitor that changes
- **WHEN** a tick runs
- **THEN** the healthy monitor's event is materialized
- **AND** the invalid one appears in `erroredObservations` with an `errored` history row

#### Scenario: Rollup timezone on the not-due flush path

- **WHEN** a `rollup` monitor's `notify.timezone` is invalid and its window is evaluated on a not-due tick
- **THEN** the failure is isolated to that monitor in the same way, independent of `watch.timezone`

### Requirement: Diagnostics report an invalid timezone without mutating state

The system SHALL render an invalid schedule timezone in `monitor explain` as an observation-stage
failure computed in memory, without writing an `observation_history` row, and `doctor` SHALL report
the monitor as invalid with the failure in its validation error, alongside any scope-schema error.

#### Scenario: explain does not crash

- **WHEN** `monitor explain` is run for a schedule monitor with an invalid timezone
- **THEN** it reports an observation-stage `failure` and the persisted history is unchanged

#### Scenario: doctor isolates the invalid monitor

- **WHEN** `doctor` runs over that monitor and a healthy sibling
- **THEN** the invalid monitor is reported invalid and the sibling healthy, without crashing

### Requirement: Watch-capable sources are driven continuously

For each monitor whose source implements `watch()`, the system SHALL consume its
`AsyncIterable<Observation>` via `watchMonitors(monitorsDir, workspacePath)` and funnel every yielded
observation through the same notify → materialization → projection pipeline as `observe()`. The
returned `WatchHandle.stop()` SHALL abort every watcher via its signal and await them. `daemon run`
starts watchers at startup and stops them on shutdown (per NP4).

#### Scenario: One yielded observation

- **GIVEN** a `watch()` source that yields one observation then idles until aborted
- **WHEN** the watcher runs and is then stopped
- **THEN** exactly one materialized, session-projected event exists
- **AND** `stop()` resolves after the source's abort handler fired

### Requirement: Tick never double-drives a watched monitor

While a monitor has an active watcher, the system SHALL skip its `observe()` on ticks, and that
monitor SHALL NOT appear in the tick's `skippedMonitors`.

#### Scenario: Active watcher suppresses polling

- **WHEN** a tick runs while a monitor's watcher is active
- **THEN** that monitor's `observe()` is not called

### Requirement: Watchers release their slot on any exit

The system SHALL release a watcher from the active-watcher set whenever it exits for any reason —
normal completion, an error (reported via `onError` unless it is the runtime's own abort), a
synchronous throw before an iterable is returned, or `stop()` — after which ticks resume `observe()`
and a later `watchMonitors()` can re-establish it. Each slot SHALL carry a per-watcher identity token
so a superseded watcher releases only its own slot.

#### Scenario: Normal completion resumes polling

- **WHEN** a `watch()` iterable completes normally
- **THEN** the next tick drives that monitor via `observe()`

#### Scenario: Synchronous throw does not leak the slot

- **WHEN** `watch()` throws before returning an iterable
- **THEN** the error is reported via `onError` and the slot is released

### Requirement: Watch state is in memory unless checkpointed

The system SHALL NOT automatically persist a `watch()` source's in-memory change-detection state; a
re-established watcher starts fresh after a restart unless the source durably checkpointed its state
via `context.checkpoint`, in which case it reconciles from the last checkpointed baseline.

#### Scenario: Restart reconciles from a checkpoint

- **GIVEN** a watcher that checkpointed its state to a real SQLite database
- **WHEN** the runtime restarts and the watcher is re-established
- **THEN** the source receives the checkpointed state as its baseline

### Requirement: Checkpoint callback is offered only to watch

The system SHALL supply the optional `ObservationContext.checkpoint(nextState) => Promise<void>`
callback only to `watch()`; `observe()` SHALL NOT receive it and continues to return state via
`nextState`.

#### Scenario: observe has no checkpoint

- **WHEN** a source's `observe()` is called on a tick
- **THEN** its context has no `checkpoint` callback

### Requirement: Checkpoint durably writes source state only

On `checkpoint(nextState)` the system SHALL persist `nextState` as `sourceState` in the watcher's own
`(monitorId, workspacePath)` monitor-state row, leaving notify state and `lastObservationAt`
untouched, and SHALL resolve only once the write is durable. A checkpoint SHALL NOT materialize,
deliver, or project any observation.

#### Scenario: Checkpoint persists before resolving

- **WHEN** a watcher calls `checkpoint` with updated state
- **THEN** the persisted `sourceState` equals that state by the time the promise resolves
- **AND** no `monitor_events` row is created

#### Scenario: Workspace-scoped write

- **GIVEN** the same monitor id in two workspaces
- **WHEN** the watcher in one workspace checkpoints
- **THEN** the other workspace's state row is unchanged

### Requirement: Checkpoints and ingestion are serialized per watcher

The system SHALL serialize checkpoint writes and observation ingestion on one per-watcher chain so a
checkpoint write in flight completes before any subsequently yielded observation from that watcher
is ingested.

#### Scenario: Delayed checkpoint orders first

- **GIVEN** a checkpoint whose durable write is artificially delayed
- **WHEN** the watcher yields an observation while it is in flight
- **THEN** the observation is ingested only after the checkpoint write completes

#### Scenario: Crash between burst and checkpoint

- **GIVEN** a `file-fingerprint` watcher that yields 10 observations and then calls `checkpoint` once
- **WHEN** the daemon is killed after the 10 events materialize but before the checkpoint write
- **THEN** a restart reconciles from the pre-burst baseline and may re-produce those 10 observations

### Requirement: Checkpoint cadence is the source's choice

The system SHALL NOT require a checkpoint on every OS event; a watching source SHOULD checkpoint at
roughly its monitor's interval (the default 30s when none is declared) and MAY coalesce rapid
requests.

#### Scenario: Coalesced checkpoints are accepted

- **WHEN** a watcher checkpoints once after a burst of OS events instead of once per event
- **THEN** the runtime accepts and persists the single checkpoint

### Requirement: A failed checkpoint never aborts the watcher

When a checkpoint write throws or rejects, the system SHALL log a warning to stderr and resolve
rather than abort the watcher, which SHALL continue yielding and ingesting observations.

#### Scenario: Failing checkpoint

- **WHEN** a checkpoint write fails
- **THEN** a warning is logged and the watcher's subsequent observations are still ingested

### Requirement: Post-teardown checkpoints are rejected

Once a watcher is torn down — its signal aborted by `stop()`, or superseded as the active watcher for
its monitor — the system SHALL reject any further `checkpoint` from it: write nothing, log exactly
one warning, and resolve. Shutdown SHALL flush the per-watcher chain until it stabilizes so an
in-flight checkpoint is still awaited, and SHALL terminate.

#### Scenario: Checkpoint after stop

- **GIVEN** a checkpoint callback captured before `stop()`
- **WHEN** it is invoked after `stop()`
- **THEN** no state is written and exactly one warning is logged

#### Scenario: Superseded watcher

- **WHEN** a superseded, non-aborted watcher checkpoints stale state
- **THEN** its successor's persisted baseline is unchanged

### Requirement: Tick returns a RuntimeTickResult

The system SHALL return a `RuntimeTickResult` from each tick with `evaluatedMonitors` (ids whose
`observe()` was attempted, including errored ones), `emittedEventIds` (events materialized this
tick), `erroredObservations`, and `skippedMonitors`.

#### Scenario: Result lists evaluated and emitted

- **WHEN** a tick evaluates two monitors and one emits an event
- **THEN** `evaluatedMonitors` has both ids and `emittedEventIds` has the one event id

### Requirement: Tick result surfaces observation failures

The system SHALL push one `{ monitorId, message }` onto `erroredObservations` for each monitor whose
`observe()` threw or rejected or whose ingestion failed, from the same code path that writes the
`errored` `observation_history` row (row contents per `persistence/schema`), and SHALL NOT include a
monitor that genuinely observed no change, so callers can distinguish a failure from a clean `emitted 0`.

#### Scenario: Failure versus no change

- **GIVEN** one monitor whose `observe()` throws and one that observes no change
- **WHEN** a tick runs
- **THEN** only the throwing monitor appears in `erroredObservations`

### Requirement: Tick result surfaces not-yet-due monitors

The system SHALL push one `{ monitorId, nextDueAt }` onto `skippedMonitors` for each monitor found
but not yet due (interval not elapsed, or cron window not open), from the same scheduling decision
that gates evaluation, so callers can distinguish "not yet due" from "no monitors found" (issue #152).

#### Scenario: Not yet due

- **WHEN** a tick runs 10 seconds after a 30-second-interval monitor last observed
- **THEN** the monitor appears in `skippedMonitors` with its `nextDueAt`, not in `evaluatedMonitors`
