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
> [#426](https://github.com/mike-north/AgentMonitors/issues/426), and the durable-state and
> verification set cited in §9–§10, tracked in milestones M0, M1 and M3). Rules marked **current**
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

### 2.2 Exhaustiveness (current vocabulary; restart reconciliation and durable abstention diagnostics are current on POSIX; full-boundary deadline reporting and active warnings remain target — #480, #507)

For any process Agent Monitors spawned, exactly one of the following MUST hold at all times —
there is no sixth state:

1. **Live and bounded** — running inside its allowed window (§3).
2. **Cleaned up** — reaped by normal completion, timeout escalation (§3.1), or a sweep (§4.2).
3. **Deferred-reconciliation** — in-boundary but beyond the selected containment rung's
   deadline reach (a re-sessioned, identity-kept descendant on a lower §7.1 rung, §3.2);
   attributable, reported, and reaped at the next daemon start — explicitly **not** bounded
   in the interim, and never silently unaccounted.
4. **Abstained** — suspected ours but unconfirmed; left alone, recorded in diagnostics, and warned about where a current warning surface exists (§6.1; the active warning surface remains #507).
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

Both escalation steps are identity-verified (§5) before they signal. A descendant still in the
original group is confirmed through the group's continuity (§5.1), including one forked after
the SIGTERM step: by the command's leader before it exits (the read at the leader's exit), or by
any confirmed member that is still alive at one of the membership readings taken every 250 ms
through the grace period. Verification therefore does not exempt such descendants from the
bound. The SIGKILL step abstains (§2.2 state 4) only when continuity cannot be shown: the
process table cannot be read, or the group holds none of the processes confirmed as its members.

**Exception to the bound above (the hand-off residual).** Continuity is re-established only at
a reading. After the command's leader has exited, a group member that forks a process and exits
between two consecutive readings (within one 250 ms interval plus one read; the read time grows under load, up to the 5 s `ps` cap), while no other
confirmed member is alive, hands the group to a process no reading saw beside a confirmed
member. That process, and anything it forks, cannot be told apart from unrelated work that
reused an emptied group id, so the SIGKILL step abstains and they MAY outlive the hard upper
bound. The abstention is reported (§6.1). While the process table is readable, this is the only
way a process that stays in the original group escapes the bound. (A group that truly empties
and whose id is then reused also makes the step abstain, but nothing of ours is left in it; see
§5.1's residual window.)

Verification reads the process table, which adds latency to each step. The SIGKILL goes out
after the later of the grace expiry and the end of the SIGTERM step's read, and after the
SIGKILL step's own read, once any grace-period reading still in flight and (if the leader
exited) the read taken at its exit have landed. Normally that adds tens of milliseconds to
timeout + 5 s. On macOS each read is capped by a 5-second `ps` timeout, and the in-flight and
exit reads both started before the SIGKILL step, so even a pathologically slow table delays the
SIGKILL to at most timeout + 15 s; a read that times out is unreadable, and that step abstains.
On Linux the reads are `/proc` file reads, which do not wait on other processes.

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

### 4.2 The restart sweep (current Linux cleanup and macOS conservative abstentions for command-poll; adjacent hygiene remains target — #426)

Before its first tick, the daemon reconciles command work from dead previous lives in its
workspace. A separate owner-only SQLite journal beside the runtime database
(`<db>.commands.sqlite`) commits a random daemon-life nonce, boot identity, workspace and daemon
`(pid, pgid, startTime)` at the first awaited command admission, before any command can spawn. The command source applies that nonce as
`AGENTMONITORS_COMMAND_LIFE` after the authored environment and synchronously records the direct
PID before returning to the event loop. Ownership admission is awaited before spawn: the life row is
created only when a command actually needs its mark. Opening a journal with no previous admitted
lives records a complete empty sweep without boot, process-table or environment queries. Pending
old lives are still reconciled before IPC readiness and the first tick; this is not deferred
cleanup. No command timeout or test timeout is extended. A SIGKILL during spawn still leaves the precommitted nonce
available for discovery. Normal direct-child exit retains both the life nonce and the numeric
original-group suspicion: it cannot discard accounting for surviving descendants.

The sweep reads the platform process table and inherited ownership marks, independently of current
parent, group or session membership. A marked live member also confirms the identities of its
current process-group members, including children that cleared their environment while staying
in that group; their recorded start times carry that confirmation after the marked anchor exits.
A bare stored PGID never confirms a group, and a registered live daemon owner is never an anchor.
An exited or sweep-reaped direct child's numeric identifier remains an original-group suspicion until
reconciliation: an unmarked survivor in that group must receive an abstention and retain its
life when no marked anchor can confirm membership. Direct-child exit alone cannot erase that
accounting obligation. A confirmed reap cannot erase it either: the suspicion survives journal
reopenings until the group has no remaining members, when its life can retire. Numeric suspicion
alone never authorizes a signal.
Marker discovery is bracketed by process-table readings: a group anchor must keep its start time
and group across the readings before it can confirm any members. A recycled PID cannot transfer
a marker from its new process onto unrelated members of its former group. Changed anchors are
recorded as abstentions and are not retried during that startup. This includes a re-sessioned descendant that kept its mark.
A process that detached and erased the mark before discovery is an escape: it is never guessed at
or warned about. A positively running recorded daemon owner is left alone. PID/start-time equality alone does
not prove liveness: a zombie/dead owner no longer supervises work and does not suppress
reconciliation or enter the protected live-owner set. Unavailable terminal evidence withholds
reconciliation with a recorded reason. Missing owner identity on
the same boot is an abstention, not permission to assume the owner died.

Every candidate is signalled individually through `sendVerifiedSignal` with a recorded-process
target. Inside that gate, fresh process identity and boot are checked again, along with the inherited
mark for a candidate discovered through that mark. A group-confirmed candidate instead carries
its positively observed membership and immutable process identity. A changed/missing boot, changed
start time, missing/unreadable required mark or unavailable process table withholds cleanup. The
process-identity reading is the final asynchronous query inside the gate, after boot and mark
checks, so identifier recycling during either earlier query cannot leave stale identity evidence. Stored numeric PIDs are suspicions only; the sweep never signals a stored PGID.
Ownership MUST come from the actual process environment, never matching argv text. Linux reads
`/proc/<pid>/environ` for exactly the requested identifiers. The shipped macOS system `ps` output
mixes argv and environment without an unambiguous boundary, so it cannot prove ownership:
macOS records same-user PIDs as unproven abstentions and does not signal them. Automatic macOS
cleanup remains unavailable until an environment-only reader exists. Its identity/boot reads use
bounded system `ps`/`sysctl` calls; ownership-uncertainty queries request only the supplied PIDs,
in batches of at most 2048, and never read argv or environments. Signal-time ownership queries
never scan all host environments; Linux queries only the candidate PID. Discovery remains bounded
by the pass limit below rather than repeating a host-wide environment scan for each survivor.
Neither platform persists or prints process environments. These marks are reliability evidence
within the same-user trust boundary, not protection against deliberate impersonation by code
running as that user.

Diagnostics are durable `restart_sweeps.result` receipts in the journal: `running`, `complete` or
`incomplete`, start timestamp and per-life/per-PID `reaped`, `abstained`, `gone`, `failed` or
`owner-alive` outcomes. A reap includes PID, start-time/group evidence, boot and daemon life;
abstentions include the reason. An empty complete receipt proves the pass ran with nothing to do;
unreadable discovery is incomplete, and an interrupted pass stays running. Each unreadable
same-user ownership mark records an abstention with its PID, without claiming that PID belongs to
the command. An incomplete pass may still reap positively confirmed work. A readable detached
mark-erased escape has no outcome even when an unrelated unreadable PID makes the pass incomplete.
Decisions are saved incrementally, including discovery obstacles before later identity queries,
and the most recent 20 receipts per workspace are retained. `reaped` additionally requires
terminal evidence (absence, a different start-time incarnation, or a zombie/dead state), not just
an accepted signal. A sent signal with unconfirmed termination is `failed` with a reason.
Later discovery omits ownership reads for the exact PID/group/start-time incarnation already
confirmed terminal; a reused PID with a different identity remains subject to discovery.
Abstained lives remain for later reconciliation. This is the input for #507; no new active warning surface ships here.

Discovery records unchanged ownership uncertainty once per PID per sweep, including across
post-signal snapshots, instead of duplicating it for a numeric suspicion or later snapshot.
When no signal was sent, it stops rather than rescanning that same uncertainty.
After signalling, discovery takes another snapshot to catch late forks. It processes readable
positive evidence even when unrelated unreadable ownership makes the snapshot
incomplete; that uncertainty is saved before further identity queries and cannot discard the
late fork's cleanup or outcome. The same boot, mark and start-time signal gates still apply.
Discovery considers each PID
only once per startup and takes at most eight discovery passes per old life; if work keeps
appearing, the pass is incomplete and each still-discovered PID gets an abstention reason. This
bounds startup work without guessing at identifiers or repeatedly signalling a disputed PID.

The sweep is reconciliation, not the live lifetime bound of #470. Commands from releases before
ownership journaling cannot be safely attributed and are not heuristically collected. Windows
currently records unavailable discovery rather than claiming a successful sweep. Stray daemons,
channel servers and stale sockets remain the separate #426 scope.

**Verified:** `apps/cli/src/commands/daemon-restart-sweep.integration.test.ts` runs real daemon
SIGKILL/restarts and asserts Linux direct/descendant cleanup, detached mark-kept cleanup, mark-erased
escape silence, macOS unproven-environment abstentions, argv-only nonce survival, responsive unrelated PID/PGID survival with diagnostic abstention, previous-boot
recycling despite a retained nonce, and an empty-start receipt. Every owned process is stopped in
cleanup, including assertion failures. `libs/core/src/process/command-process-journal.test.ts`
asserts discovery without a recorded child PID, signal-time mark loss/start-time reuse, unavailable
evidence, live-owner exclusion, group membership, late forks, malformed records, bounded discovery
the distinction between signal acceptance and proven termination, anchor-PID recycling between
discovery readings, reuse of an old daemon PID by the current daemon, and recycling during the
signal-time marker query, zombie-owner reconciliation and unavailable owner-state abstention.
`libs/core/src/process/command-process-marks.test.ts` rejects argv-only nonce ownership, records
an abstention without signalling, bounds queries to requested PIDs, and asserts at most two
host-wide environment scans for startup with 100 survivors (the macOS reader performs zero).
`plugins/source-command-poll/src/command-ownership.test.ts` verifies that failed optional numeric
bookkeeping cannot abandon live command supervision or override the mandatory inherited life mark.

### 4.3 Hardware failure is reconciled, not defeated (current for the §4.2 POSIX command sweep)

A power loss leaves the OS to reap. On the next start, a changed boot identity prohibits signalling
stale identifiers even if their current start ticks or nonce happen to match. This does not promise
survival of physical storage corruption or defeat hardware failure (§11).

## 5. Identity-Verified Cleanup — "we only ever kill what is ours" (current for live signal paths and the POSIX restart sweep — #479, #478; `gc` remains target — #426)

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
and abstain — recording a §6.1 diagnostic that names pid 4242 and why confirmation failed (active warning surface: #507) —
rather than kill the dev server. **This example is the promise:** the worst case is a warning,
never collateral damage.

### 5.1 The verification gate (current)

Every cleanup or enforcement signal goes through one shared gate,
`sendVerifiedSignal` in `libs/core/src/process/process-identity.ts`, which verifies and then
signals, or withholds the signal and reports an abstention. No shipped code signals a stored
pid or pgid any other way. Identity evidence:

- **Live child handle.** While Node still holds an unreaped `ChildProcess` for a pid, the OS
  cannot reuse that pid, nor the process-group id of a group that child leads (a POSIX
  session/group leader cannot leave its group). Signals sent while the handle is unreaped are
  confirmed. Once Node has reaped the child, the handle proves nothing about whoever holds the
  number now: a reaped single process is treated as gone and never signalled by pid.
- **Recorded identity `(pid, pgid, start time)`**, read from the platform process table
  (`libs/core/src/process/process-table.ts`). A pid paired with its start time names one
  process for that process's whole life. A recorded single process is confirmed only if the
  pid's current start time equals the recorded one.
- **Group continuity.** A process-group id cannot be reused while any member of the group
  exists, so a membership reading taken while the group is provably ours confirms every member
  in it, and every such member is within the boundary (§2.1). A reading is taken while the group
  is provably ours when it:
  - **started** while the leader was still unreaped, even if the leader is reaped before it
    completes;
  - started in the leader's `exit` event, which Node emits in the callback that reaps it (once
    a signal has been aimed at the group, the gate starts this read synchronously from that
    event, which confirms processes forked after the previous step, such as work a SIGTERM
    trap starts before exiting); or
  - finds a member confirmed by an earlier reading still in the group.

  Confirmed members accumulate across the escalation. After the leader is reaped, a step
  signals the group if any confirmed member is still in it; an empty group needs no signal.
  Only a group none of whose current members was ever confirmed (continuity lost) or an
  unreadable table makes the step abstain. Lost continuity has two causes the gate cannot tell
  apart: the group emptied and its id was reused, or a member handed the group to a process no
  reading saw beside a confirmed member (below).

- **Grace-period membership tracking.** A step may ask the gate (`trackMembership`) to keep
  reading the group's membership after it signals, until the next step against the same group
  starts. The command-poll SIGTERM step does. Readings run every 250 ms, one at a time (the next
  is scheduled only after the previous one lands), and each reading that is provably ours by
  the rule above confirms every member it lists. A member that forks a process and later exits
  therefore passes continuity to it as long as the member is alive at some reading after the
  process exists. Tracking stops when the next step starts (which first lets a reading still in
  flight land), when a reading shows the group empty, when a reading shows continuity already
  lost (no later reading can restore it), when its `untilMs` backstop elapses, or when the
  caller's abort signal fires. A reading that fails or is unsupported confirms nothing and does
  not stop tracking; if every reading fails, the next step decides from earlier readings alone.
  Its timers never keep the process alive. The interval trades the hand-off window against
  cost: on macOS each reading spawns `/bin/ps` (about 40–50 ms), so 250 ms keeps `ps` running
  for at most about a sixth of a 5-second grace (about 20 readings); on Linux a reading is a
  pass over `/proc`.

Platform evidence comes from what the platform ships, plus Node: on **Linux**,
`/proc/<pid>/stat` (`pgrp` and `starttime`); on **macOS**, `/bin/ps -A -o pid=,pgid=,lstart=`
(start time to the second). Environment-variable marks were rejected because macOS hides the
environment of platform binaries such as `/bin/sh` from other processes. On any other platform,
including Windows, the table is reported as unsupported: signals rest on the live child handle
alone, and anything needing recorded identity abstains.

**Residual window:** the evidence is a process-table read, which takes time (tens of
milliseconds normally; on macOS up to its 5-second `ps` timeout), and `kill(2)` follows it as a
separate system call. A target that empties and is replaced during that read, or between the
read and the signal, is not detected. Replacement requires the pid space to wrap within that
window, and no portable POSIX primitive closes it for process groups. The same window applies
to the reading that starts while the leader is unreaped, to the one started at its exit, and to
each grace-period reading.

**Hand-off residual:** continuity is re-established only at a reading. After the leader has exited
(before then, the read at its exit confirms every member), a member that forks and exits between
two consecutive readings (one tracking interval plus one read, which grows under load up to the 5 s `ps` cap), while no other
confirmed member is alive, leaves the group to a process no reading confirmed; the next step
abstains and that process escapes the bound (§3.1's stated exception). This needs no pid reuse
and is reproducible with ordinary processes, for example `trap '' TERM; sleep 2; sleep 30 &
exit 0` run as the only surviving member. Without tracking (a caller that does not request it),
the window is the whole gap between steps.

### 5.2 Signal-send inventory (current)

Every place shipped code (`libs/`, `apps/`, `plugins/`) sends a signal, and its disposition.
Keep this table current when a signal site is added.

| Site                                                                                                                                                                                                                                     | Signal and target                                                           | Identity evidence                                                                                                                                                                                                                                                   | Disposition                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command-poll` timeout, POSIX (`plugins/source-command-poll/src/index.ts`, `killProcessTree`)                                                                                                                                            | `SIGTERM` to the command's process group                                    | the read starts while the leader is unreaped (the timeout only fires while the command runs); the members it lists are confirmed, a read at the leader's exit confirms later forks, and readings every 250 ms until the follow-up confirm hand-offs between members | verified; if the leader exits during the read, the reading's members still confirm the group; an empty group needs no signal                                      |
| `command-poll` grace follow-up, POSIX (same)                                                                                                                                                                                             | `SIGKILL` to the process group, 5s later (after the `SIGTERM` step's read)  | the leader is unreaped, or a member confirmed earlier (at the `SIGTERM` step, the leader's exit or a grace-period reading) is still in the group                                                                                                                    | verified; an empty group needs no signal; abstains (§6.1) only when continuity is lost (a reused id, or the hand-off residual of §5.1) or the table is unreadable |
| `command-poll` timeout and follow-up, Windows (same)                                                                                                                                                                                     | `taskkill /PID <pid> /T /F`                                                 | live child handle                                                                                                                                                                                                                                                   | verified; the follow-up is skipped once the direct child has been reaped                                                                                          |
| `daemon run --detach` failure cleanup (`apps/cli/src/commands/daemon.ts`, `terminateSpawnedDetachedDaemon`)                                                                                                                              | `SIGTERM`, then `SIGKILL`, to the daemon child it spawned                   | live child handle                                                                                                                                                                                                                                                   | verified; a child that has already exited is never signalled by pid                                                                                               |
| `verify` isolated-daemon teardown (`apps/cli/src/commands/verify.ts`)                                                                                                                                                                    | `SIGTERM`, then `SIGKILL`, to its daemon child                              | live child handle                                                                                                                                                                                                                                                   | verified                                                                                                                                                          |
| Node-internal timeouts: `verify --trigger-cmd` (`execSync` `timeout`), the interpret adapter (`execFile` `timeout`, `libs/core/src/adapter/interpret.ts`), the legacy-socket probe (`spawnSync` `timeout`, `apps/cli/src/daemon-ipc.ts`) | `SIGKILL`/`SIGTERM` to the child Node is running                            | Node signals through its own child before reaping it                                                                                                                                                                                                                | identity-safe by construction; not routed through the gate                                                                                                        |
| Restart command sweep (`libs/core/src/process/command-process-journal.ts`, `CommandProcessJournal.sweep`)                                                                                                                                | `SIGKILL` to each confirmed process PID                                     | committed daemon-life nonce (or group membership observed beside a marked anchor), matching boot, dead owner and fresh start-time identity; required nonce and boot checked again inside the gate                                                                   | verified; uncertainty is a durable abstention, never a group signal                                                                                               |
| Ownership readers (`libs/core/src/process/command-process-marks.ts`, `systemRead`)                                                                                                                                                       | Node's `execFile` timeout sends `SIGKILL` to its own `ps` or `sysctl` child | unreaped child handle held internally by Node                                                                                                                                                                                                                       | identity-safe by construction; not a cleanup of stored identifiers                                                                                                |
| `daemon stop`                                                                                                                                                                                                                            | none sent: an IPC request; the daemon exits itself                          | —                                                                                                                                                                                                                                                                   | not a signal site                                                                                                                                                 |

Classified as not signal sends: `process.kill(pid, 0)` liveness probes (the startup-lock check
in `apps/cli/src/daemon-ipc.ts`; signal 0 delivers nothing), `process.on('SIGTERM' | 'SIGINT')`
handlers (receiving, not sending), and test fixtures under `apps/cli/src/commands/fixtures/`
(test support, not shipped behavior). The restart sweep uses the recorded-process gate; `gc` (#426) remains target and MUST use the same gate when it lands.
`libs/core/src/process/signal-inventory.test.ts` guards the sweep inventory and gate disposition.

**Verified:** gate unit cases (match, recycled pid, missing process, continuity lost through a
reused group id and through an unseen hand-off, unreadable/unsupported table, leader reaped during
a read, a late fork confirmed by the read at the leader's exit, grace-period tracking: a hand-off
confirmed by a reading, no overlapping reads, stopping on an empty reading, on lost continuity, at
the next step after an in-flight reading lands, on abort and at `untilMs`, unreadable or failing
readings, unref'd timers; Linux `/proc` read errors and bounded concurrency) in
`libs/core/src/process/process-identity.test.ts`; the `command-poll` TERM-trap late-fork SIGKILL,
the hand-off from a TERM-ignoring member during the grace period, TERM → KILL escalation and
clean-exit cases in `plugins/source-command-poll/src/identity-verified-cleanup.test.ts`; the command
exiting during the SIGTERM step's read in
`plugins/source-command-poll/src/identity-verified-cleanup.read-window.test.ts`; the
reaped-child/recycled-pid case for detach cleanup in `apps/cli/src/commands/daemon.test.ts`. A
reused group id cannot be produced with real processes without wrapping the pid space, so that
cause of lost continuity is proven against a fabricated process table only. The hand-off cause
can be produced with real processes (§5.1's example) but depends on landing inside one tracking
interval, so it too is asserted against a fabricated table, which pins the abstention
deterministically.

**Test implication (per #479's acceptance criteria):** a recycled-identifier fixture MUST
produce abstention, not a signal; every live signal path (not only the sweep) MUST route
through the same verification.

## 6. The Two Leak Classes

### 6.1 Abstention — visible, warned about (target — #507)

**Current interim surface (#479):** each live-path abstention is written as one warning line to
the stderr of the process that withheld the signal — the daemon log for a background daemon —
naming the target, the members observed, the reason and the uncertainty, in the calibrated
wording below. It is not yet durable, deduplicated, or delivered through `doctor` or sessions;
that remains #507.

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

## 9. Durable-State Truthfulness (target — milestones M1 and M3)

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

## 10. Verification-Gate Trust (target — milestone M0)

The claims above are only as credible as the gate that verifies them, so the gate itself
carries commitments (#504's verification-gate expectations):

- **Local gate ≡ CI gate.** What the workspace verification scripts run locally MUST match
  what CI enforces; a suite that runs only in CI (or only locally) is drift
  ([#458](https://github.com/mike-north/AgentMonitors/issues/458)). Files that exist only
  because a tool is running on this machine are drift too: `.agentmonitors/` runtime state
  ([002](./002-runtime-delivery.md) §11.3) and the worktrees nested under `.claude/worktrees/`
  MUST NOT reach a workspace check.
- **No masked flakes.** Retry budgets absorb the environment, never hide defects: a test
  that consumes its full retry budget on every run is a defect
  ([#452](https://github.com/mike-north/AgentMonitors/issues/452)), and a nondeterministic
  failure on an unrelated diff is a tracked defect with an owner, never re-rolled as routine
  ([#509](https://github.com/mike-north/AgentMonitors/issues/509),
  [#475](https://github.com/mike-north/AgentMonitors/issues/475),
  [#477](https://github.com/mike-north/AgentMonitors/issues/477);
  [#548](https://github.com/mike-north/AgentMonitors/issues/548) is the fixed exemplar: #506
  first widened an assertion to accept the symptom, which hid a test's descriptor double close
  until the same defect surfaced as `spawn EBADF`).
- **Failures are diagnosable from artifacts.** A CI-only failure MUST capture enough state
  (spawned daemon/subprocess logs) to be root-caused without re-running (#509's acceptance
  criterion).

**Test implications (executable, not historical):** a gate-parity check asserting the CI
workflow's test commands are derivable from the workspace scripts (#458's acceptance bar); a
guard asking git and Prettier whether the adapter's hook-state path is ignored, which fails in CI
even though CI never has such a file (`scripts/runtime-state-ignored.test.ts`); a guard asking git,
Prettier and ESLint the same about a nested worktree path (`scripts/nested-worktrees-ignored.test.ts`);
a retry-budget assertion that the guarded suite passes with retries disabled (`--retry=0`) so a
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
| No report, ever, of signalling a process that was not ours                  | §5          | #479 (live paths, current), #478                         |
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
