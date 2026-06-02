# 000 — Principles & Properties

> **Status:** Draft
> **Covers:** product principles, semantic properties, architecture boundaries, non-properties

## 1. Purpose

This document establishes the invariants that the rest of the Agent Monitors specification set relies on. The later numbered docs define file formats, runtime mechanics, source behavior, and test expectations by referencing the properties here instead of restating them.

The current repository contains both public-facing docs and implementation code. This spec set is the canonical implementation contract. Public website docs are explanatory and may be shorter.

## 2. Product Principles

**PP1: Durable signals over transient context.** Agent Monitors exists to turn external changes into durable, queryable work signals for agents. The system must not rely on a single prompt, hook invocation, or human memory to preserve important observations.

**PP2: Declarative authoring.** A monitor is authored as a folder-scoped `MONITOR.md` file whose frontmatter declares policy and whose body declares handling instructions. Runtime behavior should be inferable from the monitor definition plus the selected source plugin.

**PP3: Observation logic belongs to source plugins.** The runtime decides when a source should run and how emitted observations are delivered, but each source plugin defines how it reads external state and detects changes.

**PP4: Delivery is session-aware.** Durable events are not enough on their own. The system must project events into tracked agent sessions so hooks can surface pending work at appropriate lifecycle points.

**PP5: Urgency semantics are explicit.** `low`, `normal`, and `high` urgency are all first-class parts of the model. Public docs or examples that omit one of them do not narrow the implementation contract.

**PP6: Stateful sources may require a baseline.** Some sources need a persisted "before" state before they can detect a meaningful "after" change. That is a feature of the source model, not an operational error.

**PP7: Source-of-truth docs must distinguish current behavior from target behavior.** If the repo contains gaps, limits, or mismatches between public docs and implementation, the spec must say which behaviors are current, which are required, and which are intentionally deferred.

**PP8: Implementation contract beats presentation docs.** The canonical internal specs govern implementation work. Public website docs are allowed to summarize or simplify, but they must not become the only place where behavior is defined.

## 3. Semantic Properties

**SP1: Monitor identity is directory-derived.** A monitor's stable machine identifier is the parent directory name of its `MONITOR.md` file.

**SP2: Monitor IDs are a correctness boundary.** Monitor IDs must be unique within an evaluated monitor tree. Duplicate IDs are not merely confusing; they risk aliasing persisted monitor state.

**SP3: Event identity and object identity are different.** Each persisted event has its own event ID, while `objectKey` identifies the source-defined object being observed, such as a file path or URL.

**SP4: Unread, claimed, and acknowledged are distinct states.** Delivering an event to a hook does not mark it read. Claiming a delivery only records that the session has been notified. Acknowledgement is a separate act.

**SP5: Snapshot history is keyed by workspace, monitor, and object identity.** Diffs and prior snapshots are meaningful only within the scope of a single observed object in a single workspace.

## 4. Architectural Properties

**AP1: The runtime/session event pipeline is the authoritative delivery model.** The primary integration path is monitor -> observation -> persisted `monitor_events` -> `session_event_state` projection -> hook delivery.

**AP2: The legacy inbox item lifecycle is separate.** The `inbox_items` state machine remains implemented and exposed, but it is not the authoritative event delivery model for runtime-emitted monitor events.

**AP3: The runtime is a poll-and-project engine.** The runtime scans monitors, evaluates due sources, persists source state and notify state, emits events, and refreshes hook state for matching sessions.

**AP4: Source registry data must drive both validation and schema generation.** The same registered source metadata should explain what a source is called, what scope fields it expects, and how editor-facing schema is produced.

**AP5: No implicit multi-root merge is defined by the current implementation.** The repository docs talk about enterprise, user, and project scope, but the current runtime evaluates one supplied monitors directory at a time.

**AP6: Public CLI behavior should be derivable from core runtime and parsing contracts.** Commands may wrap the library, but they should not silently invent behavior that bypasses the core model.

## 5. Boundary Properties

**BP1: Schedule matching is best-effort and non-backfilling.** A scheduled trigger fires only when a runtime tick lands in a matching time window. Missed windows are not replayed.

**BP2: Hook delivery is advisory, not completion.** Hook claims surface work to an agent; they do not imply the work is complete or even acknowledged.

**BP3: Source-specific scope validation and source execution are separate concerns.** Validation should catch authoring mistakes early, but runtime source execution remains the final authority on whether a source can actually observe its target.

## 6. Non-Properties

**NP1: Agent Monitors is not a distributed event service.** This repository does not define cross-machine consensus, centralized fan-out, or remote queueing.

**NP2: Agent Monitors does not guarantee exactly-once downstream side effects.** The system persists observations and delivery metadata, but any agent actions taken in response remain outside the runtime contract.

**NP3: The current CLI does not implement third-party source discovery or installation.** Placeholder commands do not count as a supported plugin manager.

**NP4: Watch-mode source execution is opt-in and additive, not the default.** The runtime drives continuous `watch()` for sources that implement it (via `AgentMonitorRuntime.watchMonitors()`, started by `daemon run`); sources without `watch()` run on the one-shot `observe()` tick loop. `observe()` remains required on every source — it is the fallback for one-shot ticks (e.g. `daemon once`) and for any monitor not currently watched. A watched monitor is driven only by its watcher; the tick loop skips its `observe()` so it is never processed twice.

## 7. Cross-Reference Index

| Property set                            | Referenced by                                                               |
| --------------------------------------- | --------------------------------------------------------------------------- |
| PP1–PP3, SP1–SP2, AP4                   | [001 — Monitor Definition & Authoring](./001-monitor-definition.md)         |
| PP1, PP4–PP7, SP3–SP5, AP1–AP3, BP1–BP2 | [002 — Runtime, Delivery & Persistence](./002-runtime-delivery.md)          |
| PP3, PP6–PP7, AP4, BP3, NP3–NP4         | [003 — Source Plugins](./003-source-plugins.md)                             |
| PP7–PP8, AP4–AP6, BP3                   | [004 — Validation & Testing](./004-validation-testing.md)                   |
| AP6, PP5                                | [005 — CLI Reference](./005-cli-reference.md)                               |
| PP4, AP1, AP6, BP2                      | [006 — Agent Integration & Delivery Transports](./006-agent-integration.md) |
