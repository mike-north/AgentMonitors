# runtime/monitor-state Specification

## Purpose

Defines the persisted per-monitor runtime state — its fields, which component owns each part, its
workspace scoping, and how it is hydrated safely across daemon restarts and upgrades. The on-disk
`monitor_state` table layout is owned by `persistence/schema`.

## Requirements

### Requirement: Each monitor has persisted runtime state

The system SHALL persist runtime state for each monitor (the exported `MonitorRuntimeState`)
containing `lastObservationAt`, `sourceState`, and `notifyState`.

#### Scenario: State written after an observation

- **WHEN** a due monitor is observed on a tick
- **THEN** its persisted state records that tick's time as `lastObservationAt` along with its `sourceState` and `notifyState`

### Requirement: Source state is source-owned and survives restarts

The system SHALL persist `sourceState` exactly as the source returned it via `nextState`, without
interpreting it, and SHALL hand it back to the source on its next observation, including after a
runtime or daemon restart (`monitor_state.source_state`).
Rationale: sources own change detection; the runtime owns notification timing.

#### Scenario: Source state survives runtime restart

- **GIVEN** a stateful source that recorded a baseline in `nextState`
- **WHEN** the runtime is restarted against the same database and the watched thing then changes
- **THEN** the source receives its stored baseline and the change is emitted on the later tick

### Requirement: Notify state is runtime-owned

The system SHALL own `notifyState` and use it to record delivery-timing state: the throttle
suppression window (`suppressedUntil`), the held debounce batch (`pendingDebounce`), and the
accumulated scheduled-rollup batch (`pendingRollup`) held between delivery windows. Sources SHALL
NOT read or write it.

#### Scenario: Held debounce batch is persisted

- **WHEN** a `high` monitor's observation is held by its debounce settle
- **THEN** `notifyState.pendingDebounce` holds the observation and its `dueAt`

### Requirement: Monitor state is scoped by workspace

The system SHALL key monitor state by `(monitorId, workspacePath)`, never by `monitorId` alone, and
every runtime read or write of monitor state — the tick loop, ingestion, scheduling, the watch path,
`monitor explain`, and `doctor` — SHALL name its workspace scope (issues #345, #307).

#### Scenario: Same monitor id in two workspaces

- **GIVEN** monitor `docs` exists in workspace A and workspace B sharing one global database
- **WHEN** workspace A's `docs` monitor is observed and its state updated
- **THEN** workspace B's `docs` state row is unchanged

### Requirement: Hydrated held batches are backfilled with effective urgency

When a persisted `notifyState.pendingDebounce` or `notifyState.pendingRollup` batch is hydrated
after a restart, the system SHALL backfill any envelope lacking `effectiveUrgency` (written before
the urgency-band upgrade) by resolving it from the monitor and observation, falling back to the
monitor's base urgency when the hydrated monitor lacks an upper band bound, so `monitor_events.urgency`
is never written undefined (issue #109).

#### Scenario: Pre-upgrade envelope flushes with a defined urgency

- **GIVEN** a persisted debounce batch whose envelope has no `effectiveUrgency`, for a monitor with `urgency: high`
- **WHEN** the daemon restarts and the batch flushes
- **THEN** the materialized `monitor_events.urgency` is `high`

### Requirement: Rollup batch survives restarts

The system SHALL keep the `notifyState.pendingRollup` batch across daemon restarts and flush it on
the next window opening (per BP1 and `runtime/notify-dispatch`).

#### Scenario: Restart between windows

- **GIVEN** a rollup monitor that accumulated two observations
- **WHEN** the daemon restarts before the window opens and the window then opens
- **THEN** both observations are flushed in that window
