## ADDED Requirements

### Requirement: Each new host is a new adapter

Supporting a new host SHALL mean adding a new adapter, never changing the runtime core (AP3). Every host
adapter SHALL satisfy the existing `AgentRuntimeAdapter` contract (`name`, `hookEventMap`,
`defaultHookStatePath`, `createSessionInput`, `materializeHookState`) and SHALL provide, for its host,
each contract dimension in this capability. Scope is local hosts only (NP5).

#### Scenario: Adding Codex

- **WHEN** a Codex adapter is added
- **THEN** no runtime-core module changes to accommodate Codex-specific hook names or identity signals

### Requirement: Adapters map lifecycle events without inventing them

An adapter SHALL map each of the seven `AgentLifecycleEvent`s (`session-opened`, `session-dormant`,
`turn-interruptible`, `turn-ended`, `turn-idle`, `pre-compact`, `post-compact`) to its host's concrete
lifecycle hook. A host lacking an analogue MUST omit that event rather than invent one; the durable event
stays recoverable at the next supported lifecycle (PP1).

#### Scenario: Host without a pre-compact hook

- **WHEN** a host has no compaction hook
- **THEN** its adapter omits `pre-compact` and unread events are still delivered at the next supported lifecycle

### Requirement: Adapters deliver only at advisory-injection events

An adapter SHALL identify which host events correspond to the `DeliveryLifecycle`s (`turn-interruptible`,
`turn-idle`, `post-compact`) and which honor advisory, non-blocking context injection, and MUST emit
delivery only at events that honor it.

#### Scenario: Event that ignores injected context

- **WHEN** a host event ignores advisory context
- **THEN** the adapter emits no delivery at that event

### Requirement: Adapters resolve the host session id

An adapter SHALL resolve the host session id (`hostSessionId`) for an invocation by a documented, stable
mechanism (stdin, environment variable, or host-specific), and the resolved value MUST equal the id the
session was opened under (`session open --host-session-id …`), so events project into the right session.

#### Scenario: Same id from two mechanisms

- **WHEN** a host exposes its session id to hooks via stdin and to MCP servers via an environment variable
- **THEN** both resolve to the same `hostSessionId`

### Requirement: Adapters resolve the workspace path

An adapter SHALL resolve the workspace path (`workspacePath`) for an invocation by a documented mechanism
(environment variable, process cwd, a `roots/list` analogue, or an explicit flag), so per-workspace daemon
isolation and workspace-scoped projection hold.

#### Scenario: Workspace from cwd

- **WHEN** a host provides only the process cwd as the workspace signal
- **THEN** the adapter resolves `workspacePath` from it and connects to that workspace's daemon

### Requirement: Adapters provide delivery-surface state

An adapter SHALL provide a per-session delivery-surface state location and serialization its host
integration reads, and SHOULD reuse the host-generic path shape
`<workspace>/.agentmonitors/sessions/<encoded-session>/hook-state.json` unless the host requires otherwise.

#### Scenario: Default path reused

- **WHEN** a new adapter has no host-specific state-location requirement
- **THEN** its default state path uses the shared hook-state path shape

### Requirement: Adapters provide a portable baseline transport

An adapter SHALL provide a portable baseline transport that always works for its host (the hook-state /
advisory-injection analogue). Any richer transport the host offers (an MCP/push analogue) MUST be
additive and MUST NOT change delivery semantics: same events, urgency, and unread/claimed/acknowledged
model (NP-CH generalized).

#### Scenario: Richer transport unavailable

- **WHEN** a host's push transport is disabled by policy
- **THEN** delivery completes through the host's baseline transport with no error

### Requirement: Host-generic rules are inherited unchanged

Host-generic rules — consume `DeliveryClaim` without re-deriving, claimed-not-acknowledged (BP2), lead-only
projection, urgency/lifecycle preservation, cross-transport dedup via claimed state, content safety,
availability/fallback, and the Interpret-adapter boundary — MUST NOT be re-decided per host; each adapter
re-provides only Claude-specific concerns.

#### Scenario: Dedup on a new host

- **WHEN** a Codex adapter has both a baseline and a push transport
- **THEN** cross-transport dedup uses the same claimed state, with no host-specific dedup mechanism

### Requirement: Claude-specific mechanisms are not assumed for other hosts

Claude-specific concerns — `hookEventMap` values, the hook stdin contract (`session_id`,
`hook_event_name`, `cwd`), the context-event set and `additionalContext` wire shape, the `<channel>`
mechanism and field schema, the binding signals `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PROJECT_DIR` /
`roots/list`, and activation packaging — MUST NOT be assumed for another host without a probe.

#### Scenario: Cursor identity signal

- **WHEN** a Cursor adapter is designed
- **THEN** its session-identity signal is taken from a Cursor probe, not from the Claude Code env var

### Requirement: Matrix cells are pinned by a per-host probe

Each host's matrix cells (lifecycle mapping, delivery points, session identity, workspace binding,
state, baseline transport, richer transport) MUST be confirmed by a per-host probe diagnostic, recording
the host version, before that adapter is treated as current. The in-scope surfaces are Claude Code, Codex,
and Cursor, each CLI and desktop/IDE.

#### Scenario: Unprobed signal

- **WHEN** a Codex session-identity mechanism is plausible but not yet probed
- **THEN** the Codex adapter is not shipped as current

### Requirement: One adapter per host with an internal surface branch

A host's CLI and desktop/IDE surfaces SHOULD be served by one adapter when they share mechanisms. If they
expose different mechanisms, the adapter MUST branch internally on `surface: 'cli' | 'desktop'` rather than
misreport one surface's mechanism for the other, and MUST NOT be split into two adapters duplicating the
host's delivery semantics.

#### Scenario: Desktop offers only an MCP surface

- **WHEN** a host's CLI uses stdin hooks but its desktop surface offers only an MCP/extension surface
- **THEN** one adapter for that host handles both, selecting the mechanism by `surface`

### Requirement: Delivery semantics are invariant across hosts

Adding a host MUST NOT change any delivery semantic: events, urgency bands, and the three delivery
lifecycles are identical to Claude's; surfacing claims and never acknowledges (BP2, SP4); only lead
sessions receive deliveries; and agent-facing verbs and ephemeral monitors resolve session identity through
the adapter's session-identity dimension, so they work on every supported host.

#### Scenario: High urgency on Codex

- **WHEN** a `high` event fires for a Codex lead session
- **THEN** it surfaces only after the same settle window as on Claude Code and is claimed, not acknowledged

### Requirement: Host adapters ship with conformance evidence

Each host adapter MUST ship with an integration test driving the host's real input contract (actual
lifecycle-hook command strings and stdin/env payload shape) through boot, deliver, and deregister; a
binding-probe artifact recording the host version and confirming identity and workspace signals; and proof
that delivery semantics match the Claude adapter.

#### Scenario: Adapter PR without a probe artifact

- **WHEN** a host adapter is proposed without a binding-probe artifact
- **THEN** it does not meet the conformance bar to ship as current
