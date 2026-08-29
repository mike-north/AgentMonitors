# 008 — Reliability & Process Hygiene

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [002-runtime-delivery.md](./002-runtime-delivery.md), [003-source-plugins.md](./003-source-plugins.md), [005-cli-reference.md](./005-cli-reference.md), [006-agent-integration.md](./006-agent-integration.md)
> **Covers:** the containment boundary, spawned-process lifecycle bounds, crash-survival and
> the restart sweep, identity-verified cleanup, the abstention/escape taxonomy and the
> abstention warning surface, the containment capability probe and achieved-guarantee
> reporting, the daemon's power posture, and the cross-cutting durable-state-truthfulness
> and verification-gate commitments

---

> **Every normative section below carries its own explicit current/target marking** (this
> banner is orientation, not classification). This document makes the commitments of the
> [reliability & process-hygiene posture](../product/reliability-and-process-hygiene.md)
> normative. The posture doc is the non-normative _why_; this document is the testable _what_.
> Most rules here are **target**, each citing the tracking issue that closes its gap
> ([#469](https://github.com/mike-north/AgentMonitors/issues/469),
> [#470](https://github.com/mike-north/AgentMonitors/issues/470),
> [#478](https://github.com/mike-north/AgentMonitors/issues/478),
> [#479](https://github.com/mike-north/AgentMonitors/issues/479),
> [#480](https://github.com/mike-north/AgentMonitors/issues/480),
> [#507](https://github.com/mike-north/AgentMonitors/issues/507),
> [#426](https://github.com/mike-north/AgentMonitors/issues/426), and the milestone-M3
> durable-state/verification set cited in §9–§10). Rules marked **current**
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
everything monitors cause it to spawn. The user's own workloads are out of scope (§11). These
are reliability guarantees, not a security boundary (§11; the security trust boundary is
[BP4](./000-principles.md)).

## 2. The Containment Boundary

### 2.1 Definition (normative; the vocabulary is in force now — the states it references land with their cited trackers)

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

### 2.2 Exhaustiveness (target — the deferred-reconciliation and abstention states land with #480/#478 and #507)

For any process Agent Monitors spawned, exactly one of the following MUST hold at all times —
there is no sixth state:

1. **Live and bounded** — running inside its allowed window (§3).
2. **Cleaned up** — reaped by normal completion, timeout escalation (§3.1), or a sweep (§4.2).
3. **Deferred-reconciliation** — in-boundary but beyond the selected containment rung's
   deadline reach (a re-sessioned, identity-kept descendant on a lower §7.1 rung, §3.2);
   attributable, reported, and reaped at the next daemon start — explicitly **not** bounded
   in the interim, and never silently unaccounted.
4. **Abstained** — suspected ours but unconfirmed; left alone and warned about (§6.1).
5. **Escaped** — identity erased, outside the boundary; documented limit, not a silent state
   (§6.2).

(States 3–4 are visible, reported non-bounded states; state 5 is the only one invisible to
the system, and the only one the system does not claim to account for.)

## 3. Lifecycle Bounds — "nothing we start outlives its purpose"

### 3.1 Time-bounded execution with platform tree termination (current)

A monitored command MUST run only within its configured window: **escalation begins at the
configured timeout, and the hard upper bound on the command's lifetime is the configured
timeout plus the fixed 5-second forceful-kill grace period** (a SIGTERM-ignoring child runs
until the grace expires — empirically, a `timeout: 1s` command resolves in ~6s). On POSIX
the runtime sends SIGTERM and, after the grace, SIGKILL to the command's **original process
group**; on Windows it invokes `taskkill /PID <pid> /T /F` and repeats that forceful tree
kill after the grace period as a defensive retry. A descendant that remains in the original
process group — e.g. one holding stdio open or surviving its parent — MUST NOT outlive that
hard upper bound. Descendants that leave the original process group/session are **not**
covered by this current guarantee; they enter the deferred-reconciliation state (§2.2,
§3.2).

**Current** — implemented by `@agentmonitors/source-command-poll` per
[003 §11](./003-source-plugins.md) (escalation targeting fixed in #303). Verified: the
no-orphan-on-timeout guards in `plugins/source-command-poll/src/index.test.ts` (direct child
**and** a backgrounded `sh -c` descendant that remains in the original process group) and
the live daemon-run/daemon-stop no-orphan check in
`apps/cli/src/commands/cli.integration.test.ts`.

### 3.2 Full-boundary bounds (target — #480, with #478 as reconciliation)

An in-boundary descendant that leaves the original process group/session while keeping its
identity (§2.1) MUST be either **bounded at the deadline** or placed in the **reported
deferred-reconciliation state** (§2.2 state 3) — never silently unaccounted. Which of the
two applies is a property of the selected §7.1 rung: on a rung whose containment mechanism
tracks descendants across re-grouping/re-sessioning, timeout termination reaches it directly
at the deadline (a true lifetime bound); on lower rungs it enters deferred-reconciliation —
attributable and reported in diagnostics, reaped by the restart sweep (§4.2), and **not
bounded in the interim** (a daemon start that never happens leaves it running; the report is
what keeps that honest). Only rungs that enforce the deadline may describe themselves as
providing a lifetime bound for this class (§7.2's report MUST reflect the distinction).
Until [#480](https://github.com/mike-north/AgentMonitors/issues/480) lands this is a **known
current gap**: such a descendant survives the §3.1 escalation without even the
deferred-reconciliation reporting.

**Test implication:** a command that re-sessions a child (keeping its identity marks) MUST —
on a kernel-containment rung — see that child terminated at the deadline; on the fallback
rung, the child MUST be reaped by the next daemon start (regression for the
detached-descendant survival reproduced during this spec's review).

### 3.3 Bounds must not require a live daemon (target — #470, narrowed by PR #472)

The lifetime bound of §3.1 MUST hold even if the daemon dies before the timeout fires.
**Current behavior falls short:** bounds live only in daemon-resident timers, so a hard-killed
daemon can orphan the command and its descendants (a detached child reparents to the OS
supervisor and keeps running). **Target:** spawned work is self-bounding — the mechanism
enforcing the window survives daemon death (PR #472's self-bounding watchdog is the intended
narrowing). Its residual close-on-exec-descendant gap **remains open under #470**: such a
survivor is genuinely unbounded once the daemon is gone, until a future daemon start
reconciles it. §4.2's sweep is complementary reconciliation, never a substitute for this
lifetime bound.

**Test implication:** kill the daemon (SIGKILL) mid-command with a timeout pending; the
command's covered tree (§3.1's mechanism class) MUST still terminate at its deadline with no
daemon present. The close-on-exec residual is exercised as a sweep-reconciliation case
(§4.2), not a deadline case, until #470 closes it.

## 4. Crash Survival — "it survives its own death without leaving a mess"

### 4.1 In-flight work stays bounded across daemon death (target — #470)

Same mechanism as §3.3, stated as the crash-survival guarantee: cleanup of in-flight spawned
work MUST NOT depend on the daemon being alive to perform it.

### 4.2 The restart sweep (target — #478, adjacent hygiene #426)

On startup, the daemon MUST sweep strays left by a previous daemon life: any process still
within the containment boundary (identity kept, §2.1) that belongs to a dead daemon life MUST
be identity-verified (§5) and reaped. This covers orphaned poll-command process trees
([#478](https://github.com/mike-north/AgentMonitors/issues/478) — whose scope, written
before this boundary definition, is extended to include detached-but-identifiable
descendants; the contradiction resolution is recorded in
[spec-changelog.md](./spec-changelog.md) per [004 §5](./004-validation-testing.md) and on
the issue) and the adjacent
daemon/channel-server/socket hygiene — stray daemons, channel servers, and stale sockets MUST
be detectable and collectable
([#426](https://github.com/mike-north/AgentMonitors/issues/426)).

A sweep target that cannot be positively identity-verified is an **abstention** (§6.1), never
a kill.

**Test implication:** orphan a process tree from a killed daemon life (identity kept),
restart; the tree is reaped **and the sweep's diagnostics record what it reaped** (pid,
identity evidence, daemon life it belonged to — #478's successful-reap assertion, so a sweep
that silently did nothing is distinguishable from one with nothing to do). Orphan a process
whose identity cannot be confirmed; it is left alone and a warning is produced (§6.1) —
three separately-asserted outcomes: reaped-with-diagnostic / abstained-with-warning / never
a wrong kill.

### 4.3 Hardware failure is reconciled, not defeated (target — reconciliation is #478's sweep)

A power loss leaves the OS to reap; the commitment is that the **next start** reconciles
(§4.2), not that orphaning through hardware failure never occurs (see §11).

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

### 6.2 Escape — outside the boundary, documented, never guessed at (current — a standing prohibition: nothing reaps heuristically today, and nothing ever may)

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

**The capability ladder (normative ordering).** "Strongest" is adjudicated against this
ordering — a rung is defined by the guarantee it enforces, and selection MUST pick the
highest rung whose probe succeeds on this machine:

1. **Kernel-enforced group containment** — an OS primitive that tracks, and can terminate,
   every descendant regardless of re-grouping or re-sessioning (a kernel-managed process
   group / job / container construct with tree-kill). Guarantee: §3.2's deadline bound holds
   for every in-boundary descendant; escape requires identity erasure _plus_ leaving the
   primitive, which the kernel prevents for ordinary processes.
2. **Group/session escalation + self-bounding watchdog** — the two-step original-group
   termination of §3.1 plus the daemon-death-independent watchdog of §3.3. Guarantee:
   deadline bound for group-resident descendants; re-sessioned descendants enter the
   reported deferred-reconciliation state (§2.2 state 3, §3.2) until the next start's sweep
   (§4.2).
3. **Bookkeeping fallback** — direct-child termination plus the identity-marked sweep at
   next start. Guarantee: bounded direct child; every other in-boundary process sits in the
   reported deferred-reconciliation state until restart.

The concrete per-platform inventory — which OS facilities implement each rung on each
supported platform, and each rung's probe — is design work owned by
[#480](https://github.com/mike-north/AgentMonitors/issues/480); per its acceptance criteria
that inventory MUST be recorded in this section when it lands, moving §7 to _current_ with
the platform table filled in.

### 7.2 Honest reporting of the achieved level

The daemon MUST be able to answer, accurately and per-machine, what containment guarantee is
in effect — surfaced at minimum via `agentmonitors doctor`
([005](./005-cli-reference.md)). The report names the mechanism selected and the guarantee
level achieved, and never advertises a level the current environment cannot enforce.

**Expected report shape (informative example):**

> containment: process-group escalation + self-bounding watchdog (strongest available on this
> platform without optional kernel containment; escapes limited to identity-erasing
> detachment — see docs).

**Test implications (per #480's acceptance criteria):** capability-probe fixtures MUST
select the highest succeeding rung with no prompt; each rung's guarantee is asserted
behaviorally (rung 1: deadline-kill of a re-sessioned descendant; rung 2: group deadline-kill
plus sweep of the re-sessioned case; rung 3: direct-child kill plus sweep); the reported
guarantee MUST match the selected rung; an environment downgrade (mechanism unavailable)
MUST change the report, not silently keep the old claim.

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
hard a user's command works (§11).

**Test implication (measurement protocol):** an integration harness counts daemon wakeups —
poll-loop iterations and timer fires, logged at debug level — over a window of N tick
intervals with monitors present but nothing due, and asserts the count is O(N) with a small
constant (no busy-spinning: the count must not scale with wall-clock resolution), and that a
due tick performs no intermediate wakeups between its observation and the next scheduled
one. The exact numeric budget per interval is set by #469's design work; the protocol above
is normative now so #469's budget lands as a number in an existing assertion, not a new test
design.

## 9. Durable-State Truthfulness (target — milestone M3)

Process hygiene is one half of "a process you can leave running"; the other half is that the
daemon never lies about durable state. The mechanisms are owned by
[002](./002-runtime-delivery.md) (persistence, projection, delivery); this section owns the
cross-cutting commitment level required by #504:

- **Atomic, truthful ingest.** An observation is either fully persisted or truthfully
  reported as failed — never silently partial. Materialization failures are reported
  truthfully ([#295](https://github.com/mike-north/AgentMonitors/issues/295)); an emitted
  span is persisted before any optional Interpret adapter is awaited
  ([#294](https://github.com/mike-north/AgentMonitors/issues/294)); validation runs before
  side effects ([#301](https://github.com/mike-north/AgentMonitors/issues/301),
  [#306](https://github.com/mike-north/AgentMonitors/issues/306)); an unavailable upstream
  is distinguished from a successful empty baseline
  ([#305](https://github.com/mike-north/AgentMonitors/issues/305)).
- **Monotonic per-recipient state.** Per-recipient cursors never move backwards, including
  across out-of-order urgency claims
  ([#298](https://github.com/mike-north/AgentMonitors/issues/298)).
- **Truthful delivery decisions.** A reminder whose unread set emptied before delivery is
  suppressed, not delivered (target,
  [#473](https://github.com/mike-north/AgentMonitors/issues/473)); channel claims follow
  reserve → push → commit/release, committing only after a successful push (**current** —
  verified: [006 §4.5.1](./006-agent-integration.md), status implemented, Refs #300); a
  failed or completed watcher is released so polling fallback resumes (**current** —
  verified: [002 §2.3–§2.4](./002-runtime-delivery.md), Refs #296); editing a monitor never
  retroactively rewrites already-materialized events (target,
  [#451](https://github.com/mike-north/AgentMonitors/issues/451)); transport-health
  surfaces report the truth (target,
  [#462](https://github.com/mike-north/AgentMonitors/issues/462)–[#465](https://github.com/mike-north/AgentMonitors/issues/465)).

(The section heading's "target" applies per-clause: the two clauses marked **current** above
are implemented and regression-tested; their still-open trackers #296/#300 are flagged for
reconciliation.)

**Test implications:** each cited issue's regression test is its acceptance bar; the shared
scenario is crash-into-restart — kill the daemon at any point in
ingest → materialize → project → deliver and assert on restart that durable state is either
complete or truthfully marked failed, never silently partial
([002](./002-runtime-delivery.md)'s restart-safety discipline).

## 10. Verification-Gate Trust (target — milestone M3)

The claims above are only as credible as the gate that verifies them, so the gate itself
carries commitments (#504's verification-gate expectations):

- **Local gate ≡ CI gate.** What the workspace verification scripts run locally MUST match
  what CI enforces; a suite that runs only in CI (or only locally) is drift
  ([#458](https://github.com/mike-north/AgentMonitors/issues/458)).
- **No masked flakes.** Retry budgets absorb the environment, never hide defects: a test
  that consumes its full retry budget on every run is a defect
  ([#452](https://github.com/mike-north/AgentMonitors/issues/452)), and a nondeterministic
  failure on an unrelated diff is a tracked defect with an owner, never re-rolled as routine
  ([#509](https://github.com/mike-north/AgentMonitors/issues/509),
  [#475](https://github.com/mike-north/AgentMonitors/issues/475),
  [#477](https://github.com/mike-north/AgentMonitors/issues/477); #506 is the fixed
  exemplar).
- **Failures are diagnosable from artifacts.** A CI-only failure MUST capture enough state
  (spawned daemon/subprocess logs) to be root-caused without re-running (#509's acceptance
  criterion).

**Test implications (executable, not historical):** a gate-parity check asserting the CI
workflow's test commands are derivable from the workspace scripts (#458's acceptance bar); a
retry-budget assertion that the guarded suite passes with retries disabled (`--retry=0`) so a
budget-exhausting test fails loudly instead of masking (#452); a suite-teardown guard
asserting `PATH` (and equivalent mutated global state) is restored even when a test times out
(#477); and a forced-failure test per instrumented subprocess harness asserting its
diagnostic dump actually renders (the docker-smoke forced-failure cases shipped with #509's
fix are the pattern).

## 11. Non-Goals

- **Not a process manager/supervisor** for the user's own workloads (no `pm2`/systemd role).
- **Not a resource governor** — no CPU/memory quotas or scheduling policy surface; §8 governs
  our machinery, not the user's commands.
- **Not a security boundary.** Process hygiene protects the user from _our_ mess; it is not a
  sandbox against hostile code ([BP4](./000-principles.md) defines the actual local trust
  boundary).
- **Not zero-orphans-through-hardware-failure** — §4.3: the next start reconciles.

## 12. Success Criteria & Validation Summary

The posture holds when, scoped to the containment boundary:

| Criterion                                                                   | Governing § | Tracked                                                  |
| --------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- |
| Weeks of continuous running accumulate zero unintended processes            | §3          | #470                                                     |
| Hard kill + restart leaves a clean process list with no manual intervention | §3.3, §4    | #470, #478, #426                                         |
| No report, ever, of signalling a process that was not ours                  | §5          | #479                                                     |
| Every abstention produces a durable, honest, user-visible warning           | §6.1        | #507                                                     |
| The tool answers accurately what guarantee is in effect on this machine     | §7          | #480                                                     |
| The monitoring machinery is never why the machine is warm, slow, or loud    | §8          | #469                                                     |
| Durable state is atomic, truthful, and restart-safe                         | §9          | #294–#298, #300, #301, #305, #306, #451, #462–#465, #473 |
| The verification gate is trustworthy (parity, no masked flakes)             | §10         | #452, #458, #509                                         |

The per-rule test implications are the acceptance bars for the cited issues, per the posture
doc's "how we will know we got it right" — with two implications explicitly deferred to their
owners' design work rather than claimed complete here: §8's wake-rate budget carries a
measurement protocol (below) but its numeric budget is set by #469, and §7's per-rung
fixtures depend on #480's platform inventory. Scenario-level coverage requirements join
[004 §3](./004-validation-testing.md) as each rule moves to _current_.
