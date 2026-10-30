# delivery/transport-seam Specification

## Purpose

Defines the last hop of delivery: how an already-materialized `DeliveryClaim` is surfaced into a host
agent session by one or more delivery transports, the rules every transport obeys, the boundary to the
upstream Interpret adapter, the availability/fallback contract (NP-CH), hooks-only operation, and what is
out of scope. What is worth delivering and when is owned by the runtime (`delivery/lifecycles`).

## Requirements

### Requirement: Transports consume runtime-produced claims

Every delivery transport SHALL consume the `DeliveryClaim` / `DeliveryEventSummary` the runtime already
produces and MUST NOT re-derive what is worth delivering (PP4, AP1, AP6). A transport only chooses the
surface on which the claim is rendered.

#### Scenario: Transport renders the runtime's events unchanged

- **WHEN** the runtime returns a `DeliveryClaim` carrying events E1 and E2 for a session
- **THEN** any transport that surfaces it renders exactly E1 and E2 (or a whole-block prefix of them under its size cap, per the owning transport)
- **AND** it never adds, drops, or reorders events based on its own delivery decision

### Requirement: Transports preserve urgency and lifecycle semantics

Every transport SHALL preserve the urgency and lifecycle semantics defined by the `delivery/lifecycles`
capability: settled `high` events surface at `turn-interruptible` after the settle window, and `normal`
/ `low` coalesce into reminders. A transport changes only the surface, never the timing.

#### Scenario: High-urgency event before the settle window

- **WHEN** a `high` event is younger than the settle window and a transport polls or fires
- **THEN** the transport surfaces nothing for that event until the runtime offers it as settled

### Requirement: Surfacing claims but never acknowledges

A transport SHALL mark the rows it surfaces **claimed** and MUST NOT acknowledge them (BP2).
Acknowledgement remains a separate, explicit act (SP4) — `agentmonitors events ack` or the
`agentmon_ack` channel tool.

#### Scenario: Surfaced event stays unread

- **WHEN** a transport surfaces event E for session S
- **THEN** E's delivery state for S becomes claimed
- **AND** E is still returned by `agentmonitors events list --session S --unread` until it is acknowledged

### Requirement: Transports deliver only to lead sessions

A transport SHALL deliver only to **lead** sessions, respecting projection as defined by the
`delivery/session-projection` capability; subagent sessions never receive transport deliveries.

#### Scenario: Subagent session receives nothing

- **WHEN** a workspace has a lead session L and a subagent session A and a monitor fires
- **THEN** transports surface the event only to L

### Requirement: The transport boundary is the daemon IPC surface

The system SHALL realize the transport seam as the daemon IPC surface (per `daemon/ipc`) rather than an
in-process transport type: a transport is anything that drives that IPC (`session.open`, `hook.reserve`
/ `hook.commit` / `hook.release`, `hook.claim`, `events.ack`) to surface `DeliveryClaim`s while
honoring the rules of this capability. The channel transport runs out-of-process over that IPC.

#### Scenario: Channel transport adds no core delivery logic

- **WHEN** the channel transport surfaces a claim
- **THEN** it obtains, reserves, and commits that claim exclusively through daemon IPC methods
- **AND** the delivery decision it surfaces is the same core decision the hook path reaches

### Requirement: Runtime delivery messages carry no attribution

The runtime SHALL emit an unattributed, transport-neutral `DeliveryClaim.message` (for a
`normal`/`low` reminder: `Monitored changes are pending.`) naming no CLI verb, and MUST NOT embed a
source label. Each transport MUST supply its own attribution and its own action step (issues #438, #434),
so a new surface chooses its phrasing without editing the runtime (AP3).

#### Scenario: Two transports render one reminder claim

- **WHEN** one `normal` reminder claim is rendered by the hook-deliver transport and by the channel transport
- **THEN** the hook rendering starts with `AgentMon: ` and appends a CLI acknowledge step
- **AND** the channel rendering has no prefix and appends an `agentmon_ack` step
- **AND** both carry the same runtime message `Monitored changes are pending.`

### Requirement: Per-event delivery block is shared across transports

Body-injecting transports SHALL render each event as the same shared block: `### <monitor_id> (<urgency>)`,
then the title (the monitor's authored name), then the `objectDetail` line, then the digest line, a blank
line, the monitor `body`, and — only when `diffText` is non-empty — a blank line, `Changes:`, and the
bounded `diffText`. Transports differ only in sanitization and size ceiling.

#### Scenario: Block for an event with a diff

- **WHEN** event E of monitor `build-config-drift` (urgency `high`, title `package.json changed`, body `Review whether build behavior or dependency state needs updating.`, non-empty `diffText`) is rendered
- **THEN** the block begins `### build-config-drift (high)` then `package.json changed`
- **AND** it contains the body text followed by a `Changes:` section with the diff

#### Scenario: Block for an event without a diff

- **WHEN** an event's `diffText` is absent or empty
- **THEN** the block contains no `Changes:` section

### Requirement: Redundant detail and digest lines are omitted

In the shared per-event block the `objectDetail` line (the source's deterministic per-object text, never
an Interpret digest) SHALL be omitted when it equals the title or the body. The digest line
(`DeliveryEventSummary.summary`) SHALL be omitted when it equals the title, the body, or the
`objectDetail` line; otherwise both are kept so object identity and an Interpret digest both survive.

#### Scenario: Monitor with no authored name

- **WHEN** an event's title fell back to the same text as its `objectDetail`
- **THEN** the `objectDetail` line is not rendered a second time

#### Scenario: Summary derived from body

- **WHEN** a source supplied only title and body, so `objectDetail` and `summary` equal the body
- **THEN** neither the detail line nor the digest line repeats the body

#### Scenario: Interpret digest differs from object detail

- **WHEN** `objectDetail` is `Incoming change: docs/specs/001.md (modified)` and `summary` is a distinct Interpret digest
- **THEN** both lines are rendered (issue #449)

### Requirement: Change summary is bounded per event

The shared per-event block SHALL bound each event's `diffText` to 800 characters and, when it elides,
append the marker `… (change summary truncated)`, independent of how many events fit in the delivery.

#### Scenario: Oversized diff

- **WHEN** an event's `diffText` is 5000 characters
- **THEN** the rendered `Changes:` section carries at most 800 characters of it followed by `… (change summary truncated)`

### Requirement: Injecting transports keep identity out of untrusted content

Any transport that injects content into the agent's context SHALL treat AgentMon event content as
untrusted (watched sources such as API bodies and file diffs), SHALL bound surfaced content rather than
dumping full untrusted bodies, and SHALL carry identity/routing references (object keys, paths) as
metadata when the surface offers metadata, never interpolated into content.

#### Scenario: Large untrusted body

- **WHEN** a watched API returns a multi-megabyte body that becomes an event's diff
- **THEN** no transport injects it wholesale; per-event and per-delivery bounds apply

### Requirement: Interpret invocation lives behind an adapter boundary

The host-specific invocation of the user's own AI tool for the optional Interpret stage (e.g.
`claude -p …`) SHALL live behind the `InterpretAdapter` boundary and MUST NOT live in the runtime core
(AP3). Because Agent Monitors ships no model and holds no credentials (PP10), the adapter inherits the
user's existing data-governance and egress posture.

#### Scenario: Runtime core has no host tool invocation

- **WHEN** the Interpret stage is enabled for a `prose` monitor
- **THEN** the runtime invokes the configured `InterpretAdapter`, and the concrete tool/argv is supplied only by that adapter
- **AND** with no adapter configured the stage is disabled

### Requirement: The Interpret adapter is upstream of transports

The Interpret adapter SHALL run after Diff and before Deliver (per `pipeline/post-processing`) to
produce, or suppress, a packet's `prose` content; it is not a delivery transport. Transports run at
Deliver, surface the already-produced content, and MUST NOT invoke Interpret or re-derive its outcome.

#### Scenario: Suppressed by Interpret

- **WHEN** the Interpret significance gate suppresses an event for a recipient
- **THEN** no transport surfaces that event's packet to that recipient

### Requirement: Hook-based delivery is the default and channels are additive

The hook-state / hook-deliver transport SHALL always be the default and MUST NOT depend on Claude Code
channels (NP-CH). The channel transport is optional and additive, because it may be unavailable:
Claude Code v2.1.80+ with channels in research preview, Team/Enterprise admin `channelsEnabled`, custom
channels on the org allowlist (or the development flag), and enterprise MCP-server restrictions.

#### Scenario: Environment without channels

- **WHEN** an environment runs Claude Code without channel support
- **THEN** events are delivered through the hook-deliver transport with no configuration change

### Requirement: Enabling the channel does not change delivery semantics

Enabling the channel transport MUST NOT change delivery semantics: the same events, the same urgency, and
the same unread / claimed / acknowledged model; only the surface differs.

#### Scenario: Same event, either surface

- **WHEN** the same settled `high` event is surfaced once with the channel enabled and once without
- **THEN** the claimed rows, urgency, and lifecycle are identical; only the rendering surface differs

### Requirement: A blocked channel is an expected condition

If the channel is not loaded or is blocked, the host drops its notifications silently; AgentMon MUST treat
this as expected (the durable event remains deliverable via the hook path) and MUST NOT surface an error.

#### Scenario: Channel disabled or blocked

- **WHEN** the channel transport is disabled or blocked and a monitor fires
- **THEN** delivery still completes via the hook path
- **AND** no error is surfaced to the user or agent

### Requirement: MCP is never required

The hook-deliver transport plus the CLI `session` / `hook` / `events` commands SHALL be a complete
delivery surface: every channel capability — delivery, claiming, acknowledgement, status — MUST be
reachable through hooks and the CLI alone over the same daemon IPC. A restricted environment installs
the CLI and the plugin's `hooks/hooks.json` and omits or blocks `.mcp.json`.

#### Scenario: Hooks-only delivery parity (issue #270)

- **WHEN** `session start` is fed a real `SessionStart` stdin payload, a monitor fires, `hook deliver` is fed a real `UserPromptSubmit` stdin payload, then `events ack` and `events list` run
- **THEN** the event is delivered, claimed, acknowledged, and reported as acknowledged
- **AND** the channel/MCP code path is never imported, started, or referenced

### Requirement: Channel and hook paths share the same daemon IPC

The `agentmon_ack` tool SHALL acknowledge through the same daemon-IPC client path as `agentmonitors
events ack`; the channel push and `hook deliver` SHALL both drive reserve → commit / release rather than
a direct claim. Only the manual, single-shot `hook claim` command claims directly. All paths bottom out on
the same core delivery decision and daemon methods.

#### Scenario: Capability parity

- **WHEN** the channel ack tool and the `events ack` command are each used to acknowledge event E
- **THEN** both invoke the same daemon `events.ack` method with the bound session id

#### Scenario: Neither transport consumes before surfacing

- **WHEN** the channel push or the hook write fails before surfacing
- **THEN** the reservation is released and no row is durably claimed

### Requirement: Permission relay is out of scope

The system SHALL NOT implement Claude Code channel permission relay (`claude/channel/permission`,
`notifications/claude/channel/permission_request` / `permission`): AgentMon is a work-signal system,
not a tool-approval bridge.

#### Scenario: Channel capabilities exclude permission relay

- **WHEN** the channel server advertises its capabilities
- **THEN** it declares `experimental['claude/channel']` and `tools` only, never `claude/channel/permission`

### Requirement: Inbound channel messages are not a source

The system SHALL NOT consume inbound channel messages as an observation source: channels push into a
session, not into the daemon.

#### Scenario: No channel source

- **WHEN** the bundled source registry is listed
- **THEN** it contains no source that reads Claude Code channel messages
