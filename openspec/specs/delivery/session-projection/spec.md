# delivery/session-projection Specification

## Purpose

Defines how materialized monitor events become per-session work: which agent sessions an event projects into, how sessions are identified, resumed, and made dormant, the per-session unread/claimed/acknowledged delivery state (SP4), and the per-session hook-state file that mirrors pending work. Delivery timing at lifecycle points is owned by the `delivery/lifecycles` capability.

## Requirements

### Requirement: Events project into lead sessions only

When an event is inserted into `monitor_events`, the runtime SHALL project it, via one `session_event_state` row per recipient, into matching sessions whose `role` is `lead` only. Subagent sessions SHALL be tracked in `agent_sessions` but SHALL NOT receive automatic event projection. Persisted events are not tied to one session; projection is the only path from an event to a session.

#### Scenario: Subagent session does not receive a projected event

- **GIVEN** a lead session and a subagent session are both open in workspace `W`
- **WHEN** a monitor in workspace `W` materializes an event
- **THEN** a `session_event_state` row is created for the lead session
- **AND** no `session_event_state` row is created for the subagent session

### Requirement: Projection matches the event workspace or global sessions

An event whose `workspace_path` is `W` SHALL project into lead sessions whose `workspacePath` equals `W` and into lead sessions whose `workspacePath` is `null` (global visibility). It SHALL NOT project into lead sessions bound to any other workspace.

#### Scenario: Events project only into matching workspace sessions

- **GIVEN** lead session A with `workspacePath` `/repo-a`, lead session B with `workspacePath` `/repo-b`, and lead session G with `workspacePath` `null`
- **WHEN** an event is materialized with `workspace_path` `/repo-a`
- **THEN** sessions A and G each receive a `session_event_state` row
- **AND** session B receives none

### Requirement: Projection records a per-recipient delta

During projection the runtime SHALL diff the shared event's shaped artifact against the recipient session's own baseline cursor (`session_object_cursor`, per the `pipeline/post-processing` capability) and record the result on that recipient's `session_event_state.diff_text`. The per-recipient `diff_text` SHALL be durable in the same projection step, before any Interpret work is awaited.

#### Scenario: Two recipients at different baselines record different deltas

- **GIVEN** sessions S1 and S2 both receive projections for object `k` of monitor `m`, and S1 has claimed an earlier event for `k` while S2 has not
- **WHEN** a new event for `k` is projected into both sessions
- **THEN** each session's `session_event_state.diff_text` spans from its own baseline cursor to the new artifact
- **AND** the shared `monitor_events` row is unchanged

### Requirement: First projection seeds a late joiner's cursor

A session's first projection of an object SHALL seed its `session_object_cursor` to the pre-event state, so a session that registers after an object already exists hears only changes made after it registered.

#### Scenario: Late-joining session hears only later changes

- **GIVEN** object `k` has a stored artifact from before session S was opened
- **WHEN** the first event for `k` after S opened is projected into S
- **THEN** S's cursor is seeded to the pre-event artifact
- **AND** S's `diff_text` covers only the change in that event

### Requirement: Claiming advances the recipient cursor

When a recipient claims an event, the runtime SHALL advance that recipient's `session_object_cursor` to the artifact the recipient was shown. Cursors SHALL persist across session dormancy and daemon restarts (per PP1).

#### Scenario: Cursor advances to the claimed artifact

- **WHEN** session S claims a delivery that surfaces event E for object `k`
- **THEN** S's cursor for `k` holds E's artifact
- **AND** the next projection for `k` into S diffs from E's artifact

### Requirement: Legacy projections fall back to the shared diff

A `session_event_state` row with `NULL` `diff_text` (rows materialized before per-recipient deltas existed) SHALL fall back to the shared `monitor_events.diff_text` wherever a recipient diff is read.

#### Scenario: Pre-upgrade row uses the shared diff

- **GIVEN** a `session_event_state` row with `diff_text` `NULL` whose event has `monitor_events.diff_text` `"-a\n+b"`
- **WHEN** the event is delivered or explained for that session
- **THEN** the recipient diff used is `"-a\n+b"`

### Requirement: Session identity resumes by adapter and host session id

Opening a session with an `(adapter, hostSessionId)` pair that already has an `agent_sessions` row SHALL resume that record instead of creating a duplicate: the runtime SHALL set `status` to `active`, clear `dormantAt`, and advance `lastActiveAt`.

#### Scenario: Reopening resumes the existing record

- **GIVEN** session `claude-code`/`abc` was opened and later closed
- **WHEN** a session is opened again with adapter `claude-code` and hostSessionId `abc`
- **THEN** the same AgentMon session id is returned with `status` `active` and `dormantAt` unset
- **AND** no second `agent_sessions` row exists for that pair

### Requirement: Closing a session marks it dormant and keeps history

An explicit session close SHALL set `status` to `dormant` and set `dormantAt`, and SHALL preserve all of the session's history (projections, delivery state, cursors).

#### Scenario: Closed session retains its projections

- **GIVEN** session S has unread projected events
- **WHEN** S is closed
- **THEN** S has `status` `dormant` and a `dormantAt` timestamp
- **AND** its `session_event_state` rows still exist

### Requirement: Session activity is tracked

A session's `lastActiveAt` SHALL advance whenever the session is opened or resumed, whenever a delivery claim or delivery reservation touches it, when a recap is recorded for it, and when it declares an ephemeral monitor (per the `agent/ephemeral-monitors` capability).

#### Scenario: A delivery claim refreshes activity

- **WHEN** a delivery is claimed for session S at time `t`
- **THEN** S's `lastActiveAt` is `t`

#### Scenario: Declaring a watch refreshes activity

- **WHEN** session S declares an ephemeral monitor at time `t`
- **THEN** S's `lastActiveAt` is `t`

### Requirement: Inactive sessions go dormant per session

On each tick, before evaluating monitors, the runtime SHALL transition to `dormant`, via the same path as an explicit close (setting `dormantAt`), every `active` session in the ticked workspace whose `lastActiveAt` is at or before `now − DEFAULT_SESSION_DORMANCY_MS` (default 30 minutes), except one exempted by a recent watch declaration per `agent/ephemeral-monitors`. This reaps the session's ephemeral monitors. Refs #312.

#### Scenario: Session past the dormancy window is reaped

- **GIVEN** session S is `active` with `lastActiveAt` 31 minutes ago and declared an ephemeral monitor
- **WHEN** a tick runs for S's workspace
- **THEN** S becomes `dormant` with `dormantAt` set before monitors are evaluated
- **AND** S's ephemeral monitor is reaped

#### Scenario: Session within the dormancy window is not reaped

- **GIVEN** session S is `active` with `lastActiveAt` 10 minutes ago
- **WHEN** a tick runs
- **THEN** S stays `active` and its ephemeral monitors stay armed

### Requirement: Per-session dormancy is distinct from daemon idle termination

Per-session dormancy by inactivity SHALL NOT be conflated with the daemon-wide idle self-termination defined by the `daemon/ipc` capability: one session going dormant SHALL NOT stop the daemon. A dormant session that resumes becomes `active` with a fresh `lastActiveAt`, but ephemeral monitors reaped during dormancy SHALL NOT be resurrected.

#### Scenario: Resumed session does not regain reaped ephemeral monitors

- **GIVEN** session S went dormant by inactivity and its ephemeral monitor was reaped
- **WHEN** S is opened again with the same `(adapter, hostSessionId)`
- **THEN** S is `active` with a fresh `lastActiveAt`
- **AND** the reaped ephemeral monitor stays reaped

### Requirement: Dormancy threshold is overridable in process

The dormancy threshold SHALL default to 30 minutes and SHALL be overridable in-process through the `AgentMonitorRuntime` constructor's `sessionDormancyMs` option, so tests can exercise dormancy deterministically.

#### Scenario: Test runtime uses a short dormancy threshold

- **GIVEN** a runtime constructed with `sessionDormancyMs: 1000`
- **WHEN** a tick runs 2 seconds after an active session's last activity
- **THEN** that session becomes `dormant`

### Requirement: Unread, claimed, and acknowledged are distinct session states

For each projected event the runtime SHALL track delivery state per session in `session_event_state` with distinct meanings (per SP4): unread is `acknowledged_at IS NULL`; pending (unclaimed) is `first_notified_at IS NULL AND acknowledged_at IS NULL`; claimed is `first_notified_at IS NOT NULL`; acknowledged is `acknowledged_at IS NOT NULL`. A claimed event SHALL remain unread until acknowledged.

#### Scenario: Claimed events remain unread until acknowledged

- **GIVEN** an event projected into session S
- **WHEN** S claims a delivery containing it
- **THEN** the row has `first_notified_at` set and `acknowledged_at` `NULL`, so it is claimed and still unread
- **AND** after S acknowledges it, `acknowledged_at` is set and it is no longer unread

### Requirement: Hook-state file is written atomically

Each session SHALL have a hook-state JSON file at its `hook_state_path`, rewritten whenever the session's pending work changes (including immediately on session open). The file SHALL be written atomically by writing a `.tmp` sibling and then renaming it over the target, so readers never observe a partial file; its permissions follow the `runtime/local-data-permissions` capability.

#### Scenario: Reader never sees a partial hook-state file

- **WHEN** the runtime refreshes a session's hook state
- **THEN** the new content is written to a `.tmp` file and renamed into place
- **AND** a concurrent reader sees either the previous or the new complete JSON

### Requirement: Hook-state content fields

The hook state SHALL include `sessionId`, `updatedAt` (ISO 8601 string), `unread` counts for `low`, `normal`, `high`, and `total`, `hasPendingHigh`, `hasPendingNormal`, `hasPendingLow`, and `latestHighTitles`. `hasPendingNormal` and `hasPendingLow` SHALL be true when at least one event of that band is pending for the session.

#### Scenario: Hook state reflects pending and unread counts

- **GIVEN** session S has 2 unread normal events (1 claimed, 1 unclaimed) and 1 unread low event that is claimed
- **WHEN** S's hook state is refreshed
- **THEN** `unread` is `{ low: 1, normal: 2, high: 0, total: 3 }`
- **AND** `hasPendingNormal` is `true` and `hasPendingLow` is `false`

### Requirement: hasPendingHigh honors the high-urgency settle window

`hasPendingHigh` SHALL be `true` only when at least one unread high-urgency event is still unclaimed and its age is at or above `DEFAULT_HIGH_URGENCY_SETTLE_MS` (15000 ms), mirroring the `turn-interruptible` delivery condition in the `delivery/lifecycles` capability.

#### Scenario: Fresh high event is not yet pending

- **GIVEN** an unclaimed high-urgency event projected into S 10 seconds ago
- **WHEN** S's hook state is refreshed
- **THEN** `hasPendingHigh` is `false`

#### Scenario: Settled high event is pending

- **GIVEN** an unclaimed high-urgency event projected into S 15 seconds ago
- **WHEN** S's hook state is refreshed
- **THEN** `hasPendingHigh` is `true`

### Requirement: latestHighTitles lists recent unclaimed high events

`latestHighTitles` SHALL contain the titles of up to the 5 most recent unclaimed high-urgency events for the session.

#### Scenario: Only five titles are kept

- **GIVEN** session S has 7 unclaimed high-urgency events titled `h1`…`h7` in creation order
- **WHEN** S's hook state is refreshed
- **THEN** `latestHighTitles` is `["h3", "h4", "h5", "h6", "h7"]`
