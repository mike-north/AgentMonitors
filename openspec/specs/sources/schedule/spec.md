# sources/schedule Specification

## Purpose

The bundled `schedule` observation source (`@agentmonitors/source-schedule`): a stateless source that
emits one trigger observation each time the runtime invokes it for a cron-scheduled monitor. Deciding
when the schedule is due belongs to the runtime per the `runtime/tick-scheduling` capability (SP1).

## Requirements

### Requirement: schedule source name and scope

The system SHALL register the bundled source under the name `schedule`. Its scope SHALL require `cron` (string) and accept optional `timezone` (string) and `label` (string). When `cron` is absent or not a string, `observe()` SHALL throw `scope.cron must be a string`.

#### Scenario: Missing cron throws clearly

- **WHEN** a `schedule` monitor's `watch:` block omits `cron`
- **THEN** `observe()` throws `scope.cron must be a string`

#### Scenario: Full scope is accepted

- **WHEN** a monitor declares `watch: { type: schedule, cron: '0 9 * * 1-5', timezone: America/Los_Angeles, label: Daily review }`
- **THEN** the scope is valid

### Requirement: schedule source is stateless

The `schedule` source SHALL NOT declare `stateful`, and SHALL therefore be treated as stateless per the `sources/contract` capability.

#### Scenario: No baseline run

- **WHEN** a `schedule` monitor is observed for the first time
- **THEN** it emits its trigger observation immediately; there is no silent baseline run

### Requirement: schedule emits exactly one observation per invocation

The `schedule` source SHALL NOT decide whether it is due; whenever `observe()` is called it SHALL emit exactly one observation.

#### Scenario: Fires whenever invoked

- **WHEN** the runtime calls `observe()` for a `schedule` monitor
- **THEN** the result contains exactly one observation

### Requirement: schedule observation shape

The trigger observation SHALL carry `title` and `summary` equal to `label` when provided, otherwise `Scheduled trigger: <cron>`; `payload` `{ cron, timezone }`; `objectKey` `<cron>`; `queryScope` `{ cron, timezone }`; and `snapshot` `{ cron, timezone, triggeredAt }` where `triggeredAt` is `context.now` as an ISO-8601 string. `timezone` SHALL resolve to `UTC` when not configured.

#### Scenario: Unlabeled schedule without timezone

- **WHEN** `cron: '0 9 * * 1-5'` with no `label` or `timezone` is observed at `2024-01-15T09:00:00.000Z`
- **THEN** `title` and `summary` are `Scheduled trigger: 0 9 * * 1-5`
- **AND** `payload` is `{ cron: '0 9 * * 1-5', timezone: 'UTC' }` and `objectKey` is `0 9 * * 1-5`
- **AND** `snapshot.triggeredAt` is `2024-01-15T09:00:00.000Z`

#### Scenario: Label replaces the default title

- **WHEN** the scope sets `label: Daily review`
- **THEN** `title` and `summary` are `Daily review`

### Requirement: schedule timezone is validated at authoring time, not by the plugin

The plugin SHALL NOT validate the IANA timezone at observe time; the scheduling engine owns timezone interpretation. A present `timezone` MUST be a name `Intl.DateTimeFormat` accepts (issue #297), enforced by the source-agnostic scope validation used by `agentmonitors validate`, `monitor test`, and `watch declare` (diagnosis text per the `monitor/validation` capability), which SHALL reject an invalid value with an actionable error.

#### Scenario: Invalid timezone rejected by validate

- **WHEN** a `schedule` monitor declares `timezone: Mars/Olympus_Mons` and `agentmonitors validate` runs
- **THEN** validation fails with an actionable timezone error before the monitor is ever ticked

#### Scenario: Valid IANA timezone accepted

- **WHEN** a `schedule` monitor declares `timezone: America/New_York`
- **THEN** validation passes

### Requirement: Tick does not re-validate schedule scope

The runtime tick SHALL NOT run authoring-time scope validation; a hand-edited `MONITOR.md` with an invalid `timezone` that skipped `validate` SHALL still reach the runtime, where per-monitor defensive isolation per the `runtime/tick-scheduling` capability is the last line of defense.

#### Scenario: Bad timezone bypassing validate is isolated at tick time

- **WHEN** a `MONITOR.md` with `timezone: Not/AZone` is ticked without having been validated
- **THEN** the tick reaches that monitor and any resulting failure is isolated to it, without aborting other monitors in the tick
