# Product Roadmap

> **Status:** Living document
> **Purpose:** the sequenced milestones between here and the product described in
> [vision-and-positioning.md](./vision-and-positioning.md) — what we are building next,
> in what order, and why. Execution detail lives in the
> [GitHub milestones](https://github.com/mike-north/AgentMonitors/milestones); the
> spec-vs-implementation gap ledger lives in
> [docs/specs/roadmap.md](../specs/roadmap.md). This doc is the narrative that ties
> them together.

The roadmap is a sequence of **numbered milestones (M1, M2, …)**, each an outcome that
unlocks a concrete capability. **Sequencing is the commitment; dates are estimates.**
The project board carries penciled start/target spans per milestone so its roadmap
(timeline) view works — treat those as indicative and freely revised, while the M-number
ordering only changes deliberately. Confidence in scope decreases with the number —
M1 is being built now; the later milestones are directional and may be reshaped before
they start. A milestone closes when its issues close, and ordering changes only when new
information arrives (recorded in the changelog below when it does).

Readiness gates — like "ready for broad use" — are deliberately **not** pinned to a
single milestone. Each milestone is a concrete increment of capability; where the
broad-use line falls is a judgment we make as the increments land, not a promise made
up front.

## M1 — External ingress

**Unlocks:** the outside world can _push_ events to Agent Monitors — with the same
durability guarantees as polled observations.

Durable, source-neutral ingestion of externally pushed events: versioned envelopes,
atomic receipt persistence, debounce/deadline scheduling in the daemon, IPC exposure,
and CLI commands — proven end to end.

Epic: [#481](https://github.com/mike-north/AgentMonitors/issues/481). The
implementation is in review as a stacked series of PRs; landing that stack is the
milestone. **Status: actively being built.**

## M2 — Runtime containment & cleanup

**Unlocks:** a daemon you can leave running unattended — everything it spawns is
accounted for up to the posture's documented containment boundary, and it never
damages unrelated work.

Reliability is the spine of the product thesis — a monitoring system that loses
signals, leaks processes, or lies about what it delivered is worse than no monitoring
at all. M2 and M3 execute the commitments of the
[reliability & process-hygiene posture](./reliability-and-process-hygiene.md),
which a numbered spec will make normative
([#504](https://github.com/mike-north/AgentMonitors/issues/504)).

The daemon and everything it spawns are accounted for within the documented
containment boundary. Identity-verified targets are reaped; when ownership cannot be
positively confirmed, the tool abstains, leaves the process alone, and emits a durable
user-visible warning ([#507](https://github.com/mike-north/AgentMonitors/issues/507)).
A fully detached descendant that erases its own identity escapes attribution by
construction, and the posture says so plainly rather than pretending otherwise.
Orphaned process trees from a previous daemon life are swept
([#470](https://github.com/mike-north/AgentMonitors/issues/470),
[#478](https://github.com/mike-north/AgentMonitors/issues/478)); every cleanup signal
verifies the target's identity first
([#479](https://github.com/mike-north/AgentMonitors/issues/479)); containment uses the
strongest mechanism the platform offers and reports the guarantee achieved
([#480](https://github.com/mike-north/AgentMonitors/issues/480)); stray daemons,
channel servers, and sockets are detectable and collectable
([#426](https://github.com/mike-north/AgentMonitors/issues/426)); and power/battery
friendliness is a first-class design axis
([#469](https://github.com/mike-north/AgentMonitors/issues/469)).

## M3 — Delivery correctness & durability

**Unlocks:** delivery you can trust without checking — every signal is either
delivered, visibly held, or truthfully reported as failed, across restarts.

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

## M4 — Agent-facing interaction (spec 007)

**Unlocks:** an agent that receives a signal can act on it directly — no re-fetching
the world, no guessing what is held back.

The read-only `snapshot` / `diff` / `summary` verbs
([#313](https://github.com/mike-north/AgentMonitors/issues/313)) and the `inspect`
surface that distinguishes armed → pending → received
([#314](https://github.com/mike-north/AgentMonitors/issues/314)). This completes the
signal-to-action loop for the existing host and advances epic
[#259](https://github.com/mike-north/AgentMonitors/issues/259), whose remaining
host-adapter workstream lands in M5.

## M5 — Multi-host adapters

**Unlocks:** the same monitors deliver into more than one agent host, with identical
semantics — the cross-host promise of the standard, made real.

The core is host-agnostic by construction; prove it. A Codex adapter
([#316](https://github.com/mike-north/AgentMonitors/issues/316)) first, then Cursor
([#317](https://github.com/mike-north/AgentMonitors/issues/317)), each with delivery
semantics invariant against the Claude Code adapter per
[spec 006 §11](../specs/006-agent-integration.md).

## M6 — User-level monitors & authoring

**Unlocks:** monitors that follow the user across workspaces, and an authoring
experience with the papercuts burned down.

User-level monitor scoping
([#194](https://github.com/mike-north/AgentMonitors/issues/194),
[#258](https://github.com/mike-north/AgentMonitors/issues/258)), resolution of the
open design decisions (session dormancy vs long blocking waits
[#396](https://github.com/mike-north/AgentMonitors/issues/396), claim-TTL decay
[#468](https://github.com/mike-north/AgentMonitors/issues/468), dependent monitor
chains [#124](https://github.com/mike-north/AgentMonitors/issues/124)), and the
remaining authoring-ergonomics papercuts
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

- **2026-08-23** — initial version: six numbered milestones (M1–M6),
  reliability-first sequencing after external ingress lands. Penciled indicative
  start/target spans onto the project board to enable its roadmap (timeline) view.
