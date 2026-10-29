# agent/ephemeral-monitors Specification

## Purpose

Ephemeral monitors are agent-declared, session-scoped monitors that run on the same daemon and the
same pipeline as persistent `MONITOR.md` monitors (AP7), differing only in authoring path (declared
at runtime via `agentmonitors watch`) and lifetime (bound to the declaring lead session). This
capability owns their declaration, identity, lifecycle, isolation, and the `watch` command surface.

## Requirements

### Requirement: One pipeline, second authoring path

The system SHALL handle an ephemeral monitor with the same daemon and the same pipeline as a persistent `MONITOR.md` monitor (AP7): the identical tick, notify/pace, materialize, project, and deliver stages, with urgency (PP5), snapshots/diffs (SP5), lead-session projection, and the three delivery states (SP4) all holding. An ephemeral monitor MUST NOT be served by a parallel system; it differs only in authoring path and lifetime.

#### Scenario: Ephemeral monitor fires through the normal pipeline

- **GIVEN** an active lead session that declared `agentmonitors watch schedule --session <id> --scope 'cron=* * * * *'`
- **WHEN** the next runtime tick observes a change for that monitor
- **THEN** a durable `monitor_events` row is materialized and projected into the declaring session's `session_event_state`, exactly as for a persistent monitor
- **AND** it is surfaced through the same delivery transports, with unread / claimed / acknowledged states tracked identically

### Requirement: Declaration scope is validated by the shared validate path

A declaration SHALL name a registered source and a scope that is valid against that source's `scopeSchema`, validated by the same shared scope-validation path as `agentmonitors validate` (the `validateScope` schema check plus the BP3 `change-detection.collection` friendly wrapper), so an ephemeral monitor cannot express a config a persistent monitor could not (AP4, BP3). An unknown source or invalid scope MUST be rejected with the identical diagnosis `validate` gives.

#### Scenario: Invalid scope rejected identically to validate

- **GIVEN** a scope that fails the source's `scopeSchema`
- **WHEN** an agent runs `agentmonitors watch <source> --session <lead-id> --scope <invalid>`
- **THEN** the declaration is rejected with `Invalid scope for source "<source>": …` carrying the same diagnosis `agentmonitors validate` reports for that scope in a `MONITOR.md`
- **AND** no `ephemeral_monitors` row is registered

#### Scenario: Keyed-collection scope rejected through the shared wrapper

- **WHEN** a declaration's scope uses a keyed `change-detection.collection` shape that `validate` rejects with its BP3 friendly error
- **THEN** `watch` rejects it with the identical friendly error

#### Scenario: Unknown source rejected

- **WHEN** a declaration names a source that is not registered
- **THEN** it is rejected with `Unknown source "<name>". Available sources: …` listing the registered source names

#### Scenario: Valid declaration registers and is evaluated on the next tick

- **WHEN** a declaration with a valid scope is submitted for an active lead session
- **THEN** it is registered with status `active`
- **AND** it is evaluated on the next runtime tick

#### Scenario: Scope key named type cannot override the source

- **GIVEN** a scope object containing a key literally named `type`
- **WHEN** the declaration is registered and later evaluated on a tick
- **THEN** the monitor's source remains the declared `<source>`; the scope's `type` key never overrides it

### Requirement: Declaration urgency defaults to normal

A declaration MAY carry an `urgency` (a single level or a `lo..hi` band, as a persistent monitor's frontmatter accepts); when omitted, the urgency SHALL default to `normal`, matching persistent monitors. The declaration MUST be confirmed through the same monitor frontmatter schema a persistent monitor uses, and an invalid urgency MUST be rejected.

#### Scenario: Omitted urgency

- **WHEN** a declaration omits `--urgency`
- **THEN** the registered ephemeral monitor's urgency is `normal`

#### Scenario: Urgency band

- **WHEN** a declaration passes `--urgency normal..high`
- **THEN** the record stores `urgency` = `normal` and `urgency_max` = `high`, the same flattened band a persistent monitor carries

### Requirement: Instruction is the monitor body fallback

A declaration MAY carry an instruction — free-text handling guidance that becomes the ephemeral monitor's body (the equivalent of a persistent monitor's markdown body). It SHALL be surfaced on delivery as `DeliveryEventSummary.body` as a fallback: an observation that carries its own `body` overrides it (`observation.body ?? monitor.instructions`). An omitted instruction is stored as the empty string.

#### Scenario: Instruction surfaces on delivery

- **GIVEN** `agentmonitors watch schedule --session <id> --scope … --instruction "Re-run the flaky test"`
- **WHEN** the monitor fires and the observation carries no `body`
- **THEN** the delivered `DeliveryEventSummary.body` is `Re-run the flaky test`

#### Scenario: Observation body overrides the instruction

- **WHEN** the observation that fires the monitor carries its own `body`
- **THEN** that observation body is delivered instead of the instruction

### Requirement: Declaration binds to an active session

A declaration SHALL bind to a resolved AgentMon session (the declaring session, resolved by the host adapter's session-identity mechanism). An unbindable declaration — an unknown session id, or a session whose status is not `active` — MUST be rejected, never silently made global.

#### Scenario: Unknown session rejected

- **WHEN** `--session` names a session id the store does not know
- **THEN** the declaration is rejected with an error stating the session was not found and must bind to a live AgentMon session
- **AND** nothing is registered

#### Scenario: Dormant session rejected

- **WHEN** `--session` names a session whose status is `dormant`
- **THEN** the declaration is rejected with an error stating the session must be active

### Requirement: Declaration binds only to a lead session

The bound session MUST be a lead session. Because projection delivers to lead sessions only (per the `delivery/session-projection` capability), a binding to a subagent session would observe forever but never deliver; a declaration against a non-lead session MUST be rejected at declaration time with a clear error, not registered.

#### Scenario: Subagent session rejected

- **WHEN** `--session` names an active session whose role is `subagent`
- **THEN** the declaration is rejected with an error explaining that ephemeral-monitor events project into lead sessions only and that the watch must be declared from the lead session
- **AND** no `ephemeral_monitors` row is created

### Requirement: Display name is an optional non-blank name

A declaration MAY carry a display name (`--display-name`), which SHALL serve as the ephemeral monitor's authored name (its only naming affordance, since it has no frontmatter file) so event titling treats ephemeral and persistent monitors identically. A present display name that is empty or whitespace-only MUST be rejected at declaration.

#### Scenario: Named watch titles its events

- **WHEN** a watch declared with `--display-name "CI status"` fires, including after a daemon restart
- **THEN** its events are titled using `CI status` as the authored monitor name

#### Scenario: Unnamed watch falls back to the source title

- **WHEN** a watch declared without `--display-name` fires
- **THEN** its events fall back to the source-provided title, as for a nameless persistent monitor

#### Scenario: Whitespace-only display name rejected

- **WHEN** a declaration passes `--display-name "   "`
- **THEN** it is rejected with an error that `--display-name` must contain non-whitespace characters

### Requirement: Declaration registers intent and performs no watching

A declaration SHALL register intent durably and return; it MUST perform no watching itself. All subsequent observation, change detection, scheduling, notify timing, persistence, diffing, projection, and delivery are daemon-owned (PP9, PP10, AP3). Declaring MUST NOT change any delivery state (unread / claimed / acknowledged).

#### Scenario: Declare returns without observing

- **WHEN** an agent declares a watch
- **THEN** the command returns the registered record without invoking the source's `observe()`
- **AND** no `session_event_state` row changes as a result of the declaration

### Requirement: Agent need not keep an ephemeral monitor alive

The agent MUST NOT be required to re-invoke, refresh, or keep alive an ephemeral monitor; the daemon SHALL tick it on the normal runtime tick for as long as it is active (PP9).

#### Scenario: Watch keeps firing without agent action

- **GIVEN** a declared watch and no further agent commands
- **WHEN** successive ticks observe changes
- **THEN** each change is materialized and delivered without the agent re-declaring or refreshing the watch

### Requirement: No model call in the daemon core

An ephemeral monitor MUST NOT cause any model call in the daemon core. If its payload form is `prose`, the optional Interpret stage SHALL run via the user's own AI tool behind the adapter, exactly as for persistent monitors (PP10, per the `pipeline/post-processing` capability).

#### Scenario: Prose payload interpreted outside the daemon

- **WHEN** an ephemeral monitor's event requires interpretation
- **THEN** interpretation runs through the adapter-side Interpret path, and the daemon core issues no model call

### Requirement: Namespaced ephemeral identity

Each ephemeral monitor SHALL be assigned, once at declaration, the runtime identity `ephemeral:<sessionId>/<ulid>`. The reserved `ephemeral:` prefix namespaces it so `monitor_events.monitor_id`, `monitor explain`, and `queryScope` filtering are unambiguous; it MUST NOT collide with another ephemeral id or any persistent monitor id in the workspace (SP2). Rationale: a directory-derived persistent id (SP1) is a single path segment and can never contain `/`.

#### Scenario: Id is namespaced and cannot collide with a persistent id

- **GIVEN** a workspace with a persistent monitor directory `ci-status`
- **WHEN** session `S1` declares a watch
- **THEN** the returned id matches `ephemeral:S1/<ulid>` and contains a `/`, so it can never equal a directory-derived id

#### Scenario: Each declaration gets a distinct id

- **WHEN** the same session declares two watches with identical source and scope
- **THEN** the two records have different ids

### Requirement: Ephemeral identity is stable for the monitor lifetime

An ephemeral monitor's id SHALL never be mutated after declaration, so its snapshots, per-recipient cursors, and events key correctly for its whole lifetime (SP5), including across ticks and daemon restarts.

#### Scenario: Id stable across a tick and a restart

- **WHEN** a watch is declared, a tick runs, and the daemon restarts while the session is active
- **THEN** `watch list` reports the same id before and after, and events materialized before and after the restart carry that same `monitor_id`

### Requirement: Active on declaration and evaluated on the normal tick

An ephemeral monitor SHALL become active on declaration and be evaluated on the normal runtime tick exactly like a persistent monitor (per the `runtime/tick-scheduling` capability).

#### Scenario: First tick materializes an event

- **WHEN** a watch is declared and the next tick observes a change for it
- **THEN** an event is materialized for the ephemeral monitor id

### Requirement: Reaped when the declaring session closes

An ephemeral monitor MUST be reaped when its declaring session ends by explicit session close; it MUST NOT outlive its session or leak into another session. After reaping, no further events SHALL fire for it.

#### Scenario: Session close reaps

- **GIVEN** session `S1` with an active watch
- **WHEN** `S1` is closed
- **THEN** the watch's status becomes `reaped` with `reaped_at` stamped
- **AND** subsequent ticks materialize no further events for it

### Requirement: Reaped when the declaring session goes dormant

An ephemeral monitor MUST be reaped when its declaring session transitions to `dormant` by the per-session inactivity trigger (`DEFAULT_SESSION_DORMANCY_MS`, defined by the `delivery/session-projection` capability), at the start of the tick that performs the transition. This per-session reap is distinct from the daemon-wide idle self-termination (per the `daemon/ipc` capability).

#### Scenario: Dormancy reaps

- **GIVEN** a session whose `lastActiveAt` and newest active declaration are both older than the dormancy window
- **WHEN** a tick runs
- **THEN** the session becomes `dormant` and its ephemeral monitors are reaped

#### Scenario: Within the window, not reaped

- **WHEN** a session is still within the dormancy window
- **THEN** a tick neither transitions it nor reaps its watches

### Requirement: Declaring a watch counts as session activity

Declaring an ephemeral monitor SHALL count as activity for the declaring session: it advances the session's `lastActiveAt`, and a session with an active ephemeral monitor declared within the dormancy window MUST NOT be treated as dormant even if its `lastActiveAt` is older. Coverage extends at most one dormancy window past the newest declaration (#396 tracks longer blocking waits).

#### Scenario: Long-quiet session keeps a fresh watch

- **GIVEN** a lead session that declares a watch and then emits no hooks for most of a dormancy window
- **WHEN** a tick runs before the window measured from the declaration has elapsed
- **THEN** the session is not reaped and the watch stays armed and fires

### Requirement: Cancel reaps immediately and only by the owner

An agent MAY cancel an ephemeral monitor before its session ends (`agentmonitors watch cancel <id>`), which SHALL reap it immediately. Only the owning (declaring) session may cancel it; a cancel naming another session's ephemeral id, or an unknown id, MUST be rejected.

#### Scenario: Owner cancels

- **WHEN** session `S1` runs `watch cancel ephemeral:S1/<ulid> --session S1`
- **THEN** the watch's status becomes `reaped` and the reaped record is returned

#### Scenario: Non-owner cancel rejected

- **WHEN** session `S2` runs `watch cancel ephemeral:S1/<ulid> --session S2`
- **THEN** the command fails with `Ephemeral monitor "ephemeral:S1/<ulid>" was not found for session "S2".`
- **AND** the watch stays `active`

### Requirement: Durable across daemon restart while the session lives

While its declaring session lives, an ephemeral monitor and its durable state (source state, snapshots, per-recipient cursors, unread/claimed/acknowledged rows) MUST survive a daemon restart and a reboot (PP1); a restart within the session's life SHALL re-hydrate it from `ephemeral_monitors`.

#### Scenario: Restart re-hydrates an active watch

- **GIVEN** an active watch for an active session
- **WHEN** the daemon restarts and ticks
- **THEN** the watch is evaluated again with its prior source state and cursors, and its unread events remain unread

### Requirement: No resurrection after the session ends

A reaped ephemeral monitor MUST never be re-armed: a restart after its session has ended SHALL NOT resurrect it, and a session that resumes from `dormant` to `active` SHALL NOT get its reaped watches back.

#### Scenario: Restart after session end

- **GIVEN** a watch reaped because its session closed
- **WHEN** the daemon restarts and ticks
- **THEN** the watch is not evaluated and stays `reaped`

#### Scenario: Resumed session does not regain watches

- **WHEN** a dormant session is reopened with the same `(adapter, hostSessionId)`
- **THEN** it becomes `active` but its previously reaped ephemeral monitors remain `reaped`

### Requirement: Reaping stops observation and retains events

Reaping SHALL clean up the ephemeral monitor's runtime registration and stop further observation by flipping its `ephemeral_monitors.status` from `active` to `reaped` and stamping `reaped_at`. It MUST NOT delete the record, its already-materialized `monitor_events`, or their `session_event_state` projections, so an event materialized just before reap stays unread, deliverable, and inspectable (PP1).

#### Scenario: Post-tick reap retains events

- **GIVEN** a watch whose tick materialized and projected an unread event
- **WHEN** the watch is reaped (cancel, close, or dormancy)
- **THEN** the event row and its projection are still present and the event remains unread for the declaring session

### Requirement: Projection only into the declaring session

An ephemeral monitor's events SHALL flow through the identical stages and transports as persistent-monitor events — there is no ephemeral-only delivery path — and MUST project into the declaring session only. They MUST NOT project into other sessions merely because those share a workspace.

#### Scenario: Sibling lead session receives nothing

- **GIVEN** lead sessions `S1` and `S2` in the same workspace, and a watch declared by `S1`
- **WHEN** the watch fires
- **THEN** `S1` has a `session_event_state` row for the event and `S2` has none

#### Scenario: Persistent monitors unaffected

- **WHEN** a persistent monitor in the same workspace fires
- **THEN** its event still projects into every matching lead session, including `S1` and `S2`

### Requirement: Unscoped event reads exclude ephemeral events

An ephemeral monitor's events MUST NOT be returned by any unscoped (session-less) event read such as `events list` without a session — including one that names the ephemeral monitor id — because their body carries the declaring session's private instruction. Unscoped reads SHALL exclude rows whose `monitor_id` has the reserved `ephemeral:` prefix; the declaring session reads its own ephemeral events through its session-scoped read.

#### Scenario: Unscoped list hides ephemeral events

- **GIVEN** an event materialized by a watch declared by `S1`
- **WHEN** an unscoped (session-less) event listing runs, with or without naming the ephemeral id
- **THEN** the ephemeral event is absent from the result

#### Scenario: Declaring session sees its events

- **WHEN** `S1` lists events with its session scope
- **THEN** the ephemeral event is present

### Requirement: Observation-history isolation applies to unscoped enumeration only

An unscoped observation-history enumeration (no `monitorId`) MUST exclude ephemeral-monitor rows. A `monitorId`-targeted observation-history read that names a full `ephemeral:<sessionId>/<ulid>` id is an operator-level diagnostic (`monitor explain`, `doctor`, reminder diagnosis) and MAY return that monitor's observe outcomes and counts regardless of session, under the local single-operator trust model (PP10).

#### Scenario: Unscoped history enumeration hides ephemeral rows

- **WHEN** observation history is listed without a `monitorId`
- **THEN** no row whose `monitor_id` starts with `ephemeral:` is returned

#### Scenario: Targeted diagnostic read is permitted

- **WHEN** observation history is read for `monitorId` = `ephemeral:S1/<ulid>`
- **THEN** that monitor's observation-history rows are returned

### Requirement: In-flight tick does not deliver for a reaped watch

Because a tick pre-fetches its active ephemeral monitors before `observe()` yields, delivery SHALL re-check at materialization/insert time that the ephemeral monitor is still `active` and its declaring session is still `active`. If either has been reaped, the observed event MUST be retained but projected to nobody.

#### Scenario: Cancel races an in-flight observation

- **GIVEN** a tick that has fetched an active watch and is awaiting its `observe()`
- **WHEN** `watch cancel` reaps the watch before the observation's event is inserted, while the session stays active
- **THEN** the event row is retained and no `session_event_state` row is created for any session

#### Scenario: Session close races an in-flight observation

- **WHEN** the declaring session closes while the observation is in flight
- **THEN** the event row is retained and projected to nobody

### Requirement: Per-recipient cursor is the shared primitive

An ephemeral monitor's per-recipient diff state SHALL use the same `session_object_cursor` per-recipient cursor primitive as persistent-monitor projections (per the `pipeline/post-processing` capability), not a separate ephemeral-only state model.

#### Scenario: Ephemeral diff keyed by session cursor

- **WHEN** a snapshot-bearing ephemeral event projects into the declaring session
- **THEN** its per-recipient diff is computed against that session's `session_object_cursor` row for `(sessionId, monitorId, objectKey, workspacePath)`, seeding it on first projection

### Requirement: watch declare command surface

The CLI SHALL expose `agentmonitors watch <source> --session <id> --scope <spec> [--urgency <u>] [--instruction <text>] [--display-name <name>] [--socket <path>] [--format text|json]`. `declare` is the default subcommand, so `watch <source> …` and `watch declare <source> …` are equivalent. `--session` and `--scope` are required. Text output prints the declared id, source, and urgency; `--format json` prints the full record.

#### Scenario: Default action equivalence

- **WHEN** an agent runs `agentmonitors watch schedule --session S1 --scope 'cron=* * * * *'`
- **THEN** the result is the same as `agentmonitors watch declare schedule --session S1 --scope 'cron=* * * * *'`

#### Scenario: Text output

- **WHEN** a declaration succeeds with the default `--format text`
- **THEN** stdout contains `Declared ephemeral monitor: <id>`, `Source: <source>`, and `Urgency: <urgency>`

#### Scenario: Missing required flag

- **WHEN** `--session` or `--scope` is omitted
- **THEN** the command fails with a usage error before contacting the daemon

### Requirement: watch scope flag syntax

`--scope` SHALL accept either a JSON object (a value starting with `{`, parsed verbatim so array/nested/typed scopes work) or a `key=value,...` list of scalar string values separated by `,`. A `{`-prefixed value that is not valid JSON, or a JSON value that is not an object, MUST be rejected; a `key=value` entry without `=` MUST be rejected as not a key=value pair. Parsing is purely syntactic; validity is judged by the shared scope validation.

#### Scenario: JSON scope

- **WHEN** `--scope '{"globs":["src/**"]}'` is passed
- **THEN** the declared scope is the object `{ "globs": ["src/**"] }`

#### Scenario: key=value scope

- **WHEN** `--scope 'cron=* * * * *,timezone=UTC'` is passed
- **THEN** the declared scope is `{ "cron": "* * * * *", "timezone": "UTC" }`

#### Scenario: Malformed entry

- **WHEN** `--scope 'cron'` is passed
- **THEN** the command fails with an error that the entry `cron` is not a key=value pair (or valid JSON), exit code 1

#### Scenario: Malformed JSON rejected

- **WHEN** `--scope '{"globs":'` is passed
- **THEN** the command fails with exit code 1 and no declaration is sent to the daemon

### Requirement: watch list command surface

The CLI SHALL expose `agentmonitors watch list --session <id> [--socket <path>] [--format text|json]`, listing the session's `active` ephemeral monitors in declaration order. Text output prints one line per record (`<id>  <source>  <urgency>  <status>`) or `No ephemeral monitors found.` when there are none; `--format json` prints the record array.

#### Scenario: Empty list

- **WHEN** a session with no active watches runs `watch list --session <id>`
- **THEN** stdout is `No ephemeral monitors found.`

#### Scenario: Reaped watches not listed

- **WHEN** a session has one active and one reaped watch
- **THEN** `watch list` shows only the active one

### Requirement: watch cancel command surface

The CLI SHALL expose `agentmonitors watch cancel <ephemeralId> --session <id> [--socket <path>] [--format text|json]`, where `--session` names the owning session. On success text output prints `Cancelled ephemeral monitor: <id>`; `--format json` prints the reaped record.

#### Scenario: Successful cancel output

- **WHEN** the owner cancels its watch
- **THEN** stdout is `Cancelled ephemeral monitor: <id>` and the exit code is 0

### Requirement: watch commands require the daemon

All `watch` subcommands SHALL round-trip the daemon over its socket (`watch.declare`, `watch.list`, `watch.cancel`), resolving the socket per the `cli/conventions` capability; they have no in-process fallback. A connection failure MUST report the no-daemon remediation message, and any failure MUST set exit code 1 (as `{"error": …}` on stdout under `--format json` for daemon-side errors, `Error: …` on stderr otherwise).

#### Scenario: No daemon running

- **WHEN** `watch list --session <id>` runs with no reachable daemon
- **THEN** stderr reports that no daemon is running for this workspace with the `agentmonitors daemon run` / `agentmonitors doctor` remediation, and the exit code is 1

#### Scenario: Daemon-side error in JSON mode

- **WHEN** a declaration is rejected by the daemon under `--format json`
- **THEN** stdout is a JSON object with an `error` field carrying the rejection message, and the exit code is 1
