## ADDED Requirements

### Requirement: No busy-spinning daemon machinery

The daemon's own machinery — tick loop, scheduling, bookkeeping, and transports — MUST NOT busy-spin: its wakeup count SHALL scale with the number of scheduled intervals, never with wall-clock resolution.

#### Scenario: Wake count over idle intervals

- **GIVEN** an integration harness that counts daemon wakeups (poll-loop iterations and timer fires, logged at debug level)
- **AND** monitors are present but nothing is due
- **WHEN** the daemon runs for a window of N tick intervals
- **THEN** the wakeup count is O(N) with a small constant and does not scale with wall-clock resolution

### Requirement: Coalesced wakes

The daemon SHALL coalesce wakes: a due tick SHALL perform no intermediate wakeups between its observation and the next scheduled one.

#### Scenario: Due tick wakes once

- **WHEN** a monitor's tick is due and its observation completes
- **THEN** the daemon performs no wakeups between that observation and the next scheduled tick

### Requirement: Idle monitors cost close to nothing

Monitors that have nothing due SHALL cost close to nothing in daemon wakeups and work; the numeric per-interval wake budget is set by #469's design work and SHALL be asserted in the wake-count measurement.

#### Scenario: Budget asserted in the existing measurement

- **WHEN** #469's numeric per-interval budget is defined
- **THEN** it is asserted as a bound in the wake-count measurement harness rather than in a new test design

### Requirement: Event-driven paths preferred over polling

Where a source supports event-driven observation, the daemon SHALL prefer it over polling (per NP4, watch mode remains opt-in and additive).

#### Scenario: Watch-capable source

- **WHEN** a monitor's source implements event-driven watching and is driven by `daemon run`
- **THEN** the daemon uses the event-driven path for it instead of polling its `observe()` on every tick

### Requirement: Conditional network polling

Network polling performed by the daemon's machinery SHALL use conditional requests where the source protocol allows.

#### Scenario: Endpoint supports validators

- **GIVEN** a polled HTTP endpoint that returned an `ETag` or `Last-Modified` validator
- **WHEN** the next poll is made
- **THEN** the request is conditional on that validator

### Requirement: Battery-aware intervals

Where the platform exposes power state, the daemon's intervals SHALL be battery-aware.

#### Scenario: Platform reports battery power

- **WHEN** the platform exposes that the machine is on battery power
- **THEN** the daemon's scheduling takes that power state into account

### Requirement: Sleep and wake without thundering catch-up

After the machine sleeps and wakes, the daemon SHALL reconcile without a thundering catch-up: missed windows SHALL NOT be replayed (per BP1).

#### Scenario: Wake after a long sleep

- **GIVEN** monitors whose schedules had several windows elapse while the machine slept
- **WHEN** the machine wakes
- **THEN** the daemon does not replay the missed windows in a burst
