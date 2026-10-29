## Purpose

The observability surface lets an agent or human operator inspect, per session, three distinct
states of its signals — received, pending, and armed-but-not-yet-fired — through a single pure-read
`inspect` verb derived from durable state the runtime already records, with no new watching.

## ADDED Requirements

### Requirement: Three distinct signal states

The observability surface SHALL report, for a session, three distinct states: **received** (events delivered/surfaced as claimed, or acknowledged), **pending** (durable events that are unread — fired, waiting), and **armed-but-not-yet-fired** (a condition the daemon has detected but has not yet delivered because a hold mechanism is holding it). These MUST NOT be merged; in particular armed MUST NOT be folded into pending.

#### Scenario: Armed then pending then received

- **GIVEN** a monitor with a debounce `settle-for` window and session `S1`
- **WHEN** a change is detected inside the settle window
- **THEN** `inspect --session S1` lists it in the **armed** bucket only
- **AND** once the window elapses and the event fires, it appears in **pending** only
- **AND** once it is claimed by a delivery, it appears in **received** only — three separately asserted transitions

#### Scenario: Rollup and suppression holds are armed

- **WHEN** a change is held by a scheduled-rollup window not yet open, or by a recorded `net` or Interpret suppression
- **THEN** it appears in the **armed** bucket, not in pending

### Requirement: Armed set derived from existing hold substrate

A condition SHALL be reported as armed when a source observation has detected a change and delivery is held by one of the runtime's already-recorded hold mechanisms. The armed set MUST be derived only from that existing durable substrate, scoped to the session's monitors, and MUST introduce no new watching (PP9).

#### Scenario: High-urgency settle window

- **WHEN** a `high`-urgency event is younger than `DEFAULT_HIGH_URGENCY_SETTLE_MS` (15 s)
- **THEN** it is armed with the high-urgency settle hold reason

#### Scenario: Debounce batch

- **WHEN** `monitor_state.notify_state` records a pending debounce `settle-for` batch
- **THEN** the batched change is armed with the debounce hold reason

#### Scenario: Throttle window

- **WHEN** `monitor_state.notify_state` records an active throttle `suppress-for` window holding a change
- **THEN** the change is armed with the throttle hold reason

#### Scenario: Scheduled rollup

- **WHEN** `notify_state.pendingRollup` holds a batch whose rollup `window` has not yet opened
- **THEN** the batch is armed with the rollup hold reason

#### Scenario: net intermediate collapse

- **WHEN** a session's `session_event_state.net_suppressed_at` is set for an event
- **THEN** it is armed with the `net` collapse hold reason

#### Scenario: Interpret significance suppression

- **WHEN** a session's `session_event_state.interpret_*` fields record an Interpret significance suppression
- **THEN** it is armed with the Interpret suppression hold reason

#### Scenario: No source observation during inspect

- **WHEN** `inspect` runs
- **THEN** no source `observe()` is invoked

### Requirement: Recorded suppressions reported as met and held

A recorded suppression (`net` collapse or Interpret significance suppression) SHALL be reported as met-and-deliberately-held, never as "not met", preserving the "why nothing fired is inspectable" honesty invariant (PP7, C12).

#### Scenario: Interpret-suppressed change

- **WHEN** Interpret judged a detected change not significant and suppressed it
- **THEN** `inspect` reports the change as detected and deliberately held by Interpret suppression, not as absent

### Requirement: Inspect returns all three buckets in one read

`agentmonitors inspect [--session <id>]` SHALL return the received, pending, and armed buckets for a session in a single read.

#### Scenario: One call, three buckets

- **WHEN** `inspect --session S1` runs for a session with one received, one pending, and one armed signal
- **THEN** a single response contains all three buckets, each holding its one entry

### Requirement: Inspect is a pure read

`inspect` MUST NOT claim, acknowledge, or advance any cursor; the unread / claimed / acknowledged state (SP4) MUST be unchanged by it.

#### Scenario: State unchanged after inspect

- **WHEN** `inspect --session S1` runs
- **THEN** `S1`'s `session_event_state` and `session_object_cursor` rows are byte-identical before and after

### Requirement: Armed entries report hold reason and earliest fire time

For each armed entry, `inspect` SHALL report the hold reason (which hold mechanism) and, where deterministic, the earliest time it could fire (e.g. settle-window expiry, next rollup window opening), so the agent learns that a change is coming and roughly when without polling.

#### Scenario: Settle-window expiry reported

- **GIVEN** a `high`-urgency event detected at `T`
- **WHEN** `inspect` runs at `T + 5s`
- **THEN** the armed entry reports the high-urgency settle hold reason and an earliest fire time of `T + 15s`

#### Scenario: Non-deterministic fire time omitted

- **WHEN** an armed entry is held by a mechanism with no deterministic release time
- **THEN** the entry reports its hold reason without an earliest fire time

### Requirement: Inspect covers ephemeral and persistent monitors identically

`inspect` MUST cover ephemeral monitors (per the `agent/ephemeral-monitors` capability) and persistent monitors identically (AP7).

#### Scenario: Ephemeral watch held in a settle window

- **WHEN** a session's ephemeral watch detects a change inside its settle window
- **THEN** `inspect` for that session reports it in the armed bucket exactly as it would for a persistent monitor

### Requirement: Inspect is invoked only on signal or turn boundary

`inspect` MUST NOT cause the agent to poll, block, or run a background waiting loop; an agent SHALL invoke it only in response to a pushed signal or at its own turn boundary, never on a timer of its own (PP9). It returns the current durable answer immediately, stays local-only, and MUST NOT imply an internet-visible or cloud-agent-waking path (NP5).

#### Scenario: Returns immediately

- **WHEN** `inspect` runs while a change is armed
- **THEN** it returns the current buckets immediately rather than waiting for the armed change to fire

### Requirement: inspect command surface

The CLI SHALL expose `agentmonitors inspect [--session <id>] [--socket <path>] [--format <format>]`, round-tripping the daemon and supporting the standard `--format` shapes (per the `cli/conventions` capability).

#### Scenario: JSON output

- **WHEN** `inspect --session S1 --format json` runs
- **THEN** stdout is JSON with separate received, pending, and armed collections
