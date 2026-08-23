# Product Roadmap

> **Status:** Living document
> **Purpose:** the sequenced milestones between here and the product described in
> [vision-and-positioning.md](./vision-and-positioning.md) — what we are building next,
> in what order, and why. Execution detail lives in the
> [GitHub milestones](https://github.com/mike-north/AgentMonitors/milestones); the
> spec-vs-implementation gap ledger lives in
> [docs/specs/roadmap.md](../specs/roadmap.md). This doc is the narrative that ties
> them together.

Milestones are **ordered, not dated**. Sequencing is the commitment; timing follows
throughput. Each milestone is an outcome — it closes when its issues close, and the
ordering only changes when new information arrives (recorded here when it does).

## How to read this

- **Now** — actively being built. High confidence in scope.
- **Next** — committed and sequenced. Scope is understood; work has not started.
- **Later** — directional. We intend to do these, and their order may shift.

## Now

### 1 — External ingress

Durable, source-neutral ingestion of externally pushed events: versioned envelopes,
atomic receipt persistence, debounce/deadline scheduling in the daemon, IPC exposure,
and CLI commands — proven end to end. This extends the runtime beyond polling sources
to signals the outside world _sends us_, with the same durability guarantees.

Epic: [#481](https://github.com/mike-north/AgentMonitors/issues/481). The
implementation is in review as a stacked series of PRs; landing that stack is the
milestone.

## Next

Reliability is the spine of the product thesis — a monitoring system that loses
signals, leaks processes, or lies about what it delivered is worse than no monitoring
at all. The next two milestones execute the commitments of the
[reliability & process-hygiene posture](./reliability-and-process-hygiene.md), which a
numbered spec will make normative
([#504](https://github.com/mike-north/AgentMonitors/issues/504)).

### 2 — Runtime containment & cleanup

The daemon and everything it spawns is contained, identity-verified, and reaped. No
orphaned process trees survive a daemon death
([#470](https://github.com/mike-north/AgentMonitors/issues/470),
[#478](https://github.com/mike-north/AgentMonitors/issues/478)); every cleanup signal
verifies the target's identity first
([#479](https://github.com/mike-north/AgentMonitors/issues/479)); containment uses the
strongest mechanism the platform offers and reports the guarantee achieved
([#480](https://github.com/mike-north/AgentMonitors/issues/480)); stray daemons,
channel servers, and sockets are detectable and collectable
([#426](https://github.com/mike-north/AgentMonitors/issues/426)); and
power/battery friendliness is a first-class design axis
([#469](https://github.com/mike-north/AgentMonitors/issues/469)).

### 3 — Delivery correctness & durability

Every persistence and delivery decision is atomic, truthful, and restart-safe:
ingest/materialization atomicity
([#295](https://github.com/mike-north/AgentMonitors/issues/295),
[#294](https://github.com/mike-north/AgentMonitors/issues/294)), monotonic
per-recipient cursors
([#298](https://github.com/mike-north/AgentMonitors/issues/298)), suppression of
empty deliveries ([#473](https://github.com/mike-north/AgentMonitors/issues/473)),
and transport-health surfaces that tell the truth
([#462](https://github.com/mike-north/AgentMonitors/issues/462)–[#465](https://github.com/mike-north/AgentMonitors/issues/465)).
The verification gate earns the same trust: no masked flakes, and the local gate
matches CI ([#452](https://github.com/mike-north/AgentMonitors/issues/452),
[#458](https://github.com/mike-north/AgentMonitors/issues/458)).

### 4 — Agent-facing interaction (spec 007)

An agent that receives a signal can act on it without re-fetching the world: the
read-only `snapshot` / `diff` / `summary` verbs
([#313](https://github.com/mike-north/AgentMonitors/issues/313)) and the
`inspect` surface that distinguishes armed → pending → received
([#314](https://github.com/mike-north/AgentMonitors/issues/314)). This completes the
signal-to-action loop for the existing host and closes epic
[#259](https://github.com/mike-north/AgentMonitors/issues/259).

## Later

### 5 — Multi-host adapters

The core is host-agnostic by construction; prove it. A Codex adapter
([#316](https://github.com/mike-north/AgentMonitors/issues/316)) first, then Cursor
([#317](https://github.com/mike-north/AgentMonitors/issues/317)), each with delivery
semantics invariant against the Claude Code adapter per
[spec 006 §11](../specs/006-agent-integration.md).

### 6 — User-level monitors & authoring

Monitors that follow the user across workspaces
([#194](https://github.com/mike-north/AgentMonitors/issues/194),
[#258](https://github.com/mike-north/AgentMonitors/issues/258)), resolution of the
open design decisions (session dormancy vs long blocking waits
[#396](https://github.com/mike-north/AgentMonitors/issues/396), claim-TTL decay
[#468](https://github.com/mike-north/AgentMonitors/issues/468), dependent monitor
chains [#124](https://github.com/mike-north/AgentMonitors/issues/124)), and a
burn-down of authoring-ergonomics papercuts
([#391](https://github.com/mike-north/AgentMonitors/issues/391),
[#409](https://github.com/mike-north/AgentMonitors/issues/409),
[#415](https://github.com/mike-north/AgentMonitors/issues/415)).

## Deliberately unscheduled

Tracked, real, and not on the sequenced path yet: new observation sources (event-driven
file watching [#279](https://github.com/mike-north/AgentMonitors/issues/279), the
macOS notification-observer source
[#128](https://github.com/mike-north/AgentMonitors/issues/128)), third-party source
discovery/installation (G4 in [docs/specs/roadmap.md](../specs/roadmap.md)), and
engineering-debt items labeled `backlog`. These graduate onto a milestone when they
become the next most valuable thing — not before.

## Changes

- **2026-08-23** — initial version: six milestones, reliability-first sequencing after
  external ingress lands.
