# 007 — Agent-Facing Interaction, Ephemeral Monitors & Observability

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [002-runtime-delivery.md](./002-runtime-delivery.md), [005-cli-reference.md](./005-cli-reference.md), [006-agent-integration.md](./006-agent-integration.md)
> **Covers:** the agent-facing interaction model (how an agent _acts on_ a pushed signal),
> the agent-facing CLI verbs (snapshot / point-to-point diff / payload summary), the
> **ephemeral-monitor** model (agent-declared, session-scoped watches on the one pipeline), and
> the **observability surface** (received / pending / condition-met-but-not-yet-fired)

---

> **Whole-document status: _target_.** Every normative rule in this document is **target** — it
> describes the intended contract for the multi-host, agent-facing direction greenlit in the
> 2026-06-19 strategy call (Epic #259), not behavior that ships today. Each rule **MUST** be moved
> to _current_ status, with `verified:` references to the implementing code and tests, when it
> ships; retire the matching [roadmap.md](./roadmap.md) gap and add a
> [spec-changelog.md](./spec-changelog.md) entry at that time ([004 §5–§6](./004-validation-testing.md)).
> Where this document extends a surface that is already _current_ (e.g. the daemon IPC of
> [002 §10](./002-runtime-delivery.md), the delivery transports of [006](./006-agent-integration.md)),
> that underlying surface stays current; only the **new** agent-facing additions are target.

## 1. Overview

[006](./006-agent-integration.md) specifies the **daemon → agent** direction: how an
already-materialized `DeliveryClaim` is surfaced into a session (the "last hop"). This document
specifies the complementary **agent → daemon** direction: how an agent, once a signal has been
pushed to it, **acts on** that signal, and how an agent **declares** what it wants watched — while
still performing **no watching mechanics itself** (PP9). It also specifies the read-only
**observability** surface an agent (or a human) uses to inspect the state of its signals.

These are new first-class surfaces, distinct from delivery transports. They are given their own
numbered document rather than folded into [006](./006-agent-integration.md) because delivery
(daemon → agent) and agent-driven request/declaration (agent → daemon) are opposite directions with
different contracts; conflating them under "Delivery Transports" would mis-model the boundary.

### Why an agent-facing surface at all?

The push model ([006](./006-agent-integration.md)) tells the agent _that_ something changed. To
_act_ well, the agent frequently needs cheap, bounded follow-up reads — "show me the current state
of the thing that changed", "what changed between the last two points", "give me a one-line
orientation" — without re-fetching the watched resource itself and without standing up its own
watching loop. Providing these as first-class, **read-only** daemon verbs keeps the agent on the
right side of PP9/PP10: the daemon already holds the durable snapshots, diffs, and event history
([002 §5.2, §15](./002-runtime-delivery.md)); the agent reads them, it does not re-observe.

### Principles satisfied

| Section                             | Principles               |
| ----------------------------------- | ------------------------ |
| Agent-facing interaction model (§2) | PP9, PP10, AP3, AP6      |
| Agent-facing CLI verbs (§3)         | PP9, PP10, AP6, SP5      |
| Ephemeral monitors (§4)             | PP1, PP9, PP10, AP7, SP1 |
| Observability surface (§5)          | PP4, PP7, SP4, BP2       |

> **NP-AF (non-property, this doc):** the agent-facing verbs (§3) and the observability surface
> (§5) are **reads and declarations only**. They **MUST NOT** cause the agent to poll, block, or run
> a background waiting loop; an agent invokes them **in response to a pushed signal or at its own
> turn boundary**, never on a timer of its own. All waiting stays daemon-owned (PP9). This is the
> local-agent-only companion to [NP5](./000-principles.md) — the surface is delivered to local hosts
> and never implies an internet-visible or cloud-agent-waking path.

## 2. The Agent-Facing Interaction Model (_target_)

### 2.1 Acting on a pushed signal is a read, not a re-observation

When a signal is pushed (via any transport in [006](./006-agent-integration.md)) the agent **MAY**
act on it through the daemon's **read-only** agent-facing verbs (§3). Each such verb:

- **MUST** read only from durable state the daemon already holds — snapshots
  (`monitor_snapshots`), events (`monitor_events`), per-recipient cursors
  (`session_object_cursor`), and delivery state (`session_event_state`) — and **MUST NOT** trigger a
  fresh source `observe()`/`watch()` (that is runtime-owned scheduling, AP3/PP9);
- **MUST** be side-effect-free with respect to **delivery** state: reading a snapshot, a diff, or a
  summary **MUST NOT** claim, acknowledge, or advance any recipient cursor. It is **not** a
  `hook claim` (which is advisory surfacing that marks rows claimed — [002 §9.4](./002-runtime-delivery.md),
  BP2). The unread / claimed / acknowledged state (SP4) is unchanged by an agent-facing read;
- **MUST** be bounded and cheap — sized for an agent context window, not a full resource dump
  (mirroring the content-safety bound in [006 §4.6](./006-agent-integration.md)).

### 2.2 Distinct from delivery and from acknowledgement

| Surface                                                         | Direction      | Effect on delivery state                                     |
| --------------------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| Delivery transport ([006](./006-agent-integration.md))          | daemon → agent | marks rows **claimed** (not acknowledged, BP2)               |
| `hook claim` / channel push ([006](./006-agent-integration.md)) | daemon → agent | marks rows **claimed**                                       |
| `events ack` ([005 §11.2](./005-cli-reference.md))              | agent → daemon | marks rows **acknowledged** (SP4)                            |
| **Agent-facing read (§3)**                                      | agent → daemon | **none** — pure read                                         |
| **Ephemeral declare (§4)**                                      | agent → daemon | registers a session-scoped monitor; no delivery-state change |

### 2.3 Transport is an implementation detail

The wire under the agent-facing verbs (loopback HTTP vs the existing Unix-domain-socket IPC of
[002 §10](./002-runtime-delivery.md)) is an **implementation detail**, to be settled by dogfooding.
Requirements on it:

- it **MUST** bias **asynchronous** request/response — a verb returns the current durable answer
  immediately; it **MUST NOT** implement a blocking long-poll that waits for a future change (that
  would reintroduce agent-side waiting, violating PP9);
- it **MUST** preserve the per-workspace isolation and socket-path resolution already specified for
  the daemon ([002 §10.2–§10.3](./002-runtime-delivery.md)); a new loopback-HTTP option, if chosen,
  **MUST** bind loopback-only and stay on-device (NP1, NP5, NP-AF);
- the choice **MUST NOT** change the semantics of any verb — the same durable answer regardless of
  transport, exactly as [006 §6](./006-agent-integration.md) requires of delivery transports.

## 3. The Agent-Facing CLI Contract (_target_)

The concrete `agentmonitors` command surface for these verbs is specified as **target** command
sections in [005 §14](./005-cli-reference.md); this section fixes their **semantics**. All three are
read-only (§2.1) and support the standard `--format` shapes ([005 §1](./005-cli-reference.md)).

### 3.1 Snapshot fetch

`agentmonitors snapshot <monitorId> [--object <objectKey>] [--session <id>]` returns the **current
stored snapshot** for a watched object.

- It **MUST** return the latest `monitor_snapshots` content for
  `(workspacePath, monitorId, objectKey)` (SP5) — the same text the runtime diffs against
  ([002 §5.2](./002-runtime-delivery.md)) — and nothing more.
- When a monitor watches exactly one object, `--object` **MAY** be omitted. When it watches
  multiple objects and `--object` is omitted, the command **MUST** list the available object keys
  rather than guess (it **MUST NOT** silently pick one).
- It **MUST NOT** re-fetch the underlying resource; a snapshot older than the last successful
  observation is the correct, honest answer (freshness is the runtime's scheduling concern, AP3).

> **Example.** A `file-fingerprint` high-urgency delivery fires for
> `object_key = /repo/package.json`. The agent runs
> `agentmonitors snapshot build-config-drift --object /repo/package.json` and receives the full
> current stored text of `package.json` as the daemon last observed it — no filesystem read, no
> claim, no cursor move.

### 3.2 Point-to-point diff

`agentmonitors diff <monitorId> --object <objectKey> [--from <point>] [--to <point>] [--session <id>]`
computes a textual diff of one observed object **between two stored points in time**.

- A `<point>` **MUST** be expressible as either a durable `monitor_events` **event id** (whose
  snapshot is the anchor) or an ISO-8601 timestamp (resolved to the snapshot at or immediately
  before that instant).
- Omitting `--from` **MUST** default to the recipient session's own baseline cursor
  (`session_object_cursor.baseline_content`, [002 §1.1.2](./002-runtime-delivery.md)); omitting
  `--to` **MUST** default to the latest stored snapshot. So a bare
  `agentmonitors diff <monitorId> --object <k>` answers "what has changed for me since my baseline",
  reusing the per-recipient seam rather than a new diff engine (AP6).
- The diff **MUST** be computed with the same `buildDiff` (strategy-aware; §5.2) the runtime uses
  ([002 §1.1.2, §5.2](./002-runtime-delivery.md)) so agent-visible diffs match delivered diffs —
  structural for a `strategy: json-diff` object, line-based otherwise (issue #437).
- It is a **pure read**: it **MUST NOT** advance the cursor or alter delivery state (§2.1).

> **Snapshot-retention dependency.** A two-arbitrary-point diff requires that historical
> `monitor_snapshots` rows for the referenced points still exist. The implementing work **MUST**
> define a retention floor (or reject a `<point>` whose snapshot has been pruned with a clear
> error) rather than silently returning an empty diff. See §8.

### 3.3 Payload summary

`agentmonitors summary <monitorId> [--session <id>]` (or `--object <objectKey>`) returns a
**lightweight orientation** for a signal without its full body or diff.

- It **MUST** return only cheap, already-materialized facets — monitor id, `objectKey`, urgency,
  `changeKind`, unread/claimed counts, and the event `title`/`summary` — drawn from
  `monitor_events` + `session_event_state`. It **MUST NOT** include the full snapshot text or the
  full diff (those are the `snapshot`/`diff` verbs).
- It is the cheapest act-on-signal read: an agent that only needs to decide _whether_ to look uses
  `summary`; one that needs the content uses `snapshot`/`diff`.

## 4. Ephemeral Monitors (_current_)

> **Status: current** (Refs #312). The ephemeral-monitor model of §4 is implemented: agents declare
> session-scoped monitors via `agentmonitors watch` (005 §14.4), the daemon persists them durably and
> runs them on the same tick/notify/materialize/project pipeline as persistent monitors (AP7), their
> events project into the declaring session only (§4.6 isolation), and they are reaped on session
> close, on `watch cancel`, and on per-session dormancy (§4.4). Moved target → current when it shipped
> (process: [004 §5–6](./004-validation-testing.md)); the §8 decisions are resolved below. The rest of
> this document (§2, §3, §5) remains _target_.
>
> Verified:
> `libs/core/src/inbox/schema.ts` (`ephemeral_monitors` table) ·
> `libs/core/src/runtime/service.ts` (`declareEphemeralMonitor`, `listEphemeralMonitors`,
> `cancelEphemeralMonitor`, `ephemeralRecordToMonitor`, `reapDormantSessions`, the ephemeral pass of
> `tick()` via `evaluateMonitorOnTick`, and reap-on-`closeSession`) ·
> `libs/core/src/runtime/store.ts` (`insertEphemeralMonitor`, `listActiveEphemeralMonitors`,
> `listEphemeralMonitorsForSession`, `reapEphemeralMonitor`, `reapEphemeralMonitorsForSession`,
> `staleActiveSessions`, and the `restrictToSessionId` projection gate in `insertEvent` — which also
> re-checks the ephemeral monitor is still `active` at insert so a `watch cancel`/close that races an
> in-flight tick projects nothing, and keeps ephemeral events out of an unscoped `listEvents`) ·
> `apps/cli/src/commands/watch.ts` + `apps/cli/src/daemon-ipc.ts` (`watch.declare|list|cancel`) ·
> `libs/core/src/runtime/ephemeral-monitors.test.ts` and the
> `describe('ephemeral monitors: watch declare/list/cancel (007 §4 / 005 §14.4)')` suite in
> `apps/cli/src/commands/cli.integration.test.ts`.

### 4.1 Definition and scope

An **ephemeral monitor** is an agent-declared, **session-scoped** monitor handled by the **same
daemon and the same pipeline** ([002 §1.1](./002-runtime-delivery.md)) as a persistent `MONITOR.md`
monitor. It differs from a persistent monitor only in **authoring path** and **lifetime** — it is
declared at runtime by an agent (not authored as a file) and its lifetime is bound to the declaring
session. This is the direct realization of **AP7** ("one pipeline, two authoring paths"): ephemeral
monitors are an additional authoring and lifecycle path into the one pipeline, **not** a parallel
system. All the semantic properties of a monitor still hold — urgency ([000 PP5](./000-principles.md)),
notify/pace ([002 §4](./002-runtime-delivery.md)), snapshots/diffs (SP5), projection into lead
sessions ([002 §6](./002-runtime-delivery.md)), and the three delivery states (SP4).

### 4.2 Declaration

An agent declares an ephemeral monitor through the agent-facing declare verb
(`agentmonitors watch …`, [005 §14](./005-cli-reference.md)), expressing intent of the form **"tell
me when _X_, and remind me of _this instruction_ when it does."** A declaration:

- **MUST** name a registered source ([003](./003-source-plugins.md)) and a source-`scopeSchema`-valid
  scope — the declaration is validated by the **same** `validateScope` path as `agentmonitors
validate` ([004 §2.2](./004-validation-testing.md)), so an ephemeral monitor cannot express a config a
  persistent monitor could not (AP4, BP3);
- **MAY** carry an `urgency` (default `normal`, matching persistent monitors) and an
  **instruction** — free-text handling guidance that becomes the monitor's body (the ephemeral
  equivalent of a persistent monitor's markdown body). It is surfaced on delivery as
  `DeliveryEventSummary.body` ([002 §9.1](./002-runtime-delivery.md)) as a **fallback**: an
  observation that carries its own `body` overrides it (`observation.body ?? monitor.instructions`),
  so the reminder arrives with the agent's own instruction attached unless the source supplied a more
  specific body;
- **MUST** bind to a resolved AgentMon session (the declaring session, resolved by the adapter's
  session-identity mechanism, [006 §11](./006-agent-integration.md)); an unbindable declaration
  **MUST** be rejected, not silently made global. The bound session **MUST** be a **lead** session:
  projection delivers to lead sessions only (§4.6, [002 §6](./002-runtime-delivery.md)), so a binding
  to a subagent session would observe forever but never deliver — a silently-dead watch. A declaration
  against a non-lead session **MUST** be rejected at declaration time with a clear error, not
  registered.

The declaration performs **no watching**: it registers intent and returns. The daemon does all
subsequent observation, scheduling, notify timing, persistence, projection, and delivery (§4.5).

### 4.3 Identity

A persistent monitor's identity is directory-derived (SP1). An ephemeral monitor has no directory,
so it **MUST** be assigned a distinct, stable **runtime identity** that:

- is **unique within its daemon/session scope** (SP2 — IDs are a correctness boundary, so ephemeral
  IDs **MUST NOT** collide with each other or with any persistent monitor id in the same workspace);
- is **namespaced** so it is never mistaken for a directory-derived id (e.g. a reserved prefix such
  as `ephemeral:<session>/<slug>`), keeping `monitor_events.monitor_id`, `monitor explain`, and
  `queryScope` filtering unambiguous;
- is **stable for the monitor's lifetime** so its snapshots/cursors/events key correctly (SP5).

> **Decision resolved (§8, Refs #312):** the ephemeral-id scheme is the reserved prefix
> **`ephemeral:<sessionId>/<ulid>`**. It is collision-proof against persistent ids by construction:
> a directory-derived persistent monitor id (SP1) is a **single path segment** and therefore can
> never contain a `/`, while every ephemeral id does — so no persistent id can equal one. The
> `ephemeral:` prefix keeps `monitor_events.monitor_id`, `monitor explain`, and `queryScope`
> filtering unambiguously namespaced; the `<ulid>` slug is unique (and, with `<sessionId>`, unique
> within the daemon scope); the id is assigned once at declaration and never mutated (stable).

### 4.4 Lifecycle (bound to the declaring session)

An ephemeral monitor's lifetime is **bound to its declaring session's lifetime**:

- it becomes active on declaration and is evaluated on the normal runtime tick
  ([002 §2](./002-runtime-delivery.md)) exactly like a persistent monitor;
- it **MUST** be **reaped** when its declaring session **ends** (explicit session close,
  [002 §6.1](./002-runtime-delivery.md)) — an ephemeral monitor **MUST NOT** outlive its session or
  leak into another session (session isolation). Reaping when the session transitions to **dormant**
  (without an explicit close) is required too, now defined by the **per-session dormancy trigger** of
  [002 §6.2](./002-runtime-delivery.md) (Refs #312): a session that has not advanced its
  `lastActiveAt` for at least `DEFAULT_SESSION_DORMANCY_MS` is treated as dormant, and the runtime
  transitions it and reaps its ephemeral monitors at the start of the next tick — a backstop for a
  session that vanished without an explicit close. (The daemon's own idle self-termination,
  [002 §10.2](./002-runtime-delivery.md), is a **different** concern: it reaps the _daemon_ after all
  active sessions for a workspace hit zero, not an individual session.)
- an agent **MAY** cancel it earlier (`agentmonitors watch cancel <id>`), which reaps it immediately;
- while the session lives, the ephemeral monitor and its durable state (source state, snapshots,
  per-recipient cursors, unread/claimed/acknowledged rows) **MUST survive a daemon restart and a
  reboot** (the same durability floor as persistent monitors, PP1) — a restart within the session's
  life re-hydrates it, a restart after the session has ended does not resurrect it.
- reaping an ephemeral monitor **MUST** clean up its runtime registration and stop further
  observation. **Decision resolved (§8, Refs #312):** its already-materialized `monitor_events` (and
  their `session_event_state` projections) are **retained**, not pruned — reaping flips the ephemeral
  record's status `active` → `reaped` (stamping `reaped_at`) but never deletes it or its events, and
  the declaring session goes _dormant_ (not deleted), so an event materialized just before reap stays
  unread/deliverable and inspectable (PP1). Retention also makes resurrection structurally
  impossible: a reaped record is never re-armed on a later restart.

### 4.5 Deterministic work stays daemon-owned

Everything deterministic about an ephemeral monitor — observation, change detection, scheduling,
notify timing, persistence, diffing, projection, and delivery — is **daemon-owned** (PP9, PP10, AP3).
The agent's role is **declare and move on**. In particular:

- the agent **MUST NOT** be required to re-invoke, refresh, or "keep alive" an ephemeral monitor;
  the daemon ticks it (PP9);
- an ephemeral monitor **MUST NOT** cause any model call in the daemon core; if its `payload.form`
  is `prose` the optional Interpret stage runs via the user's own AI tool behind the adapter, exactly
  as for persistent monitors ([002 §1.1.8](./002-runtime-delivery.md), PP10) — never in the daemon
  core.

### 4.6 Same pipeline, same transports

An ephemeral monitor's events flow through the identical stages
([002 §1.1.1](./002-runtime-delivery.md)) and are delivered through the identical transports
([006](./006-agent-integration.md)) as persistent-monitor events. There is **no** ephemeral-only
delivery path. Because the declaring session is (by construction) a lead session, projection
([002 §6](./002-runtime-delivery.md)) delivers its events to that session; ephemeral events **MUST
NOT** project into other sessions merely because they share a workspace (they are scoped to the
declaring session).

The isolation is a **read** invariant as well as a projection one: an ephemeral monitor's
instruction is the declaring session's private free-text guidance, so its events **MUST NOT** be
returned by an **unscoped** (session-less) read that bypasses the projection gate — `events list`
without a session, and the equivalent observation-history enumeration. An unscoped read **MUST**
exclude ephemeral-monitor rows (recognisable by the reserved `ephemeral:` id prefix, §4.3); the
declaring session still reads its own ephemeral events through its **session-scoped** read.
Persistent-monitor reads are unaffected.

**Scope of the isolation invariant (decision, Refs #312).** The isolation above binds **unscoped
enumeration** — a session-less read that would fold ephemeral rows into a cross-session listing.
It does **not** extend to a **`monitorId`-targeted** read that names a specific ephemeral id. Such a
read is an **operator-level diagnostic**, not a session-isolated surface: naming the full
`ephemeral:<sessionId>/<ulid>` id (§4.3) is itself operator knowledge, and doing so **MAY** return
that monitor's **observation-history** audit rows (observe outcomes and counts) even from another
session's binding. The rationale is the **local single-operator trust model**: the daemon serves one
human operator's machine (PP10), so the observation audit trail is a diagnostic aid (`monitor
explain` / `doctor` / reminder diagnosis), not a cross-tenant boundary. The **events** surface is
**stricter by design**: because an ephemeral event body carries the declaring session's private
free-text instruction, `events list` **MUST** exclude ephemeral rows on **any** session-less read —
including one that names the ephemeral id — so the private instruction is never returned except
through the declaring session's session-scoped read. In short: a `monitorId`-targeted
observation-history read is diagnostic and permitted; the instruction-bearing event body is not.

An in-flight tick **MUST NOT** deliver for a reaped watch: because a tick pre-fetches its active
ephemeral monitors before `observe()` yields, a `watch cancel` (or session close/dormancy) that
races the observation could otherwise still project into the (possibly still-active) declaring
session. Delivery therefore re-checks, at materialization/insert time, that the ephemeral monitor is
still `active` and its declaring session is still `active`; if either has been reaped, the observed
event is retained (§4.4) but projected to **nobody**.

### 4.7 Composition with dependent chains and per-binding fan-out

- **Dependent chains (#124).** A declarative dependent/sequential monitor chain ("when monitor A
  fires, arm monitor B") is expected to be built **on top of** the ephemeral-monitor mechanic: each
  armed step is an ephemeral monitor the daemon registers when the prior step fires. This document
  fixes the ephemeral primitive; the chain-authoring surface is out of scope here and tracked by
  #124. The primitive **MUST** be sufficient for a chain step (session-scoped, daemon-armed,
  reaped when satisfied or when the session ends).
- **Per-binding fan-out (#258).** Ephemeral monitors and project-relative user-level fan-out (#258)
  share the same underlying need: **per-binding, session-or-workspace-scoped durable state** (a
  distinct baseline/cursor/unread stream per binding). These primitives **MUST** be designed to
  **compose** — one durable per-binding-state model serving both — rather than diverge into two
  parallel state models. Concretely, an ephemeral monitor's per-recipient cursor
  (`session_object_cursor`, [002 §1.1.2](./002-runtime-delivery.md)) is the same primitive a
  fanned-out binding uses.

## 5. Observability Surface (_target_)

### 5.1 Three states an agent can inspect

The observability surface lets an agent (or a human operator) inspect, for a session, three
**distinct** states of its signals:

1. **Received** — events that have been delivered/surfaced (claimed) or acknowledged. Already
   answerable via `agentmonitors events list` ([005 §11.1](./005-cli-reference.md)).
2. **Pending** — durable events that are **unread** (not yet acknowledged, SP4) — "fired, waiting
   for you." Already answerable via `events list --unread`.
3. **Armed-but-not-yet-fired** — a condition the daemon has **detected** but has **not yet
   delivered**, because it is being held by a notify/settle window or a recorded suppression (§5.2).
   This is **new** and is the heart of the observability ask.

These three **MUST** be kept distinct (do not merge "armed" into "pending"): "a change is coming"
is not the same as "a change is waiting", which is not the same as "a change was delivered."

### 5.2 The "condition met but not yet fired" state

A condition is **met** when a source observation has detected a change; it is **not yet fired** when
delivery is being **held** by one of the runtime's already-recorded hold mechanisms. The
observability surface **MUST** derive the armed set from that existing substrate — it introduces **no
new watching** (PP9) — namely:

| Hold mechanism                         | Where recorded (already durable)                | Spec ref                                  |
| -------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| High-urgency 15 s settle window        | event age vs `DEFAULT_HIGH_URGENCY_SETTLE_MS`   | [002 §9.1](./002-runtime-delivery.md)     |
| Debounce `settle-for` batch            | `monitor_state.notify_state` pending debounce   | [002 §3, §4.3](./002-runtime-delivery.md) |
| Throttle `suppress-for` window         | `monitor_state.notify_state` suppression window | [002 §4.2](./002-runtime-delivery.md)     |
| Scheduled-rollup `window` not yet open | `notify_state.pendingRollup` batch              | [002 §4.4](./002-runtime-delivery.md)     |
| `net` intermediate collapse            | `session_event_state.net_suppressed_at`         | [002 §1.1.7](./002-runtime-delivery.md)   |
| Interpret significance suppression     | `session_event_state.interpret_*`               | [002 §1.1.8](./002-runtime-delivery.md)   |

Because every hold is already recorded durably and already surfaced (per-monitor) by
`monitor explain` ([002 §10.7](./002-runtime-delivery.md)), the armed bucket is a **read** across
that state, scoped to the session's monitors. A recorded suppression (`net`/Interpret) is reported
as **met-and-deliberately-held**, never as "not met" — preserving the "why nothing fired is
inspectable" honesty invariant (PP7, C12).

### 5.3 The inspect verb

`agentmonitors inspect [--session <id>]` ([005 §14](./005-cli-reference.md)) returns the three
buckets of §5.1 for a session in one read.

- It **MUST** be a pure read (§2.1): inspecting **MUST NOT** claim, acknowledge, or advance any
  cursor.
- For each armed entry it **SHOULD** report the **hold reason** (which mechanism from §5.2) and,
  where deterministic, the **earliest time it could fire** (e.g. settle-window expiry, next rollup
  window opening) — so the agent learns "a change is coming and roughly when" **without polling**.
- It **MUST** cover ephemeral monitors (§4) and persistent monitors identically (AP7).

## 6. Validation Implications (_target_)

Per [004 §6](./004-validation-testing.md), each rule above carries at least one testable obligation.
When this document's rules ship, tests **MUST** prove:

- **Read-only reads (§2.1, §3).** `snapshot` / `diff` / `summary` return the durable answer and
  leave unread / claimed / acknowledged state and per-recipient cursors **unchanged** (assert
  `session_event_state` and `session_object_cursor` are byte-identical before/after the read).
- **No re-observation (§2.1).** An agent-facing read does **not** invoke a source `observe()` (assert
  via a spy/fake source that its call count is unchanged across the read).
- **Point-to-point diff (§3.2).** A `diff` between two event ids reproduces `buildDiff` (the
  strategy-aware renderer) of their stored snapshots; the default `--from` equals the recipient's
  baseline cursor; a pruned/absent point yields a clear error, not an empty diff.
- **Async, non-blocking (§2.3).** A verb returns the current answer immediately and never waits for a
  future change (assert it returns without a change occurring).
- **Ephemeral declaration validity (§4.2).** A declaration with an invalid scope is rejected by the
  same `validateScope` path as `agentmonitors validate`; a valid one registers and is evaluated on
  the next tick.
- **Ephemeral identity (§4.3).** An ephemeral id is namespaced, unique against persistent ids in the
  same workspace, and stable across a tick and a daemon restart.
- **Ephemeral lifecycle (§4.4).** An ephemeral monitor survives a daemon restart while its session is
  active, is reaped on explicit session close ([002 §6.1](./002-runtime-delivery.md)) — and, once the
  per-session dormancy trigger is defined (§8), on dormancy — and does **not** resurrect after session
  end; `watch cancel` reaps immediately.
- **Session isolation (§4.6).** An ephemeral monitor's events project into the declaring session
  only, not into a sibling lead session in the same workspace.
- **Observability three-bucket distinctness (§5).** A change inside a settle/debounce/rollup window
  (or a recorded `net`/Interpret suppression) appears in the **armed** bucket, moves to **pending**
  when it fires, and to **received** when claimed — three distinct transitions, each asserted.

These SHOULD be integration tests against the real daemon IPC and the real CLI input contract (the
[004 §2.6](./004-validation-testing.md) pattern — test the real stdin/socket contract, not a
hand-built approximation).

## 7. Relationship to 005 and 006

- **[005 — CLI Reference](./005-cli-reference.md)** documents the concrete `agentmonitors` verbs
  introduced here (`snapshot`, `diff`, `summary`, `watch`, `inspect`) as **target** command sections
  ([005 §14](./005-cli-reference.md)); this document is the semantic contract those sections
  reference (mirroring how [005 §13](./005-cli-reference.md) references
  [006 §4](./006-agent-integration.md)).
- **[006 — Agent Integration & Delivery Transports](./006-agent-integration.md)** owns the daemon →
  agent delivery direction and the **multi-host adapter matrix** ([006 §11](./006-agent-integration.md)).
  Ephemeral-monitor deliveries (§4.6) and agent session-identity resolution (§4.2) rely on that
  adapter contract; this document does not re-specify the adapter seam.

## 8. Open Questions & Decisions Deferred

These are genuine design points left to the implementing child issues; each is called out here so a
reviewer can pin it before build:

- **Transport choice (§2.3).** Loopback HTTP vs the existing Unix-socket IPC — settle by dogfooding;
  the semantics are fixed regardless.
- **Snapshot retention floor (§3.2).** How far back historical `monitor_snapshots` are retained for
  arbitrary two-point diffs, and the error shape when a referenced point has been pruned.
- **Per-session dormancy trigger (§4.4). RESOLVED (Refs #312).** Defined as inactivity:
  [002 §6.2](./002-runtime-delivery.md) now specifies that an `active` session whose `lastActiveAt`
  has not advanced for at least `DEFAULT_SESSION_DORMANCY_MS` (default 30 min) is transitioned to
  `dormant` at the start of the next tick, and its ephemeral monitors are reaped — distinct from the
  daemon-wide idle self-termination of [002 §10.2](./002-runtime-delivery.md).
- **Ephemeral-id scheme (§4.3). RESOLVED (Refs #312).** Reserved prefix
  `ephemeral:<sessionId>/<ulid>` — collision-proof against directory-derived persistent ids by the
  mandatory `/` (see §4.3).
- **Ephemeral event retention on reap (§4.4). RESOLVED (Refs #312).** Retained: reap flips the record
  to `reaped` and stops observation, but never prunes its events or projections (the declaring
  session goes dormant, not deleted), so a late delivery is never silently dropped and a reaped
  record is never resurrected (see §4.4).
- **Verb/flag names (§3, §4, §5).** `snapshot` / `diff` / `summary` / `watch` / `inspect` are the
  proposed names; final names are a PM/implementer call. `watch` is chosen for the agent's mental
  verb ("watch this for me") and does **not** collide with any existing CLI command (the internal
  source `watch()` execution of [NP4](./000-principles.md) is not a CLI verb). The `watch` surface
  ships as `watch <source>` (declare, the default action) / `watch list` / `watch cancel <id>`
  (Refs #312); a **fire-condition / `--until`** flag (the seed of dependent chains, #124) is **not**
  part of this primitive and remains _target_ (the earlier §14.4 signature listed it; it is deferred
  to the chain-authoring work).
