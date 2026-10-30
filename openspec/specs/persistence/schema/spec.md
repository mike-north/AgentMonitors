# persistence/schema Specification

## Purpose

Defines the normative SQLite persistence schema shared by the runtime and the legacy inbox: each persisted table's load-bearing columns, keys, and invariants that make monitor state, events, snapshots, per-session delivery state, and audit history restart-safe and isolated by workspace and session. Behavior that reads or writes these tables is owned by the referenced runtime and delivery capabilities.

## Requirements

### Requirement: Storage conventions

Persisted tables SHALL use SQLite snake_case column names. Every row `id` SHALL be a ULID text primary key. Every timestamp SHALL be a SQLite `INTEGER` holding Unix epoch seconds. JSON-valued columns SHALL be stored as `TEXT`. Schema upgrades SHALL be additive (adding missing columns in place) except where a requirement below defines a rebuild.

#### Scenario: Timestamps are epoch seconds

- **WHEN** an event is materialized at `2026-01-15T10:30:00.500Z`
- **THEN** its `created_at` is stored as the integer `1768473000`

#### Scenario: Older database gains new columns on open

- **GIVEN** a database whose `session_event_state` lacks `diff_text`
- **WHEN** the runtime opens it
- **THEN** `diff_text` is added and existing rows keep `NULL` there

### Requirement: monitor_events identity and content columns

`monitor_events` SHALL hold one row per materialized observation with: `id` TEXT PK; `workspace_path` TEXT nullable (`NULL` = global event); `monitor_id`, `source_name` TEXT NOT NULL; `urgency` TEXT NOT NULL (`low | normal | high`); `title` TEXT NOT NULL; `body`, `summary` TEXT NOT NULL default `''`; `payload` TEXT NOT NULL JSON default `{}`; `tags` TEXT NOT NULL JSON array default `[]`; `created_at` INTEGER NOT NULL (observation time).

#### Scenario: Global event has a null workspace

- **WHEN** an event is materialized without a workspace
- **THEN** its `workspace_path` is `NULL`

### Requirement: monitor_events snapshot and scope columns

`monitor_events` SHALL also have: `snapshot_metadata` TEXT NOT NULL JSON default `{}`; `snapshot_text` TEXT nullable (full snapshot content when provided); `diff_text` TEXT nullable (line-level diff vs. the previous snapshot); `object_key` TEXT nullable (snapshot and diff keying); `baseline_strategy` TEXT nullable (`NULL` treated as `incremental`); `query_scope` TEXT NOT NULL JSON default `{}`.

#### Scenario: Legacy event has no baseline strategy

- **GIVEN** an event row written before `baseline_strategy` existed
- **WHEN** it is claimed
- **THEN** it is treated as `incremental`

### Requirement: monitor_events rows are not updated after insertion

`monitor_events` rows SHALL NOT be updated after insertion; per-session delivery state lives in `session_event_state`, never on the event row.

#### Scenario: Claiming does not touch the event row

- **WHEN** an event is claimed and later acknowledged by a session
- **THEN** the `monitor_events` row is byte-identical to its inserted state

### Requirement: monitor_snapshots table

`monitor_snapshots` SHALL store each snapshot's full text for diff computation, keyed by `(workspace_path, monitor_id, object_key)`, with: `id` TEXT PK; `workspace_path` TEXT nullable; `monitor_id`, `object_key` TEXT NOT NULL; `event_id` TEXT NOT NULL (refers to `monitor_events.id`); `content` TEXT NOT NULL; `created_at` INTEGER NOT NULL (epoch seconds). Snapshots SHALL be isolated per that key (per SP5).

#### Scenario: Snapshots are isolated by workspace, monitor, and object key

- **GIVEN** snapshots for `(/a, m, k)`, `(/b, m, k)`, `(/a, m2, k)`, and `(/a, m, k2)`
- **WHEN** the latest snapshot for `(/a, m, k)` is read
- **THEN** only the `(/a, m, k)` snapshot is returned

### Requirement: monitor_snapshots ordering is total

`monitor_snapshots.id` SHALL be a monotonic ULID, strictly increasing in insertion order, and the latest snapshot for a key SHALL be selected by `created_at DESC, id DESC`, so same-second snapshots keep their materialization order (issue #293).

#### Scenario: Same-second snapshots resolve to the newest

- **GIVEN** two snapshots for the same key inserted within one second
- **WHEN** the latest snapshot is read
- **THEN** the second-inserted snapshot is returned

### Requirement: materialization_retry_outbox columns

`materialization_retry_outbox` SHALL durably hold observations that failed materialization, with: `id` TEXT PK (monotonic ULID); `workspace_path` TEXT nullable; `monitor_id`, `source_name` TEXT NOT NULL; `envelope` TEXT NOT NULL (JSON); `envelope_bytes`, `attempt_count` INTEGER NOT NULL; `status` TEXT NOT NULL (`pending | terminal`); `next_attempt_at` INTEGER nullable; `last_error` TEXT nullable; `created_at`, `updated_at` INTEGER NOT NULL.

#### Scenario: Outbox survives reopen

- **GIVEN** two envelopes enqueued for monitor `m`
- **WHEN** the database is closed and reopened
- **THEN** both are read back oldest-first with their route and envelope intact

### Requirement: Retry outbox admission is bounded and batch-atomic

The outbox SHALL admit at most 256 rows or 8 MiB of stored envelopes (exact serialized UTF-8 bytes) per `(workspace_path, monitor_id)`, counting terminal rows. A batch enqueue SHALL run in one immediate transaction: when any failed sibling cannot fit, none is stored. Each workspace and monitor SHALL have independent capacity.

#### Scenario: Overflowing batch stores nothing

- **GIVEN** monitor `m` has room for one more envelope and a batch of two arrives
- **WHEN** the batch is enqueued
- **THEN** neither envelope is stored, and another monitor's capacity is unaffected

### Requirement: Retry envelopes are validated plain data

Enqueue SHALL accept only ordinary plain-data records and dense arrays of JSON primitives, plus one `observedAt` that is a valid, unmodified `Date` (serialized as ISO text, restored as a `Date`). It SHALL reject detectable violations (BigInt, negative zero, nested Dates, proxies, accessors, cycles, built-in brands) with a domain error before any database mutation, validating the whole envelope before route fields and never running proxy traps or getters.

#### Scenario: Lossy value rejects the whole batch

- **GIVEN** a batch whose second envelope's payload contains negative zero
- **WHEN** the batch is enqueued
- **THEN** a domain error is raised and no envelope from the batch is stored

#### Scenario: Proxy is rejected without running traps

- **WHEN** an envelope whose payload is a proxy is enqueued
- **THEN** it is rejected with a domain error and none of the proxy's traps run

### Requirement: Retry records are scheduled and carry safe errors

A new outbox record SHALL first become due 1 second after enqueue, and records SHALL be read oldest-first. `last_error` SHALL have terminal control characters (C0 and DEL) removed and SHALL be capped at 1,024 characters.

#### Scenario: Unsafe error text is sanitized

- **WHEN** a record is stored with a 2,000-character error containing an ANSI escape
- **THEN** `last_error` has no control characters and is at most 1,024 characters

### Requirement: session_event_state delivery-state columns

`session_event_state` SHALL hold one row per (session, projected event) with: `id` TEXT PK; `session_id` TEXT NOT NULL (refers to `agent_sessions.id`); `event_id` TEXT NOT NULL (refers to `monitor_events.id`); `first_notified_at` INTEGER nullable (`NULL` = pending); `acknowledged_at` INTEGER nullable (`NULL` = unread); `last_claim_at` INTEGER nullable; `last_claim_lifecycle` TEXT nullable; `created_at`, `updated_at` INTEGER NOT NULL.

#### Scenario: Delivery state survives a daemon restart

- **GIVEN** session S claimed event E but has not acknowledged it
- **WHEN** the daemon restarts
- **THEN** E is still claimed and unread for S

### Requirement: session_event_state per-recipient columns

`session_event_state` SHALL also have: `diff_text` TEXT nullable (per-recipient delta; `NULL` falls back to `monitor_events.diff_text`); `interpret_decision` TEXT nullable (`deliver | suppress | failed`; `NULL` for non-`prose` monitors); `interpret_reason` TEXT nullable; `interpret_digest` TEXT nullable (delivered digest when decision is `deliver`); `net_suppressed_at` INTEGER nullable (claimed-but-suppressed `net` intermediate, excluded from delivery).

#### Scenario: Net-suppressed intermediate is retained but not delivered

- **GIVEN** a row with `net_suppressed_at` set
- **WHEN** the session's unread events are listed for delivery
- **THEN** the row is excluded but still exists for `monitor explain`

### Requirement: session_object_cursor table

`session_object_cursor` SHALL hold one row per `(session_id, monitor_id, object_key, workspace_path)`, unique on those columns with `COALESCE(workspace_path, '')`, with `id` TEXT PK, `baseline_snapshot_id` TEXT nullable, `baseline_content` TEXT NOT NULL default `''` (the denormalized full artifact, so the baseline is prune-immune), and `updated_at` INTEGER NOT NULL (set on seed and each claim-advance). It survives restarts (per PP1).

#### Scenario: Global session gets one cursor per object

- **GIVEN** a global session (`workspace_path` `NULL`)
- **WHEN** its cursor for `(monitor m, object k)` is seeded twice
- **THEN** exactly one `session_object_cursor` row exists for that key

### Requirement: agent_sessions identity columns

`agent_sessions` SHALL hold one row per known agent session, upserted on open by the `(adapter, host_session_id)` pair, with: `id` TEXT PK; `adapter` TEXT NOT NULL (e.g. `claude-code`); `host_session_id` TEXT NOT NULL; `agent_identity` TEXT NOT NULL; `role` TEXT NOT NULL (`lead | subagent`, default `lead`); `workspace_path` TEXT nullable (`NULL` = global session); `hook_state_path` TEXT NOT NULL (absolute path).

#### Scenario: Role defaults to lead

- **WHEN** a session is opened without a role
- **THEN** its `role` is `lead`

### Requirement: agent_sessions lifecycle columns

`agent_sessions` SHALL also have: `status` TEXT NOT NULL (`active | dormant`); `baseline_at` INTEGER NOT NULL (session open time, used for event baseline filtering); `last_active_at` INTEGER NOT NULL (updated on each session touch); `last_recap_at` INTEGER nullable (set when a recap is delivered); `dormant_at` INTEGER nullable (set when the session goes dormant); `created_at`, `updated_at` INTEGER NOT NULL.

#### Scenario: Recap records its time

- **WHEN** a post-compact recap is claimed for session S
- **THEN** S's `last_recap_at` is set

### Requirement: monitor_state is keyed per monitor and workspace

`monitor_state` SHALL hold one row per `(monitor_id, workspace_path)` scope, never per monitor id alone, with a surrogate `id` TEXT PK and a UNIQUE index on `(monitor_id, COALESCE(workspace_path, ''))`. Columns: `last_observation_at` INTEGER nullable; `last_fingerprint` TEXT nullable (reserved, not written); `source_state` TEXT NOT NULL JSON (source-owned); `notify_state` TEXT NOT NULL JSON (`NotifyRuntimeState`); `updated_at` INTEGER NOT NULL.

#### Scenario: Same monitor id in two workspaces does not share a baseline

- **GIVEN** monitor id `my-first-monitor` exists in `/a` (watching file `x`) and in `/b` (no file `x`)
- **WHEN** both workspaces tick
- **THEN** `/b` reports no `deleted` or `descoped` change for `x` (issue #345 / #307)

#### Scenario: Source state survives runtime restart

- **GIVEN** a stateful source persisted its `source_state` and the runtime is restarted
- **WHEN** the source later observes a change
- **THEN** it diffs against the persisted state and emits the change

### Requirement: Legacy monitor_state is rebuilt with notify state preserved

On the first open of a database whose `monitor_state` predates workspace scoping, the runtime SHALL rebuild the table once: `source_state` SHALL be reset so each monitor re-baselines with no spurious created/deleted/descoped events, while `notify_state` SHALL be preserved and re-inserted into the correctly-scoped rows, deriving each batched observation's workspace from its monitor `filePath`.

#### Scenario: Pending debounce batch survives the upgrade

- **GIVEN** a legacy `monitor_state` row whose `notify_state.pendingDebounce` holds an already-detected observation
- **WHEN** the upgraded runtime opens the database and the observation's workspace next ticks
- **THEN** that batch is flushed and delivered, not lost

#### Scenario: Re-baseline emits no spurious events

- **GIVEN** a legacy `monitor_state` row with a non-empty `source_state`
- **WHEN** the monitor first ticks after the upgrade
- **THEN** the source establishes a fresh baseline and emits no created, deleted, or descoped events

### Requirement: observation_history columns

`observation_history` SHALL hold one row per due monitor per tick with: `id` TEXT PK; `monitor_id` TEXT NOT NULL; `workspace_path` TEXT nullable (observing workspace; `NULL` on pre-namespacing rows); `source_name` TEXT NOT NULL; `observation_data` TEXT NOT NULL JSON; `result` TEXT NOT NULL (`triggered | suppressed | no-change | no-files-matched | errored | rebaselined`); `created_at` INTEGER NOT NULL.

#### Scenario: Legacy table gains workspace_path additively

- **GIVEN** an `observation_history` table without `workspace_path`
- **WHEN** the runtime opens the database
- **THEN** the column is added in place and existing rows keep `NULL`

### Requirement: Observation outcomes for emitted or held observations

`result` SHALL be `triggered` when at least one event was emitted (including a tick that flushes a held debounce batch with no new observations), and `suppressed` when observations were returned but none emitted (throttled or held in a debounce batch); `observation_data` is `{ observed, emitted }` for both.

#### Scenario: Debounced observation is suppressed

- **WHEN** a tick returns 2 observations that are held in a debounce batch
- **THEN** the history row has `result` `suppressed` and `observation_data` `{ "observed": 2, "emitted": 0 }`

### Requirement: Observation outcomes for empty observations

`result` SHALL be `no-change` when the source returned no observations and no special outcome; `no-files-matched` when it returned none and signalled that its file-system scope matched zero files; and `rebaselined` only when the source set `ObservationResult.outcome: 'rebaselined'`, returned zero observations, and nothing was emitted. Each records `{ observed: 0, emitted: 0 }`.

#### Scenario: Rebaselined diagnostic with observations is recorded as suppressed

- **GIVEN** a source sets `outcome: 'rebaselined'` but also returns observations that are held
- **WHEN** the tick is recorded
- **THEN** `result` is `suppressed`, not `rebaselined`

#### Scenario: Zero files matched

- **WHEN** a file source's globs match no files and it signals `no-files-matched`
- **THEN** `result` is `no-files-matched` rather than `no-change`

### Requirement: Errored observations are isolated and recorded

`result` SHALL be `errored`, with `observation_data` `{ error: "<message>" }`, when `observe()` throws (persisted `source_state` left unchanged), when one observation fails to materialize (rolled back whole per `runtime/event-materialization`; siblings unaffected; only committed event ids reported), or when schedule evaluation fails, e.g. an invalid timezone (per `runtime/tick-scheduling`). The tick or watcher SHALL continue, and a failing history write SHALL be swallowed (issue #46).

#### Scenario: Throwing source does not abort the tick

- **GIVEN** monitors `a` and `b` are due and `a`'s `observe()` throws `"boom"`
- **WHEN** the tick runs
- **THEN** `a`'s history row has `result` `errored` and `observation_data` `{ "error": "boom" }`
- **AND** `b` is evaluated normally and `a`'s `source_state` is unchanged

### Requirement: Observation history is workspace-scoped for scoped readers

Each `observation_history` row SHALL record its tick's `workspace_path`. Workspace-scoped readers (`monitor explain`, `doctor`, `monitor history --workspace`) SHALL filter by exact workspace, so legacy `NULL` rows fall out of scoped queries; an unscoped `monitor history` SHALL read across all workspaces.

#### Scenario: Same-id monitor history does not leak across workspaces

- **GIVEN** monitor id `m` has history rows in `/a` and `/b`
- **WHEN** `monitor history --workspace /a` runs
- **THEN** only `/a` rows are shown

### Requirement: inbox_items table

`inbox_items` SHALL be the legacy inbox table, independent of `monitor_events` (no shared rows), with: `id` TEXT PK; `session_id` TEXT nullable; `monitor_id` TEXT NOT NULL; `state` TEXT NOT NULL (`queued | acked | in-progress | completed | failed | archived`); `urgency` TEXT NOT NULL; `title`, `body` TEXT NOT NULL; `snapshot` TEXT NOT NULL JSON; `tags` TEXT NOT NULL JSON array; `created_at`, `updated_at` INTEGER NOT NULL; `acked_at`, `completed_at` INTEGER nullable.

#### Scenario: Inbox writes do not touch runtime tables

- **WHEN** an inbox item is enqueued and transitioned
- **THEN** no `monitor_events` or `session_event_state` row is created

### Requirement: ephemeral_monitors table

`ephemeral_monitors` SHALL durably hold agent-declared monitors with: `id` TEXT PK (`ephemeral:<sessionId>/<ulid>`); `session_id`, `source_name` TEXT NOT NULL; `workspace_path` TEXT nullable; `scope` TEXT NOT NULL JSON default `{}`; `urgency`, `urgency_max` TEXT NOT NULL; `instruction` TEXT NOT NULL default `''`; `display_name` TEXT nullable; `status` TEXT NOT NULL (`active | reaped`, default `active`); `created_at`, `updated_at` INTEGER NOT NULL; `reaped_at` INTEGER nullable.

#### Scenario: Reaped ephemeral monitor is retained

- **WHEN** an ephemeral monitor's session goes dormant and it is reaped
- **THEN** its row remains with `status` `reaped` and `reaped_at` set, so a restart cannot re-arm it

### Requirement: object_event_suppressions table

`object_event_suppressions` SHALL hold durable, self-expiring tombstones for synthetic object keys with: `id` TEXT PK; `monitor_id`, `object_key` TEXT NOT NULL; `workspace_path` TEXT nullable; `reason` TEXT NOT NULL default `verify-scratch`; `created_at`, `expires_at` INTEGER NOT NULL. An expired tombstone SHALL be purged (issue #414).

#### Scenario: Expired tombstone is purged

- **GIVEN** a tombstone whose `expires_at` is in the past
- **WHEN** the daemon ticks
- **THEN** the tombstone is removed
