# Product Roadmap

> **Status:** Living document
> **Purpose:** the sequenced milestones between here and the product described in
> [vision-and-positioning.md](./vision-and-positioning.md) — what we are building next,
> in what order, and why. Execution detail lives in the
> [GitHub milestones](https://github.com/mike-north/AgentMonitors/milestones); the
> spec-vs-implementation gap ledger lives in
> [docs/specs/roadmap.md](../specs/roadmap.md). This doc is the narrative that ties
> them together.

The roadmap is a sequence of **numbered milestones (M0, M1, …)**, each an outcome with a
test for when it is done. **Sequencing is the commitment.** Milestones carry no due dates.
Confidence in scope decreases with the number, so later milestones may be reshaped before
they start. A milestone closes when its issues close, and ordering changes only when new
information arrives (recorded in the changelog below when it does).

Readiness gates — like "ready for broad use" — are deliberately **not** pinned to a
single milestone. Each milestone is a concrete increment of capability; where the
broad-use line falls is a judgment we make as the increments land, not a promise made
up front.

## How we choose what to firm up

Agent Monitors has three parts:

1. **Ingress** — polling sources and an event sink take in changes from the world.
2. **Delivery** — events reach agents reliably, at an urgency that ranges from interrupting
   mid-turn to waiting until the agent stops.
3. **The middle** — filtering, transformation, summarization, policy, pacing and enrichment
   turn a raw pipe into a distilled signal.

We firm up these parts one at a time, in that order, rather than investing in all of them at
once. The edges come first because a distilled signal is only worth producing if it is
never lost and always arrives. Nothing that has already landed gets removed. Parked work
stays open, and the code it touches stays as it is until its part comes up.

## M0 — Trustworthy gate

**Done when:** green means correct, and main's fixes are released.

Every later milestone relies on this gate as its proof. The dependency audit is clean
([#530](https://github.com/mike-north/AgentMonitors/issues/530)), masked and load-sensitive
flakes are gone ([#452](https://github.com/mike-north/AgentMonitors/issues/452),
[#515](https://github.com/mike-north/AgentMonitors/issues/515),
[#509](https://github.com/mike-north/AgentMonitors/issues/509),
[#475](https://github.com/mike-north/AgentMonitors/issues/475),
[#520](https://github.com/mike-north/AgentMonitors/issues/520)), the local gate matches CI
([#458](https://github.com/mike-north/AgentMonitors/issues/458)), and issues already fixed
on main are closed.

## M1 — Ingress loses nothing

**Done when:** faults and kills at every write in the poll and flush paths still produce each
observed event.

Today a source's baseline can advance before its event is written, so a failed write loses
the event. Landing the recovery work
([#295](https://github.com/mike-north/AgentMonitors/issues/295),
[#294](https://github.com/mike-north/AgentMonitors/issues/294),
[#293](https://github.com/mike-north/AgentMonitors/issues/293)) closes that gap. This
milestone also covers truthful source baselines
([#305](https://github.com/mike-north/AgentMonitors/issues/305)), held work that survives a
monitor edit ([#537](https://github.com/mike-north/AgentMonitors/issues/537),
[#451](https://github.com/mike-north/AgentMonitors/issues/451)), and bounded,
identity-verified cleanup of the processes polling spawns
([#470](https://github.com/mike-north/AgentMonitors/issues/470),
[#478](https://github.com/mike-north/AgentMonitors/issues/478),
[#479](https://github.com/mike-north/AgentMonitors/issues/479)).

## M2 — Event sink

**Done when:** externally pushed events get the same no-loss guarantee as polled ones.

Durable, source-neutral ingestion of pushed events: versioned envelopes, atomic receipt
persistence, deadline scheduling in the daemon, IPC exposure, and CLI commands, proven end to
end. Epic: [#481](https://github.com/mike-north/AgentMonitors/issues/481). It depends on M1,
and its stacked PRs rebase onto that work.

## M3 — Delivery is honest on Claude

**Done when:** every event is delivered, visibly held, or reported as failed, and each urgency
level works as promised, through Claude Code hooks and channels.

A channel claim needs proof that something is listening
([#535](https://github.com/mike-north/AgentMonitors/issues/535)). A dead daemon must be
restarted or reported ([#536](https://github.com/mike-north/AgentMonitors/issues/536),
[#435](https://github.com/mike-north/AgentMonitors/issues/435),
[#467](https://github.com/mike-north/AgentMonitors/issues/467)). The claim and acknowledgement
lifecycle needs one clear contract
([#468](https://github.com/mike-north/AgentMonitors/issues/468),
[#441](https://github.com/mike-north/AgentMonitors/issues/441),
[#473](https://github.com/mike-north/AgentMonitors/issues/473),
[#298](https://github.com/mike-north/AgentMonitors/issues/298)). Sessions must stay reachable
during long waits ([#396](https://github.com/mike-north/AgentMonitors/issues/396)), and health
reports must tell the truth
([#424](https://github.com/mike-north/AgentMonitors/issues/424),
[#462](https://github.com/mike-north/AgentMonitors/issues/462)).

## M4 — A second delivery route

**Done when:** Codex passes the same delivery test suite as Claude.

The core is host-agnostic by construction, so prove it through the Codex app server
([#316](https://github.com/mike-north/AgentMonitors/issues/316)), with semantics invariant
against the Claude adapter per [spec 006 §11](../specs/006-agent-integration.md). Claude's
subagent coordination socket gets a probe before anything depends on it
([#538](https://github.com/mike-north/AgentMonitors/issues/538)).

## M5 — The middle (parked)

**Picked up:** once the edges are proven. Scope will be reshaped before it starts.

Event processing, predicates, policy, enrichment and summarization build on the capability
model in [monitoring-capability-exercises.md](./monitoring-capability-exercises.md). What
already ships here, such as debouncing and throttling, keeps working but gets no new
investment until then; defects that lose events belong to M1.

This milestone also holds work that is real but not next:

- Agent-facing verbs and `inspect`
  ([#313](https://github.com/mike-north/AgentMonitors/issues/313),
  [#314](https://github.com/mike-north/AgentMonitors/issues/314),
  [#259](https://github.com/mike-north/AgentMonitors/issues/259)).
- The remaining process-hygiene commitments
  ([#426](https://github.com/mike-north/AgentMonitors/issues/426),
  [#469](https://github.com/mike-north/AgentMonitors/issues/469),
  [#480](https://github.com/mike-north/AgentMonitors/issues/480),
  [#507](https://github.com/mike-north/AgentMonitors/issues/507)). The
  [reliability posture](./reliability-and-process-hygiene.md) still states these as targets,
  and they stay unmet until this work is picked up.
- A Cursor adapter ([#317](https://github.com/mike-north/AgentMonitors/issues/317)).
- User-level monitors, dependent chains, and authoring papercuts
  ([#194](https://github.com/mike-north/AgentMonitors/issues/194),
  [#258](https://github.com/mike-north/AgentMonitors/issues/258),
  [#124](https://github.com/mike-north/AgentMonitors/issues/124),
  [#391](https://github.com/mike-north/AgentMonitors/issues/391),
  [#409](https://github.com/mike-north/AgentMonitors/issues/409),
  [#415](https://github.com/mike-north/AgentMonitors/issues/415)).

## Deliberately unscheduled

Tracked, real, and not on the sequenced path yet: new observation sources (event-driven
file watching [#279](https://github.com/mike-north/AgentMonitors/issues/279), the
macOS notification-observer source
[#128](https://github.com/mike-north/AgentMonitors/issues/128)), third-party source
discovery/installation (G4 in [docs/specs/roadmap.md](../specs/roadmap.md)), and
engineering-debt items with no milestone. These graduate onto a milestone when they
become the next most valuable thing — not before.

## Changes

- **2026-11-03** — reorganized around three parts built in order: ingress, delivery, then the
  middle. A review of the code and backlog found that events could be lost before they were
  written and that delivery could report success with nothing received, while the previous
  sequence put external ingress ahead of the durability work it depends on. Added a gate
  milestone first, replaced the six milestones with M0–M5, and dropped due dates. The previous
  milestones are closed on GitHub and keep their closed issues.
- **2026-08-23** — initial version: six numbered milestones (M1–M6),
  reliability-first sequencing after external ingress lands. Penciled indicative
  start/target spans onto the project board to enable its roadmap (timeline) view.
