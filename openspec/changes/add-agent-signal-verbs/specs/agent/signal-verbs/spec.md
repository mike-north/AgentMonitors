## Purpose

Read-only, agent-facing daemon verbs (`snapshot`, `diff`, `summary`) that let an agent act on a
pushed signal by reading durable state the daemon already holds — never re-observing, never changing
delivery state, and never waiting — plus their `agentmonitors` command surface.

## ADDED Requirements

### Requirement: Agent-facing reads come only from durable state

Each agent-facing verb (`snapshot`, `diff`, `summary`) SHALL read only from durable state the daemon already holds — `monitor_snapshots`, `monitor_events`, `session_object_cursor`, and `session_event_state` — and MUST NOT trigger a fresh source `observe()` or `watch()`; when to observe is runtime-owned scheduling (AP3, PP9).

#### Scenario: Read does not re-observe

- **GIVEN** a monitor backed by a spy/fake source with a recorded `observe()` call count
- **WHEN** an agent runs `snapshot`, `diff`, and `summary` for that monitor
- **THEN** the source's `observe()` call count is unchanged across the reads

### Requirement: Agent-facing reads do not change delivery state

An agent-facing read MUST be side-effect-free with respect to delivery: it MUST NOT claim, acknowledge, or advance any recipient cursor, and the unread / claimed / acknowledged state (SP4) MUST be unchanged by it. It is not a `hook claim` (which marks rows claimed, BP2) and not `events ack` (which marks rows acknowledged).

#### Scenario: Delivery state byte-identical across a read

- **GIVEN** a session with unread, claimed, and acknowledged events and seeded `session_object_cursor` rows
- **WHEN** the session runs `snapshot`, `diff`, and `summary` against those monitors
- **THEN** its `session_event_state` and `session_object_cursor` rows are byte-identical before and after

#### Scenario: Read versus claim versus ack

- **WHEN** the same unread event is read via `summary`, then surfaced by a delivery transport, then acknowledged via `events ack`
- **THEN** the read leaves it unread and unclaimed, the delivery marks it claimed (not acknowledged), and only `events ack` marks it acknowledged

### Requirement: Agent-facing reads are bounded

An agent-facing read MUST be bounded and cheap — sized for an agent context window, not a full resource dump — mirroring the delivery content-safety bound (per the `delivery/channel-transport` capability).

#### Scenario: Oversized content is bounded

- **WHEN** an agent-facing read would return content exceeding the agent-context bound
- **THEN** the response is bounded rather than returning the full unbounded resource

### Requirement: Agent-facing verbs are invoked only on signal or turn boundary

The agent-facing verbs MUST NOT cause the agent to poll, block, or run a background waiting loop; an agent SHALL invoke them only in response to a pushed signal or at its own turn boundary, never on a timer of its own. All waiting stays daemon-owned (PP9). This surface is delivered to local hosts only and MUST NOT imply an internet-visible or cloud-agent-waking path (NP5).

#### Scenario: No agent-side timer

- **WHEN** a host integration or skill guides an agent to use `snapshot`/`diff`/`summary`
- **THEN** the guidance invokes them after a pushed signal or at a turn boundary, never on an agent-side polling interval

### Requirement: Agent-facing verbs answer asynchronously without long-poll

Each verb SHALL return the current durable answer immediately and MUST NOT implement a blocking long-poll that waits for a future change (which would reintroduce agent-side waiting, violating PP9).

#### Scenario: Returns without a change occurring

- **GIVEN** a monitor with no pending or future change
- **WHEN** an agent runs `summary <monitorId>`
- **THEN** the command returns the current answer immediately without waiting for a change

### Requirement: Agent-facing transport preserves isolation and semantics

The wire under the agent-facing verbs (loopback HTTP or the existing Unix-domain-socket IPC) is an implementation detail; whichever is chosen MUST preserve the per-workspace isolation and socket-path resolution of the daemon (per the `daemon/ipc` and `cli/conventions` capabilities). A loopback-HTTP option MUST bind loopback-only and stay on-device (NP1, NP5). The transport MUST NOT change any verb's semantics.

#### Scenario: Same answer regardless of transport

- **WHEN** the same `snapshot` request is served over each supported transport
- **THEN** the returned durable answer is identical

#### Scenario: Loopback-only binding

- **WHEN** a loopback-HTTP transport is enabled
- **THEN** it accepts connections only on a loopback interface

### Requirement: Snapshot returns the latest stored snapshot

`snapshot` SHALL return the latest `monitor_snapshots` content for `(workspacePath, monitorId, objectKey)` (SP5) — the same text the runtime diffs against — and nothing more. It MUST NOT re-fetch the underlying resource; a snapshot older than the last successful observation is the correct answer (freshness is runtime scheduling, AP3).

#### Scenario: Snapshot of a file-fingerprint object

- **GIVEN** a `file-fingerprint` high-urgency delivery fired for `object_key = /repo/package.json` on monitor `build-config-drift`
- **WHEN** the agent runs `agentmonitors snapshot build-config-drift --object /repo/package.json`
- **THEN** it receives the full current stored text of `package.json` as the daemon last observed it
- **AND** no filesystem read of `package.json` occurs, no row is claimed, and no cursor moves

### Requirement: Snapshot object selection never guesses

When a monitor watches exactly one object, `--object` MAY be omitted and `snapshot` SHALL return that object's snapshot. When the monitor watches multiple objects and `--object` is omitted, `snapshot` MUST list the available object keys and MUST NOT silently pick one.

#### Scenario: Single-object monitor

- **WHEN** `snapshot <monitorId>` is run without `--object` for a monitor with one stored object
- **THEN** that object's latest snapshot is returned

#### Scenario: Multi-object monitor without --object

- **WHEN** `snapshot <monitorId>` is run without `--object` for a monitor with stored objects `a` and `b`
- **THEN** the command lists `a` and `b` as available object keys and returns no snapshot body

### Requirement: Diff points are event ids or timestamps

Each `diff` point (`--from`, `--to`) SHALL be expressible as either a durable `monitor_events` event id (whose snapshot is the anchor) or an ISO-8601 timestamp, resolved to the snapshot at or immediately before that instant.

#### Scenario: Diff between two event ids

- **GIVEN** events `E1` and `E2` for object `k`, each with a stored snapshot
- **WHEN** an agent runs `diff <monitorId> --object k --from E1 --to E2`
- **THEN** the output equals the runtime's strategy-aware diff of `E1`'s snapshot against `E2`'s snapshot

#### Scenario: Timestamp resolves to the snapshot at or before

- **WHEN** `--from 2026-06-19T10:00:00Z` is passed and snapshots exist at 09:58 and 10:03
- **THEN** the 09:58 snapshot is used as the `from` anchor

### Requirement: Diff defaults to the recipient baseline and latest snapshot

Omitting `--from` SHALL default to the recipient session's own baseline cursor (`session_object_cursor.baseline_content`); omitting `--to` SHALL default to the latest stored snapshot. A bare `diff <monitorId> --object <k>` therefore answers "what has changed for me since my baseline", reusing the per-recipient seam rather than a new diff engine (AP6).

#### Scenario: Bare diff uses the baseline cursor

- **GIVEN** session `S1` whose `session_object_cursor.baseline_content` for object `k` is `B`, and latest snapshot `L`
- **WHEN** `S1` runs `diff <monitorId> --object k --session S1`
- **THEN** the output is the diff from `B` to `L`

### Requirement: Diff uses the runtime's strategy-aware renderer

`diff` MUST be computed with the same strategy-aware diff renderer the runtime uses for delivered diffs, so agent-visible diffs match delivered diffs: structural for a `strategy: json-diff` object and line-based otherwise (issue #437).

#### Scenario: json-diff object

- **WHEN** `diff` runs for an object whose change-detection strategy is `json-diff`
- **THEN** the output is the structural diff the runtime would deliver, not a line diff of compact JSON

### Requirement: Diff is a pure read

`diff` MUST NOT advance the recipient's cursor or alter delivery state.

#### Scenario: Cursor unchanged after a bare diff

- **WHEN** `S1` runs a bare `diff` twice in a row
- **THEN** both runs return the same output and `S1`'s `session_object_cursor` row is unchanged

### Requirement: Pruned diff point is a clear error

A `diff` referencing a point whose `monitor_snapshots` row no longer exists MUST fail with a clear error rather than silently returning an empty diff; the implementation MUST define a snapshot retention floor or reject such points explicitly.

#### Scenario: Pruned point

- **GIVEN** `--from` names an event id whose snapshot has been pruned
- **WHEN** the agent runs `diff`
- **THEN** the command fails with an error identifying the unavailable point and returns no diff output

### Requirement: Summary returns only cheap materialized facets

`summary` SHALL return only cheap, already-materialized facets drawn from `monitor_events` and `session_event_state` — monitor id, `objectKey`, urgency, `changeKind`, unread/claimed counts, and the event `title`/`summary` — and MUST NOT include the full snapshot text or the full diff.

#### Scenario: Summary omits bodies

- **WHEN** `summary <monitorId> --session S1` runs for a monitor with unread events
- **THEN** the output contains the monitor id, `objectKey`, urgency, `changeKind`, unread and claimed counts, and the event title/summary
- **AND** it contains no snapshot text and no diff text

### Requirement: snapshot command surface

The CLI SHALL expose `agentmonitors snapshot <monitorId> [--object <objectKey>] [--session <id>] [--socket <path>] [--format <format>]`, round-tripping the daemon and supporting the standard `--format` shapes (per the `cli/conventions` capability).

#### Scenario: JSON output

- **WHEN** `snapshot <monitorId> --object k --format json` runs
- **THEN** stdout is JSON carrying the stored snapshot for object `k`

### Requirement: diff command surface

The CLI SHALL expose `agentmonitors diff <monitorId> --object <objectKey> [--from <point>] [--to <point>] [--session <id>] [--socket <path>] [--format <format>]`, with `--object` required, round-tripping the daemon and supporting the standard `--format` shapes.

#### Scenario: Missing --object

- **WHEN** `diff <monitorId>` runs without `--object`
- **THEN** the command fails with a usage error

### Requirement: summary command surface

The CLI SHALL expose `agentmonitors summary <monitorId> [--object <objectKey>] [--session <id>] [--socket <path>] [--format <format>]`, round-tripping the daemon and supporting the standard `--format` shapes.

#### Scenario: Summary scoped to one object

- **WHEN** `summary <monitorId> --object k` runs
- **THEN** the facets returned are those of object `k` only
