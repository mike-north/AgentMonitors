# inbox/legacy-inbox Specification

## Purpose

Defines the legacy inbox: an item state machine stored in `inbox_items` and its `agentmonitors inbox` command surface. It remains public and implemented but is not the authoritative monitor-delivery path, which is the runtime/session pipeline of the `delivery/session-projection` and `delivery/lifecycles` capabilities (per AP1, AP2).

## Requirements

### Requirement: Inbox item state machine

Inbox items SHALL follow `queued → acked → in-progress → completed|failed → archived`. The only valid transitions SHALL be: `queued` → `acked`; `acked` → `in-progress`; `in-progress` → `completed` or `failed`; `completed` → `archived`; `failed` → `archived`. `archived` SHALL be terminal. A new item SHALL start `queued`.

#### Scenario: Skipping a state is rejected

- **GIVEN** an inbox item in state `queued`
- **WHEN** it is transitioned to `in-progress`
- **THEN** the transition fails with `Invalid state transition: cannot move from "queued" to "in-progress"`
- **AND** the item stays `queued`

#### Scenario: Unknown item is rejected

- **WHEN** a transition is requested for id `01UNKNOWN`
- **THEN** it fails with `Inbox item not found: 01UNKNOWN`

### Requirement: Inbox is not the authoritative delivery path

The inbox lifecycle SHALL operate only on `inbox_items` and SHALL NOT share rows with `monitor_events` or drive `session_event_state`. Monitor-triggered delivery SHALL use the runtime/session pipeline; inbox items are not created by the runtime tick loop (per AP2).

#### Scenario: Monitor event does not create an inbox item

- **WHEN** a monitor materializes an event and it is projected into a session
- **THEN** no `inbox_items` row is created

### Requirement: Inbox commands run in process

Every `agentmonitors inbox` subcommand SHALL operate in-process against the local SQLite database resolved per the `cli/conventions` capability, and SHALL NOT require the daemon socket.

#### Scenario: Inbox works with no daemon running

- **GIVEN** no daemon is running
- **WHEN** `agentmonitors inbox list` runs
- **THEN** it reads `inbox_items` directly and succeeds

### Requirement: inbox list filters

`agentmonitors inbox list` SHALL accept `--state` (`queued`, `acked`, `in-progress`, `completed`, `failed`, `archived`), `--urgency` (`low`, `normal`, `high`), `--tags <tags>` (comma-separated), `--monitor <id>`, `--since <date>` and `--until <date>` (ISO 8601; created after/before), and `--format` (`text` or `json`, default `text`). Results SHALL be ordered newest first.

#### Scenario: Filter by state and urgency

- **GIVEN** items `A` (`queued`, `high`) and `B` (`acked`, `high`)
- **WHEN** `inbox list --state queued --urgency high` runs
- **THEN** only `A` is listed

### Requirement: inbox list output

In `text` format `inbox list` SHALL print one line per item as `[<state>] <id>  <title>  (<urgency>)`, or `No inbox items found.` when none match. In `json` format it SHALL print the raw `InboxItem[]` array as JSON.

#### Scenario: Text line format

- **GIVEN** a `queued` item `01ABC` titled `Build failed` with urgency `high`
- **WHEN** `inbox list` runs
- **THEN** it prints `[queued] 01ABC  Build failed  (high)`

### Requirement: inbox list rejects invalid dates

`inbox list` SHALL validate `--since` and `--until` as dates; an invalid value SHALL report `--since must be a valid ISO 8601 date.` (or the `--until` equivalent) — to stderr as `Error: <message>` in text format, or as `{"error":"<message>"}` on stdout in json format — set exit code 1, and SHALL NOT query.

#### Scenario: Invalid since date

- **WHEN** `inbox list --since not-a-date` runs
- **THEN** stderr shows `Error: --since must be a valid ISO 8601 date.` and the exit code is 1

### Requirement: inbox ack

`agentmonitors inbox ack <id>` SHALL transition the item from `queued` to `acked`, record `acked_at`, and print `Acknowledged: <id>`.

#### Scenario: Acknowledge a queued item

- **GIVEN** item `01ABC` is `queued`
- **WHEN** `inbox ack 01ABC` runs
- **THEN** it prints `Acknowledged: 01ABC` and the item is `acked`

### Requirement: inbox start

`agentmonitors inbox start <id>` SHALL transition the item to `in-progress` and print `Started: <id>`.

#### Scenario: Start an acked item

- **GIVEN** item `01ABC` is `acked`
- **WHEN** `inbox start 01ABC` runs
- **THEN** it prints `Started: 01ABC` and the item is `in-progress`

### Requirement: inbox complete

`agentmonitors inbox complete <id>` SHALL transition the item to `completed`, record `completed_at`, and print `Completed: <id>`.

#### Scenario: Complete an in-progress item

- **GIVEN** item `01ABC` is `in-progress`
- **WHEN** `inbox complete 01ABC` runs
- **THEN** it prints `Completed: 01ABC` and the item is `completed`

### Requirement: inbox fail

`agentmonitors inbox fail <id> [--error <message>]` SHALL transition the item to `failed` and print `Failed: <id>`. When `--error` is given, the message SHALL be stored on the item by appending `Error: <message>` to its body, separated from any existing body by `\n\n---\n\n`.

#### Scenario: Fail with an error message

- **GIVEN** item `01ABC` is `in-progress` with body `Run tests`
- **WHEN** `inbox fail 01ABC --error timeout` runs
- **THEN** it prints `Failed: 01ABC` and the body becomes `Run tests\n\n---\n\nError: timeout`

### Requirement: inbox archive

`agentmonitors inbox archive <id>` SHALL transition a `completed` or `failed` item to `archived` and print `Archived: <id>`.

#### Scenario: Archive a failed item

- **GIVEN** item `01ABC` is `failed`
- **WHEN** `inbox archive 01ABC` runs
- **THEN** it prints `Archived: 01ABC` and the item is `archived`

### Requirement: Inbox transition failures exit 1

When `ack`, `start`, `complete`, `fail`, or `archive` fails (invalid transition or item not found), the command SHALL print `Error: <message>` to stderr and set exit code 1.

#### Scenario: Archiving a queued item fails

- **GIVEN** item `01ABC` is `queued`
- **WHEN** `inbox archive 01ABC` runs
- **THEN** stderr shows `Error: Invalid state transition: cannot move from "queued" to "archived"` and the exit code is 1
