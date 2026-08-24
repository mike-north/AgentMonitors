# 008 — Reliability & Process Hygiene

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [002-runtime-delivery.md](./002-runtime-delivery.md), [003-source-plugins.md](./003-source-plugins.md), [005-cli-reference.md](./005-cli-reference.md), [006-agent-integration.md](./006-agent-integration.md)
> **Covers:** the containment boundary, spawned-process lifecycle bounds, crash-survival and
> the restart sweep, identity-verified cleanup, the abstention/escape taxonomy and the
> abstention warning surface, the containment capability probe and achieved-guarantee
> reporting, and the daemon's power posture

---

> **Whole-document status: mostly _target_.** This document makes the commitments of the
> [reliability & process-hygiene posture](../product/reliability-and-process-hygiene.md)
> normative. The posture doc is the non-normative _why_; this document is the testable _what_.
> Most rules here are **target**, each citing the tracking issue that closes its gap
> ([#469](https://github.com/mike-north/AgentMonitors/issues/469),
> [#470](https://github.com/mike-north/AgentMonitors/issues/470),
> [#478](https://github.com/mike-north/AgentMonitors/issues/478),
> [#479](https://github.com/mike-north/AgentMonitors/issues/479),
> [#480](https://github.com/mike-north/AgentMonitors/issues/480),
> [#507](https://github.com/mike-north/AgentMonitors/issues/507),
> [#426](https://github.com/mike-north/AgentMonitors/issues/426)). Rules marked **current**
> are already enforced and cite their proving tests. When a target rule ships, move it to
> _current_ with `verified:` references, and add a
> [spec-changelog.md](./spec-changelog.md) entry
> ([004 §5–§6](./004-validation-testing.md)).

## 1. Overview

Agent Monitors is a process the user leaves running (the posture doc's one-line thesis). A
long-running local daemon that spawns other processes loses trust through erosion — leaked
children, warm laptops, strays found in Activity Monitor — so this document specifies the
contract that makes the system **accountable for everything it starts that remains within the
containment boundary**: bounded lifecycles (§3), self-healing restarts (§4), identity-verified
cleanup (§5), honest failure modes (§6), honest capability reporting (§7), and a quiet idle
posture (§8).

Scope: the hygiene of **Agent Monitors' own process tree** — the daemon, channel servers, and
everything monitors cause it to spawn. The user's own workloads are out of scope (§9). These
are reliability guarantees, not a security boundary (§9; the security trust boundary is
[BP4](./000-principles.md)).

## 2. The Containment Boundary

### 2.1 Definition (normative)

A process is **within the containment boundary** iff Agent Monitors spawned it (directly, or
transitively through a monitored command) and it has **not** done both of the following:

- (a) deliberately detached itself into an independent session (daemonized away from the
  spawned process tree), **and**
- (b) erased the marks that identify it as Agent Monitors' (its position in the spawned tree,
  its process group/session lineage, and any platform identity marks the containment
  mechanism of §7 applies).

Every guarantee in this document is scoped to the boundary. A process that does (a) but not
(b) — detached but still identifiable — remains within the boundary and MUST be caught by the
restart sweep (§4.2). A process that does both has **escaped** (§6.2).

**Why this definition matters:** it is what lets §3–§5 be stated without hedges. "No orphans"
is unfalsifiable as an absolute; "no orphans within the boundary, and boundary exits are
either swept (identity kept) or plainly documented as escapes (identity erased)" is testable.

### 2.2 Exhaustiveness (normative)

For any process Agent Monitors spawned, exactly one of the following MUST hold at all times —
there is no fourth state:

1. **Live and bounded** — running inside its allowed window (§3).
2. **Cleaned up** — reaped by normal completion, timeout escalation (§3.1), or a sweep (§4.2).
3. **Abstained** — suspected ours but unconfirmed; left alone and warned about (§6.1).
4. **Escaped** — identity erased, outside the boundary; documented limit, not a silent state
   (§6.2).

(States 3 and 4 are the two leak classes; state 4 is the only one invisible to the system,
and it is the only one the system does not claim to account for.)

## 3. Lifecycle Bounds — "nothing we start outlives its purpose"

### 3.1 Time-bounded execution with whole-tree escalation (current)

A monitored command MUST run only within its configured window. On timeout the runtime
escalates SIGTERM → SIGKILL against the command's **entire process tree**, not just the direct
child — a descendant holding stdio open or surviving its parent MUST NOT extend the window or
outlive the escalation.

**Current** — implemented by `@agentmonitors/source-command-poll` per
[003 §11](./003-source-plugins.md) (process-tree escalation fixed in #303 after the
process-group approach missed descendants). Verified: the no-orphan-on-timeout guards in
`plugins/source-command-poll/src/index.test.ts` (direct child **and** a backgrounded `sh -c`
descendant) and the live daemon-run/daemon-stop no-orphan check in
`apps/cli/src/commands/cli.integration.test.ts`.

### 3.2 Bounds must not require a live daemon (target — #470, narrowed by PR #472)

The lifetime bound of §3.1 MUST hold even if the daemon dies before the timeout fires.
**Current behavior falls short:** bounds live only in daemon-resident timers, so a hard-killed
daemon can orphan the command and its descendants (a detached child reparents to the OS
supervisor and keeps running). **Target:** spawned work is self-bounding — the mechanism
enforcing the window survives daemon death (PR #472's self-bounding watchdog is the intended
narrowing; its residual gap for close-on-exec descendants is then covered by the sweep of
§4.2).

**Test implication:** kill the daemon (SIGKILL) mid-command with a timeout pending; the
command tree MUST still terminate at its deadline with no daemon present.

## 4. Crash Survival — "it survives its own death without leaving a mess"

### 4.1 In-flight work stays bounded across daemon death (target — #470)

Same mechanism as §3.2, stated as the crash-survival guarantee: cleanup of in-flight spawned
work MUST NOT depend on the daemon being alive to perform it.

### 4.2 The restart sweep (target — #478, adjacent hygiene #426)

On startup, the daemon MUST sweep strays left by a previous daemon life: any process still
within the containment boundary (identity kept, §2.1) that belongs to a dead daemon life MUST
be identity-verified (§5) and reaped. This covers orphaned poll-command process trees
([#478](https://github.com/mike-north/AgentMonitors/issues/478)) and the adjacent
daemon/channel-server/socket hygiene — stray daemons, channel servers, and stale sockets MUST
be detectable and collectable
([#426](https://github.com/mike-north/AgentMonitors/issues/426)).

A sweep target that cannot be positively identity-verified is an **abstention** (§6.1), never
a kill.

**Test implication:** orphan a process tree from a killed daemon life (identity kept),
restart; the tree is reaped. Orphan a process whose identity cannot be confirmed; it is left
alone and a warning is produced (§6.1) — three separately-asserted outcomes: reaped /
abstained-with-warning / never a wrong kill.

### 4.3 Hardware failure is reconciled, not defeated (normative boundary)

A power loss leaves the OS to reap; the commitment is that the **next start** reconciles
(§4.2), not that orphaning through hardware failure never occurs (see §9).

## 5. Identity-Verified Cleanup — "we only ever kill what is ours" (target — #479)

Before sending **any** cleanup signal on **any** path — live reaping, timeout escalation
follow-ups, the restart sweep, `gc` — the daemon MUST positively verify at signal time that
the target process is the one it believes it is. Identifier recycling MUST be safe: a stored
pid (or pgid/session id) whose identity marks no longer match — because the OS recycled the
identifier onto unrelated work — MUST NOT be signalled.

Verification failure is never an error path that escalates to force; it is an **abstention**
(§6.1). The bias is normative: **prefer a leak to a wrong kill.** Killing an unrelated process
is prohibited in every failure mode; a missed cleanup is recoverable and reportable.

**Example (identifier recycling):** the daemon recorded pid 4242 for a poll command, then
crashed; by restart, the OS has given 4242 to the user's dev server. The sweep MUST compare
identity marks (start time, lineage, containment marks per §7's mechanism), find a mismatch,
and abstain — producing a §6.1 warning that names pid 4242 and why confirmation failed —
rather than kill the dev server. **This example is the promise:** the worst case is a warning,
never collateral damage.

**Test implication (per #479's acceptance criteria):** a recycled-identifier fixture MUST
produce abstention, not a signal; every live signal path (not only the sweep) MUST route
through the same verification.

## 6. The Two Leak Classes

### 6.1 Abstention — visible, warned about (target — #507)

An **abstention** (a suspected-ours process left alone because identity could not be
confirmed, §4.2/§5) MUST produce an **active, durable, user-visible warning** — not merely a
diagnostics record:

- **Surfaces:** retrievable via `agentmonitors doctor`, and delivered into the next active
  lead session through the normal delivery machinery
  ([006](./006-agent-integration.md)).
- **No-session case is first-class:** an abstention with no session open (typical for a
  startup sweep) MUST persist — surviving daemon restarts — and surface when a user surface
  next exists. It MUST NOT silently expire.
- **Calibrated honesty:** the warning names what was left alone (pid, observed identity
  marks, why confirmation failed) and states uncertain confidence plainly — "this looks like
  ours, but we could not confirm it" — never presenting a suspicion as a certainty. It tells
  the user what they can do (inspect or kill it themselves).
- **Deduplicated:** the same abstained process observed across N ticks/sweeps yields one
  warning, re-raised only on meaningful change.

**Expected warning shape (informative example):**

> ⚠ Left one process alone during the startup sweep: pid 4242 (`sh -c poll.sh`) **looks like
> it may be ours** — it matches the spawn lineage of a previous daemon life — but its
> identity marks could not be confirmed, so it was not touched. If it is stray, you can end
> it yourself; see `agentmonitors doctor` for details.

**Test implications (per #507):** live-path abstention → warning via doctor **and**
session delivery; no-session sweep abstention → persists across a daemon restart and
surfaces on next session open; warning text asserts uncertainty (a certainty phrasing for an
abstention is a test failure); N observations → one warning.

### 6.2 Escape — outside the boundary, documented, never guessed at (normative limit)

A process that both detached and erased its identity (§2.1) has left the boundary. The system
MUST NOT claim visibility of it (it cannot), MUST NOT attempt to reap it by guessing (that
violates §5), and the documented posture — here and in user-facing docs — MUST state plainly
that recovery is the user's ordinary OS tooling. Closing this gap by heuristic reaping is
prohibited; it converts the safe failure mode into the fatal one.

## 7. Capability Probe & Achieved-Guarantee Reporting (target — #480)

### 7.1 Automatic strongest-mechanism selection

On startup the daemon MUST probe the containment mechanisms the platform actually exposes and
select the **strongest available** automatically. There MUST NOT be a user-facing reliability
tier or configuration surface for this choice — disclosure is a report, never a knob. Probing
MUST NOT trigger user-facing permission prompts. Where the strongest platform primitive
requires an optional component, its absence MUST NOT gate a working install: the strongest
available fallback runs, and the component is detected and used automatically if present.

### 7.2 Honest reporting of the achieved level

The daemon MUST be able to answer, accurately and per-machine, what containment guarantee is
in effect — surfaced at minimum via `agentmonitors doctor`
([005](./005-cli-reference.md)). The report names the mechanism selected and the guarantee
level achieved, and never advertises a level the current environment cannot enforce.

**Expected report shape (informative example):**

> containment: process-group escalation + self-bounding watchdog (strongest available on this
> platform without optional kernel containment; escapes limited to identity-erasing
> detachment — see docs).

**Test implications (per #480's acceptance criteria):** capability-probe fixtures for
platforms with/without the stronger mechanism MUST select correctly with no prompt; the
reported guarantee MUST match the selected mechanism; an environment downgrade (mechanism
unavailable) MUST change the report, not silently keep the old claim.

## 8. Power Posture — "our machinery is gentle" (target — #469)

The daemon's **own machinery** — tick loop, scheduling, bookkeeping, transports — MUST be
power-friendly by design: no busy-spinning, wakes coalesced, event-driven paths preferred
over polling where sources support them ([NP4](./000-principles.md)), network polling using
conditional requests where the source protocol allows, intervals battery-aware where the
platform exposes power state, and sleep/wake reconciled without a thundering catch-up
([BP1](./000-principles.md): missed windows are not replayed). Idle monitors MUST cost close
to nothing.

A **monitored command** is the user's own program: the contract governs its
**time-boundedness** (§3), not its frugality — the system MUST NOT throttle or govern how
hard a user's command works (§9).

**Test implication:** an idle daemon (monitors present, nothing due) exhibits a bounded wake
rate; a due tick does not busy-wait between observations. (Precise budgets are set by #469's
design work; the normative floor is "no busy-spinning, coalesced wakes".)

## 9. Non-Goals

- **Not a process manager/supervisor** for the user's own workloads (no `pm2`/systemd role).
- **Not a resource governor** — no CPU/memory quotas or scheduling policy surface; §8 governs
  our machinery, not the user's commands.
- **Not a security boundary.** Process hygiene protects the user from _our_ mess; it is not a
  sandbox against hostile code ([BP4](./000-principles.md) defines the actual local trust
  boundary).
- **Not zero-orphans-through-hardware-failure** — §4.3: the next start reconciles.

## 10. Success Criteria & Validation Summary

The posture holds when, scoped to the containment boundary:

| Criterion                                                                   | Governing § | Tracked          |
| --------------------------------------------------------------------------- | ----------- | ---------------- |
| Weeks of continuous running accumulate zero unintended processes            | §3          | #470             |
| Hard kill + restart leaves a clean process list with no manual intervention | §3.2, §4    | #470, #478, #426 |
| No report, ever, of signalling a process that was not ours                  | §5          | #479             |
| Every abstention produces a durable, honest, user-visible warning           | §6.1        | #507             |
| The tool answers accurately what guarantee is in effect on this machine     | §7          | #480             |
| The monitoring machinery is never why the machine is warm, slow, or loud    | §8          | #469             |

Each target rule above carries its own test implication; those implications are the
acceptance bar for the cited issues, per the posture doc's "how we will know we got it
right." Scenario-level coverage requirements join [004 §3](./004-validation-testing.md) as
each rule moves to _current_.
