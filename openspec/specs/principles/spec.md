# principles Specification

## Purpose

The invariants every other Agent Monitors capability relies on and cites by ID: product principles
(PP), semantic properties (SP), architectural properties (AP), boundary properties (BP), and
non-properties (NP). Other capabilities reference these IDs instead of restating them.

## Requirements

### Requirement: PP1 Durable signals over transient context

The system SHALL turn external changes into durable, queryable work signals for agents, and MUST NOT rely on a single prompt, hook invocation, or human memory to preserve an important observation.

#### Scenario: Observation survives a missed hook

- **GIVEN** a monitor emits an event while no hook invocation is running for the session
- **WHEN** the daemon restarts and the session later queries its events
- **THEN** the event is still persisted and returned as unread for that session

### Requirement: PP2 Declarative authoring

A monitor SHALL be authored as a folder-scoped `MONITOR.md` file whose frontmatter declares policy and whose body declares handling instructions, and its runtime behavior MUST be inferable from the monitor definition plus the selected source plugin.

#### Scenario: Behavior derives from the file and its source

- **GIVEN** `.claude/monitors/api-docs/MONITOR.md` with frontmatter `watch: { type: file-fingerprint, globs: ["docs/**"] }` and a markdown body
- **WHEN** the runtime evaluates the monitor
- **THEN** observation behavior comes from the `file-fingerprint` source applied to that `watch` block
- **AND** the body is carried as the monitor's handling instructions, with no other configuration consulted

### Requirement: PP3 Observation logic belongs to source plugins

The runtime SHALL decide when a source runs and how its emitted observations are delivered, while each source plugin MUST define how it reads external state and detects changes.

#### Scenario: Runtime does not re-implement change detection

- **WHEN** a source's `observe()` returns zero observations together with a new `nextState`
- **THEN** the runtime persists that `nextState` and emits no event
- **AND** the runtime does not apply its own change detection to the external target

### Requirement: PP4 Delivery is session-aware

The system SHALL project durable events into tracked agent sessions so that hooks and other delivery transports can surface pending work at appropriate lifecycle points; a persisted event alone MUST NOT be treated as delivered.

#### Scenario: Event reaches a tracked session

- **GIVEN** a tracked lead session in workspace `/repo`
- **WHEN** a monitor in `/repo` emits an event
- **THEN** a per-session delivery record for that event exists in the unread state
- **AND** a delivery lifecycle claim for that session can surface it

### Requirement: PP5 Urgency semantics are explicit

The system SHALL treat `low`, `normal`, and `high` urgency as first-class values of the model; public docs or examples that omit one of them MUST NOT narrow the implementation contract.

#### Scenario: All three urgency values are accepted

- **WHEN** a monitor declares `urgency: low`, `urgency: normal`, or `urgency: high`
- **THEN** each parses successfully and carries that urgency through to delivery

### Requirement: PP6 Stateful sources may require a baseline

A stateful source SHALL be allowed to persist a "before" state before it can detect a meaningful "after" change, and a first run that only establishes that baseline MUST NOT be treated as an operational error.

#### Scenario: First run establishes a baseline

- **GIVEN** a stateful source with no prior state for a monitor
- **WHEN** the source is observed for the first time
- **THEN** it returns zero observations and a `nextState`
- **AND** no error is reported for that monitor

### Requirement: PP7 Specs distinguish current behavior from target behavior

The canonical spec SHALL say which behaviors are current, which are required, and which are intentionally deferred: main specs under `openspec/specs/` MUST describe only current, implemented behavior, and target behavior MUST live in a change under `openspec/changes/` until implemented.

#### Scenario: Unimplemented behavior is a change, not a main-spec rule

- **WHEN** a rule describes behavior the code does not yet implement
- **THEN** it appears as a delta requirement in an `openspec/changes/<change>/` proposal
- **AND** no requirement in `openspec/specs/` asserts it

### Requirement: PP8 Implementation contract beats presentation docs

The canonical specs in `openspec/specs/` SHALL govern implementation work; public website docs MAY summarize or simplify, but MUST NOT be the only place where a behavior is defined.

#### Scenario: Website doc disagrees with the spec

- **WHEN** an `apps/website` page describes a behavior differently from `openspec/specs/`
- **THEN** the spec is authoritative and the website page is treated as lagging, not as a contract change

### Requirement: PP9 Agents declare and move on

An agent SHALL be able to express monitoring intent declaratively, MUST perform no watching mechanics itself, and MUST NOT poll or block waiting for a signal; the daemon owns all observation and waiting, and signals are pushed to the agent when ready.

#### Scenario: Agent does not wait on a signal

- **WHEN** an agent declares a monitor
- **THEN** the declaring command returns without waiting for any observation
- **AND** later signals arrive through a delivery transport rather than an agent-side poll loop

### Requirement: PP10 Deterministic daemon floor

The daemon SHALL perform only deterministic work — observe, shape, diff, persist, project, deliver — and MUST NOT ship a model or hold model-provider credentials; any summarization or interpretation MUST run via the user's own installed AI tool, opt-in and behind an adapter, never in the daemon core.

#### Scenario: No interpretation configured

- **GIVEN** no monitor opts into an interpretation stage
- **WHEN** the daemon processes observations
- **THEN** every delivered payload is produced by deterministic stages only
- **AND** the daemon makes no call to a model provider

### Requirement: SP1 Monitor identity is directory-derived

A monitor's stable machine identifier SHALL be the parent directory name of its `MONITOR.md` file.

#### Scenario: ID from folder name

- **WHEN** the file `.claude/monitors/release-notes/MONITOR.md` is parsed
- **THEN** the monitor's ID is `release-notes`

### Requirement: SP2 Monitor IDs are a correctness boundary

Monitor IDs MUST be unique within an evaluated monitor tree, because duplicate IDs risk aliasing persisted monitor state; a duplicate SHALL be treated as an error, not a cosmetic issue.

#### Scenario: Duplicate folder names in one tree

- **GIVEN** `a/build/MONITOR.md` and `b/build/MONITOR.md` in the same monitors tree
- **WHEN** the tree is validated
- **THEN** the duplicate ID `build` is reported as an error

### Requirement: SP3 Event identity and object identity are different

Each persisted event SHALL have its own event ID, distinct from its `objectKey`, which identifies the source-defined object being observed (such as a file path or URL).

#### Scenario: Two changes to one object

- **WHEN** the same file `docs/a.md` changes twice and each change is persisted
- **THEN** the two events share `objectKey` `docs/a.md`
- **AND** they have different event IDs

### Requirement: SP4 Unread, claimed, and acknowledged are distinct states

The system SHALL keep unread, claimed, and acknowledged as three distinct delivery states: delivering an event to a hook MUST NOT mark it read, claiming a delivery only records that the session has been notified, and acknowledgement MUST be a separate act.

#### Scenario: Claim does not acknowledge

- **GIVEN** an unread event for a session
- **WHEN** a hook claims a delivery containing that event
- **THEN** the event's delivery state becomes claimed, not acknowledged
- **AND** it remains in the session's unread set until explicitly acknowledged

### Requirement: SP5 Snapshot history is keyed by workspace, monitor, and object

Snapshots and diffs SHALL be keyed by workspace, monitor ID, and object identity, and a prior snapshot MUST only be compared against later observations of the same object in the same workspace and monitor.

#### Scenario: Same object key in two workspaces

- **GIVEN** monitor `docs` observes `README.md` in workspaces `/a` and `/b`
- **WHEN** `README.md` changes in `/b`
- **THEN** the diff for `/b` is computed against `/b`'s prior snapshot only, never `/a`'s

### Requirement: AP1 The runtime/session event pipeline is the authoritative delivery model

The authoritative integration path SHALL be monitor → observation → persisted `monitor_events` → `session_event_state` projection → hook delivery.

#### Scenario: Runtime-emitted event path

- **WHEN** a monitor emits an observation during a runtime tick
- **THEN** it is persisted as a `monitor_events` row and projected via `session_event_state` rows
- **AND** no `inbox_items` row is required for it to be delivered

### Requirement: AP2 The legacy inbox lifecycle is separate

The `inbox_items` state machine SHALL remain implemented and exposed, but it MUST NOT be treated as the authoritative delivery model for runtime-emitted monitor events, nor as another view of the same data.

#### Scenario: Acknowledging an event leaves the inbox untouched

- **WHEN** a session acknowledges a runtime-emitted event
- **THEN** no `inbox_items` row changes state as a result

### Requirement: AP3 The runtime is a poll-and-project engine

The runtime SHALL scan monitors, evaluate due sources, persist source state and notify state, emit events, and refresh hook state for matching sessions.

#### Scenario: One tick

- **WHEN** the runtime ticks over a monitors directory with one due monitor whose source reports a change
- **THEN** the source state and notify state are persisted
- **AND** an event is emitted and hook state is refreshed for matching sessions

### Requirement: AP4 Source registry drives validation and schema generation

The same registered source metadata SHALL define a source's name, the scope fields it expects, and the editor-facing schema produced for it; validation and schema generation MUST both derive from the source registry.

#### Scenario: Registry name used by both surfaces

- **WHEN** a source named `api-poll` is registered with a `scopeSchema`
- **THEN** `validate` checks `watch.type: api-poll` monitors against that `scopeSchema`
- **AND** `schema generate` includes `api-poll` in the `watch.type` enum with the same `scopeSchema`

### Requirement: AP5 No implicit multi-root merge

The runtime SHALL evaluate one supplied monitors directory at a time and MUST NOT implicitly merge enterprise, user, and project monitor roots.

#### Scenario: Single root evaluated

- **WHEN** the runtime is given a project monitors directory
- **THEN** only monitors under that directory are evaluated, with no user- or enterprise-level monitors merged in

### Requirement: AP6 CLI behavior derives from core contracts

Public CLI commands MAY wrap the core library, but they MUST NOT silently invent behavior that bypasses the core runtime and parsing model.

#### Scenario: CLI uses core validation

- **WHEN** `agentmonitors validate` checks a monitor's watch config
- **THEN** it uses the same core parsing and scope-validation contract as every other surface, not a CLI-only rule set

### Requirement: AP7 One pipeline, two authoring paths

Ephemeral, agent-declared, session-scoped monitors and persistent `MONITOR.md` monitors SHALL run on the same runtime machinery; ephemeral monitors MUST be an additional authoring and lifecycle path into the one pipeline, not a parallel system.

#### Scenario: Ephemeral monitor uses the shared pipeline

- **WHEN** an agent declares an ephemeral monitor and its source reports a change
- **THEN** the change is processed by the same tick, notify, materialization, and projection stages as a `MONITOR.md` monitor

### Requirement: BP1 Schedule matching is best-effort and non-backfilling

A scheduled trigger SHALL fire only when a runtime tick lands in a matching time window, and missed windows MUST NOT be replayed.

#### Scenario: Daemon down across a window

- **GIVEN** a schedule monitor matching `0 9 * * *`
- **WHEN** no tick runs between 09:00 and 09:01 and the next tick runs at 09:30
- **THEN** no observation is emitted for the missed 09:00 window

### Requirement: BP2 Hook delivery is advisory, not completion

Hook claims SHALL surface work to an agent and MUST NOT imply that the work is complete or acknowledged.

#### Scenario: Claimed work stays pending

- **WHEN** a hook claim surfaces an event to an agent
- **THEN** the event is not marked complete or acknowledged by that claim

### Requirement: BP3 Scope validation and source execution are separate concerns

Source-specific scope validation SHALL catch authoring mistakes early, but runtime source execution MUST remain the final authority on whether a source can actually observe its target.

#### Scenario: Valid scope, unreachable target

- **GIVEN** an `api-poll` monitor whose `url` is schema-valid but unreachable
- **WHEN** it is validated and then executed by the runtime
- **THEN** validation passes
- **AND** the failure is reported by source execution at runtime

### Requirement: BP4 Local artifacts are owner-private

All persisted data (the SQLite database and its WAL/SHM sidecars), hook state, and IPC artifacts (daemon socket, its directory, startup lock, coordination file) MUST be created owner-only — directories `0700`, files `0600`, sockets owner-only inside an owner-only directory. Pre-existing world-readable artifacts MUST be tightened on startup without following attacker-controlled symlinks (per `runtime/local-data-permissions`).

#### Scenario: Pre-existing world-readable database

- **GIVEN** an existing database file with mode `0644`
- **WHEN** the daemon starts
- **THEN** the file is tightened to `0600` without following an attacker-controlled symlink

### Requirement: BP4 Directory containment guards the unauthenticated socket

Because the daemon socket is unauthenticated, the system SHALL rely on owner-only directory containment, not socket permission bits, as the decisive guard against other local users.

#### Scenario: Socket directory is owner-only

- **WHEN** the daemon creates its socket
- **THEN** the socket's containing directory has mode `0700` and is owned by the daemon's OS user

### Requirement: NP1 Not a distributed event service

The system SHALL NOT define cross-machine consensus, centralized fan-out, or remote queueing.

#### Scenario: Single-machine scope

- **WHEN** events are persisted and delivered
- **THEN** all state lives in the local database of one machine, with no remote queue or replication

### Requirement: NP2 No exactly-once downstream side effects

The system SHALL persist observations and delivery metadata but SHALL NOT guarantee exactly-once downstream side effects; agent actions taken in response remain outside the runtime contract.

#### Scenario: Agent acts twice

- **WHEN** an agent performs an external action in response to an event more than once
- **THEN** the runtime neither prevents nor deduplicates that action

### Requirement: NP3 No third-party source discovery or installation

The CLI SHALL NOT implement third-party source discovery or installation; placeholder commands MUST NOT count as a supported plugin manager.

#### Scenario: Placeholder install command

- **WHEN** a user runs `agentmonitors source install some-plugin`
- **THEN** the command reports `Plugin installation is not yet implemented: some-plugin` and exits with code 1

### Requirement: NP4 Watch-mode execution is opt-in and additive

The runtime SHALL drive continuous `watch()` only for sources that implement it; `observe()` MUST remain required on every source as the fallback for one-shot ticks and unwatched monitors, and a watched monitor MUST be driven only by its watcher.

#### Scenario: Watched monitor is not double-processed

- **GIVEN** `daemon run` is watching a monitor whose source implements `watch()`
- **WHEN** a runtime tick runs
- **THEN** the tick skips that monitor's `observe()`

#### Scenario: One-shot tick uses observe

- **WHEN** `daemon once` runs a single tick
- **THEN** every due monitor is evaluated through its source's `observe()`

### Requirement: NP5 Not a cloud-agent delivery target

The system SHALL deliver to local agent hosts only and SHALL NOT target cloud-hosted agents while the only known integration path is a polling loop that contradicts the push model (pairs with NP1).

#### Scenario: Only local hosts are adapters

- **WHEN** delivery host adapters are enumerated
- **THEN** each targets an agent host running on the local machine
