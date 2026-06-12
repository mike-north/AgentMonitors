# Distribution Strategy — Post-v1 First Audiences

> **Status:** Decided (2026-06-12 strategy session)
> **Purpose:** who gets Agent Monitors first, in what order, and what tells us it's
> earning its place. Companion to [vision & positioning](./vision-and-positioning.md)
> (the _why_) and [use-cases](./use-cases.md) (the _what for_).

## Core frame

Two parallel tracks, not one sequence:

- **Track A — Monitors-in-plugins** (the runtime disappears into a tool chain; user never
  sees `MONITOR.md`). Wave 1 → Wave 3.
- **Track B — Citizen-developer authoring** (human + agent collaborate to build monitors;
  pressure-tests the standard). Wave 2.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                              | Rationale                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | **Repo stays private** through Wave 1 and Wave 2.                                                                                                                                                                                                                                                     | Not ready for drive-by contribution; still sharpening the model.                                       |
| 2   | **Repo goes public at the alpha/beta threshold**, reached after Wave 2.                                                                                                                                                                                                                               | Public = a maturity signal, not a gate on who can use it. Unlocks the standard ambition.               |
| 3   | **Mike is User #1 (Wave 1).** oFocus monitor, built standalone (outside any plugin) to prove the runtime works.                                                                                                                                                                                       | Tight, information-rich feedback loop before exposing anyone else.                                     |
| 4   | **Wave 2 = the AI Champions Group (~15 people), kicking off Thursday 2026-06-18.** Assigned use case: watch spec docs in a git repo, surface changes to contributors (human + agent) mid-work.                                                                                                        | Pressure-tests the whole stack and the standard's completeness.                                        |
| 5   | **Wave 3 = monitors bundled into distributable plugins, across multiple tools:** oFocus, Unraid CLI/MCP, Ubiquiti network CLI/MCP, Home Assistant. Mike orchestrates; a fleet of agents does the legwork.                                                                                             | Tests whether monitors-as-plugin-distribution is repeatable across domains, each its own repo/package. |
| 6   | **Courting external plugin/skill authors is explicitly deferred** until Wave 2 + 3 reveal the right model. Eventual target: Claude-specific plugins where a push signal adds value or an existing poll signal is token-inefficient — leveraging Anthropic **channels** as the clean push integration. | Don't spend the launch moment before the model is proven.                                              |

## The metric (earning its place)

**Primary signal — organic expansion of use cases in Wave 2.** The ~15 are each asked to
try one monitor use case; success = they find it easy/useful enough that they _organically_
start using it for other things.

- **Target:** affirmative, unprompted "I also used it for X" reports from the group.
- **Measurement:** direct conversation — Mike talks to these people constantly; no
  dashboard needed.
- **What's actually being tested:** not whether `MONITOR.md` syntax is intuitive, but
  whether the **human-agent pair reaches a useful outcome** — probing capability gaps,
  agent understandability, semantic activation, and "did the monitor actually fire."

## Table-stakes / blockers

- **Observability & debuggability — table stakes for Wave 2.** An author must be able to
  trace _why_ a monitor didn't fire when expected (filtered? source didn't run? change too
  small?). Needed both to catch tool-chain bugs and to let authors debug their own
  monitors. Core to the "only signal when there's something useful to act on" value prop.
- **Authoring skill (the "create-skill for monitors") — stretch for Wave 2, blocker for
  Wave 3.** Not a CLI/scaffolder — an **AI assistant plugin** for the Agent Monitors
  project. Most users should never touch the markdown format; they express intent, the
  agent sets it up. Stretch goal: **semantic activation** — the skill notices when a
  user's activity implies "watch this" (a file, a PR, etc.) and proactively recommends a
  monitor. Vision: most users' needs met via the skill; `MONITOR.md` remains for power
  users and implementers.

## Decision gate (Wave 2 → public alpha/beta)

Go public when the ~15 find monitors a **flexible, useful low-level primitive** across a
**variety of use cases**, with **DX rough edges that aren't severe**. If Wave 2 surfaces
big gaps, standard work pauses until they're closed.

## Feedback loop mechanics

GitHub issues (everyone has `gh` CLI) → PM agent summarizes the perceived gap → Mike
approves engineering work items → PM agent reviews code → merge → release. Target
turnaround: hours.

## Deferred (not opened in this session)

- Paid-layer validation (webhook forwarding / polling service / agentic summaries) and
  what stays free.
- Monitor Standard governance and the v0→v1 freeze.
- Outreach to external plugin/skill authors and the channels integration play.

## Next actions

| Action                                                            | Owner                           | Timing                 |
| ----------------------------------------------------------------- | ------------------------------- | ---------------------- |
| Build oFocus standalone monitor; shake out Wave 1 rough edges     | Mike                            | Week of 2026-06-12     |
| Prioritize observability/debuggability work (table stakes)        | PM agent (sequencing delegated) | Before 2026-06-18      |
| Attempt authoring skill as a stretch goal                         | PM agent + engineering agents   | Before 2026-06-18      |
| Introduce Agent Monitors to AI Champions Group; assign spec-watch | Mike                            | Thursday 2026-06-18    |
| Gather organic-expansion signal via direct conversation           | Mike                            | Days following kickoff |
| Decide on public alpha/beta + repo-public based on Wave 2 signal  | Mike                            | After Wave 2           |
