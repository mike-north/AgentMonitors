# reliability/process-hygiene Specification

## Purpose

Hygiene of Agent Monitors' own process tree — the daemon, channel servers, and everything monitors
cause it to spawn: the containment-boundary vocabulary, the time-bounded execution of monitored
commands with platform tree termination, and the standing prohibitions on guessing at escaped
processes or governing the user's own workloads. These are reliability guarantees, not a security
boundary (BP4 defines the local trust boundary).

## Requirements

### Requirement: Containment boundary membership

The system SHALL treat a process as within the containment boundary if and only if Agent Monitors spawned it (directly, or transitively through a monitored command) and it has not done both of: (a) deliberately detached itself into an independent session, daemonized away from the spawned process tree; and (b) erased the marks identifying it as Agent Monitors' (its spawned-tree position, its process group/session lineage, and any platform identity marks the containment mechanism applies).

#### Scenario: Direct and transitive children are within the boundary

- **WHEN** a monitored command `['sh', '-c', 'sleep 30 & wait']` is spawned by the daemon
- **THEN** both the `sh` process and its backgrounded `sleep` descendant are within the containment boundary

#### Scenario: Detached but still identifiable remains within the boundary

- **WHEN** a spawned descendant detaches into an independent session but keeps its identity marks (spawned-tree lineage, process group/session lineage, or platform containment marks)
- **THEN** it remains within the containment boundary

#### Scenario: Detached and identity-erased has escaped

- **WHEN** a spawned descendant both detaches into an independent session and erases every mark identifying it as Agent Monitors'
- **THEN** it is outside the containment boundary and is an escaped process

#### Scenario: Processes Agent Monitors never spawned are outside the boundary

- **WHEN** a process was started by the user (e.g. their own dev server) and not by Agent Monitors directly or transitively
- **THEN** it is outside the containment boundary

### Requirement: Guarantees are scoped to the containment boundary

Every process-hygiene guarantee SHALL be stated and evaluated only for processes within the containment boundary; the system SHALL NOT state an unscoped absolute such as "no orphans". Boundary exits SHALL be either reconcilable (identity kept) or documented as escapes (identity erased). Rationale: an absolute "no orphans" claim is unfalsifiable; a boundary-scoped claim is testable.

#### Scenario: An escaped process is not a guarantee violation

- **WHEN** a descendant detaches and erases its identity marks, then keeps running after its command's timeout
- **THEN** that survival is classified as an escape, not as a violation of any lifetime guarantee in this capability

### Requirement: Monitored command lifetime window

A monitored command SHALL run only within its configured window: escalation SHALL begin at the configured `timeout`, and the hard upper bound on the command's lifetime SHALL be the configured `timeout` plus the fixed 5-second forceful-kill grace period. A SIGTERM-ignoring child runs until the grace expires. The `timeout` setting and failure classification are owned by `sources/command-poll`; this capability owns the escalation.

#### Scenario: SIGTERM-ignoring command resolves at timeout plus grace

- **GIVEN** a monitored command with `timeout: 1s` that ignores SIGTERM
- **WHEN** the timeout fires
- **THEN** escalation begins at 1s
- **AND** the command is forcefully terminated when the 5-second grace expires, resolving in approximately 6s

#### Scenario: Hung child leaves no orphan

- **GIVEN** a monitored command that hangs (`setTimeout(() => {}, 60000)`) with `timeout: 1s`
- **WHEN** the observation completes
- **THEN** the child is killed within the grace window and the spawned-children count returns to its baseline

### Requirement: POSIX original-process-group escalation

On POSIX each monitored command SHALL be spawned as the leader of its own process group, and the runtime SHALL send SIGTERM to that original process group (signalling the negative PID) when the timeout fires and, after the 5-second grace, SIGKILL to that same original process group. The SIGKILL step SHALL run even if the direct child has already exited.

#### Scenario: Backgrounded shell descendant is terminated

- **GIVEN** a monitored command `['sh', '-c', 'sleep 30 & echo $! > child.pid; wait']` with `timeout: 1s`
- **WHEN** the timeout fires
- **THEN** the observation resolves within timeout + grace + slack (under 9s) as a timed-out failure
- **AND** the `sleep` grandchild identified by the recorded pid is no longer alive

#### Scenario: Descendant ignoring SIGTERM after its parent exits

- **WHEN** the direct child exits on SIGTERM while a descendant in the same original process group ignores SIGTERM
- **THEN** the SIGKILL to the original process group still fires after the 5-second grace and terminates that descendant

### Requirement: Windows forceful tree termination

On Windows the runtime SHALL invoke `taskkill /PID <pid> /T /F` when the timeout fires and SHALL repeat that forceful tree kill after the 5-second grace period as a defensive retry. There is no softer Windows phase to escalate from.

#### Scenario: Timed-out command on Windows

- **GIVEN** a monitored command on Windows that exceeds its `timeout`
- **WHEN** the timeout fires
- **THEN** the runtime runs `taskkill /PID <pid> /T /F` for the command's pid
- **AND** runs the same `taskkill /PID <pid> /T /F` again after the 5-second grace

### Requirement: Group-resident descendants do not outlive the hard bound

A descendant of a monitored command that remains in the command's original process group — for example one holding stdio open or surviving its parent — MUST NOT outlive the command's hard upper bound (configured `timeout` plus 5-second grace). This SHALL hold across the daemon's own orderly shutdown.

#### Scenario: Descendant holding inherited stdio

- **WHEN** a timed-out command's descendant inherited stdout/stderr and remains in the original process group
- **THEN** it is terminated no later than the hard upper bound

#### Scenario: Live daemon run and daemon stop leave no orphan

- **GIVEN** a live `daemon run` subprocess ticking a monitor whose command backgrounds an `sh -c` descendant and exceeds its `timeout`
- **WHEN** the tick times out and a real `daemon stop` follows
- **THEN** the backgrounded descendant is dead once the daemon has fully exited

### Requirement: Out-of-group descendant coverage

Timeout escalation SHALL target only the command's original process group (POSIX) or `taskkill` tree (Windows). A descendant that leaves the original process group/session while keeping its identity is not reached by escalation, and the system SHALL NOT describe such a descendant as lifetime-bounded. Known gap (#480): no deferred-reconciliation reporting exists for it.

#### Scenario: Re-sessioned descendant survives escalation without a bound claim

- **GIVEN** a monitored command that starts a child in a new session (keeping its identity marks) and exceeds its `timeout`
- **WHEN** the §3.1 escalation completes
- **THEN** the re-sessioned child may still be running
- **AND** no surface reports that child as bounded

### Requirement: Lifetime bound across daemon death

The command lifetime bound SHALL be enforced by the daemon process that spawned the command, and the system SHALL NOT claim the bound holds when that daemon dies before the timeout fires. Known gap (#470): a hard-killed daemon can orphan the command and its descendants, which reparent to the OS supervisor.

#### Scenario: Daemon hard-killed mid-command

- **GIVEN** a monitored command with a pending `timeout`
- **WHEN** the daemon is killed with SIGKILL before the timeout fires
- **THEN** the command's lifetime bound is not enforced for that command
- **AND** no surface claims that the command was bounded

### Requirement: No heuristic reaping

The system MUST NOT attempt to reap any process by guessing that it is Agent Monitors'. In particular it MUST NOT reap an escaped process heuristically; closing the escape gap by heuristic reaping is prohibited. Rationale: guessing converts the safe failure mode (a leak) into the fatal one (killing unrelated work).

#### Scenario: Escaped process resembling a poll command

- **GIVEN** a running process whose command line resembles a monitored command but which carries none of Agent Monitors' identity marks
- **WHEN** the daemon runs, ticks, stops, or restarts
- **THEN** the daemon sends that process no signal

### Requirement: No claimed visibility of escaped processes

The system MUST NOT claim visibility of an escaped process in any surface (CLI output, `agentmonitors doctor`, diagnostics); recovery of an escaped process is the user's ordinary OS tooling.

#### Scenario: Doctor does not report escaped processes as tracked

- **WHEN** a descendant has escaped and `agentmonitors doctor` runs
- **THEN** no output claims to list, count, or account for that escaped process

### Requirement: Not a supervisor of user workloads

The system SHALL NOT act as a process manager or supervisor for the user's own workloads (no `pm2`/systemd role): it SHALL NOT keep alive, restart, or adopt processes outside its own observation scheduling.

#### Scenario: Monitored command crashes

- **WHEN** a monitored command exits nonzero or crashes during an observation
- **THEN** the runtime records the observation result and runs the command again only at its next scheduled observation, never as a supervised restart

### Requirement: No resource governance of monitored commands

The system SHALL NOT throttle, quota (CPU/memory), or apply scheduling policy to a monitored command, and SHALL NOT expose a configuration surface for doing so. The contract governs a monitored command's time-boundedness, not its frugality.

#### Scenario: CPU-heavy command

- **WHEN** a monitored command uses as much CPU as it can until it completes or its `timeout` fires
- **THEN** the system applies no CPU, memory, or scheduling limit to it other than the lifetime window
