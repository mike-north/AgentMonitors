# runtime/notify-dispatch Specification

## Purpose

Defines notify dispatch — the Pace stage that decides when observations returned by a source become
emitted observations to materialize as durable events: urgency defaults, effective urgency within an
authored band, and the immediate, throttle, debounce, and scheduled-rollup modes. The `notify`
frontmatter surface is owned by `monitor/definition`.

## Requirements

### Requirement: Default notify behavior by urgency

When a monitor omits `notify`, the system SHALL apply `debounce` with `settle-for: 15s` to `high`
urgency and SHALL emit `normal` and `low` urgency observations immediately with no notify config.
Rationale: this is why a high-urgency signal is not delivered the instant one observation appears.

#### Scenario: Debounced high-urgency burst

- **GIVEN** a `high` monitor without `notify` that emits two observations on one tick
- **WHEN** notify dispatch runs
- **THEN** both are held in `notifyState.pendingDebounce` and no `monitor_events` rows exist yet
- **AND** a later tick at or after `dueAt` (15s later) flushes the batch and two events are persisted and projected into matching lead sessions

#### Scenario: Normal and low emit immediately

- **WHEN** a `normal` monitor and a `low` monitor, both without `notify`, each emit an observation
- **THEN** each observation is emitted on the same tick

### Requirement: Effective urgency is the salience clamped into the authored band

For each observation the system SHALL resolve effective urgency as `clamp(salience ?? band.lo,
band.lo, band.hi)`, where the monitor's `urgency` is a band `lo..hi` (a bare scalar is `x..x`) and
`salience` is the source's optional per-observation judgment (per `sources/contract`).

#### Scenario: No salience uses the low bound

- **WHEN** a `normal..high` monitor's observation carries no `salience`
- **THEN** its effective urgency is `normal`

#### Scenario: Salience inside the band escalates

- **WHEN** a `normal..high` monitor's observation carries `salience: high`
- **THEN** its effective urgency is `high`

#### Scenario: Salience above the band is clamped to the high bound

- **WHEN** a `low..normal` monitor's observation carries `salience: high`
- **THEN** its effective urgency is `normal`

#### Scenario: Salience below the band is clamped to the low bound

- **WHEN** a `normal..high` monitor's observation carries `salience: low`
- **THEN** its effective urgency is `normal`

#### Scenario: Scalar urgency can never be escalated

- **WHEN** a monitor authored with bare `urgency: low` receives an observation with `salience: high`
- **THEN** its effective urgency is `low` (per PP5)

### Requirement: Notify is evaluated against effective urgency

The system SHALL evaluate the default notify behavior against each observation's effective urgency,
not the monitor's base urgency, and SHALL carry that effective urgency into materialization (per
`runtime/event-materialization`).

#### Scenario: Escalated observation takes the high path

- **GIVEN** a `normal..high` monitor without `notify`
- **WHEN** an observation carries `salience: high`
- **THEN** it is held by the 15s debounce settle rather than emitted immediately

### Requirement: Escalation flushes the whole held debounce batch

When an escalated observation (effective urgency above the band's low bound) arrives while a debounce
batch is held, the system SHALL immediately emit the entire held batch followed by the escalated
observation, SHALL NOT split the batch, and SHALL preserve held-first ordering.

#### Scenario: Early whole-batch flush

- **GIVEN** a held debounce batch of two observations not yet at `dueAt`
- **WHEN** an escalated observation arrives
- **THEN** all three are emitted on that tick in order: the two held, then the escalated one

### Requirement: Throttle semantics

For `notify.strategy: throttle`, the system SHALL emit the first observation after any suppression
window immediately, drop further observations inside the window, and set `suppressedUntil` to the
emitted observation's time plus `suppress-for`.

#### Scenario: Observations inside the window are dropped

- **GIVEN** `notify: { strategy: throttle, suppress-for: 10m }`
- **WHEN** observations arrive at t=0, t=5m, and t=11m
- **THEN** the t=0 and t=11m observations are emitted and the t=5m one is dropped

### Requirement: Debounce semantics

For `notify.strategy: debounce`, the system SHALL accumulate observations in a pending batch
(`PendingDebounceState` = `{ observations, dueAt }`), reset `dueAt` to `observedAt + settle-for` on
each new observation, and flush the full batch on the first tick at or after `dueAt`, so delivery is
bounded by both the settle interval and the tick cadence.

#### Scenario: New observation extends the settle

- **GIVEN** `settle-for: 15s` and an observation at t=0
- **WHEN** another observation arrives at t=10s
- **THEN** `dueAt` becomes t=25s and a tick at t=20s flushes nothing

### Requirement: Rollup accumulates durably without per-change delivery

For `notify.strategy: rollup`, the system SHALL append every observation since the last flush to a
durable `notifyState.pendingRollup` batch with no settle-driven `dueAt`, SHALL keep it across daemon
restarts, and SHALL NOT deliver anything outside a window opening.

#### Scenario: Durable accumulation across ticks

- **WHEN** a rollup monitor observes changes on several ticks before its window
- **THEN** no events are materialized and `pendingRollup` holds every observation

### Requirement: Rollup window evaluation

On each tick the system SHALL evaluate the rollup `notify.window` cron in `notify.timezone` (default
`UTC`), firing at most once per minute, and when it matches with a non-empty batch SHALL flush the
whole batch and clear the accumulation state; this decision is made once on the shared side of the
seam, including on ticks where the source itself is not due.

#### Scenario: Window flushes and clears

- **GIVEN** `notify: { strategy: rollup, window: "0 9 * * 1-5" }` with three accumulated observations
- **WHEN** a tick runs at 09:00 UTC on a Monday
- **THEN** all three are emitted and `pendingRollup` is cleared

#### Scenario: Window fires on a not-due tick

- **GIVEN** a rollup monitor with a relaxed `watch.interval: 1h` that is not due
- **WHEN** its window opens
- **THEN** the accumulated batch is still flushed

### Requirement: Empty rollup window produces no delivery

When a rollup window opens and nothing has accumulated since the last flush, the system SHALL
produce no delivery.

#### Scenario: Empty window

- **WHEN** the window opens with an empty batch
- **THEN** no event is materialized

### Requirement: Rollup flush materializes one event per observation

The system SHALL materialize a flushed rollup batch as one `monitor_events` row per accumulated
observation, each carrying its own effective urgency, so the full history stays queryable; it MAY
additionally synthesize a composite summary for the delivery payload.

#### Scenario: Individual rows with individual urgency

- **GIVEN** a `normal..high` rollup batch of one `normal` and one `high` observation
- **WHEN** the window flushes
- **THEN** two `monitor_events` rows exist with urgencies `normal` and `high`

### Requirement: Four Pace modes

The system SHALL support exactly four Pace modes: immediate (`notify` omitted; each observation
emits), `debounce` (first tick after the signal goes quiet), `throttle` (first observation after the
suppression window), and `rollup` (window opening on a cron schedule).

#### Scenario: Mode selection

- **WHEN** a `normal` monitor declares `notify.strategy: rollup`
- **THEN** its observations are held for the window instead of emitting immediately
