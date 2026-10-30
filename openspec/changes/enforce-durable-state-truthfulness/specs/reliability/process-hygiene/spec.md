## ADDED Requirements

### Requirement: Atomic truthful ingest

An observation SHALL be either fully persisted or truthfully reported as failed — never silently partial — and materialization failures SHALL be reported truthfully (#295).

#### Scenario: Materialization fails mid-ingest

- **WHEN** persisting an observation's events fails partway through
- **THEN** no partial subset of those events is left as if successfully ingested
- **AND** the failure is reported truthfully rather than as success

### Requirement: Spans persist before optional interpretation

An emitted span SHALL be persisted in full before any optional Interpret adapter is awaited (#294).

#### Scenario: Interpret adapter hangs or fails

- **GIVEN** a monitor with an optional Interpret adapter configured
- **WHEN** the adapter hangs, fails, or the daemon dies while it is awaited
- **THEN** the emitted span is already durably persisted

### Requirement: Validation precedes side effects

Validation SHALL run before any side effect it guards: source `scopeSchema` validation before `monitor test` performs side effects (#301), and strict validation of `channel --poll-ms` before the MCP loop starts (#306).

#### Scenario: Invalid scope in monitor test

- **WHEN** `monitor test` is run against a monitor whose scope fails the source's `scopeSchema`
- **THEN** it reports the validation error without performing any source side effect

#### Scenario: Invalid channel poll interval

- **WHEN** `channel` is started with an invalid `--poll-ms` value
- **THEN** it fails validation before starting the MCP loop

### Requirement: Unavailable upstream is not an empty baseline

An unavailable upstream SHALL be distinguished from a successful empty baseline in persisted state (#305).

#### Scenario: Incoming-changes upstream unavailable

- **WHEN** an `incoming-changes` monitor cannot reach its upstream on its first run
- **THEN** the persisted state records the upstream as unavailable, not as a successful baseline

### Requirement: Monotonic per-recipient cursors

Per-recipient cursors SHALL never move backwards, including across out-of-order urgency claims (#298).

#### Scenario: Out-of-order urgency claims

- **WHEN** a recipient's claims for different urgencies complete out of order
- **THEN** that recipient's cursor never regresses to an earlier position

### Requirement: Empty reminders are suppressed

A reminder whose unread set emptied before delivery SHALL be suppressed, not delivered (#473).

#### Scenario: Unread set empties before delivery

- **WHEN** every event behind a pending reminder is acknowledged before the reminder is delivered
- **THEN** no reminder with `event_count=0` is delivered

### Requirement: Monitor edits never rewrite materialized events

Editing a monitor SHALL NOT retroactively change the urgency, body, or other content of events already materialized from it (#451).

#### Scenario: Urgency edited while events are pending

- **GIVEN** pending events materialized from a monitor at urgency `normal`
- **WHEN** the monitor's `MONITOR.md` is edited to urgency `high` and a new body
- **THEN** the already-materialized pending events keep urgency `normal` and their original body

### Requirement: Transport-health surfaces report the truth

Transport-health surfaces (including `agentmonitors doctor`) SHALL report the true transport state and SHALL NOT present a verdict that contradicts it (#462–#465).

#### Scenario: Ended session's channel heartbeat

- **WHEN** a within-TTL channel heartbeat belongs to an ended session while the delivery verdict is healthy
- **THEN** `doctor` does not hard-fail the channel transport on that heartbeat alone

### Requirement: Crash-into-restart durable-state truthfulness

If the daemon is killed at any point in ingest → materialize → project → deliver, durable state on restart SHALL be either complete or truthfully marked failed, never silently partial.

#### Scenario: Kill at each pipeline stage

- **WHEN** the daemon is killed during ingest, materialization, projection, or delivery, and then restarted
- **THEN** each affected observation, event, projection, and delivery is either complete or truthfully marked failed
