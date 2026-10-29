## ADDED Requirements

### Requirement: Exhaustive process-state accounting

For any process Agent Monitors spawned, exactly one of five states SHALL hold at all times, with no sixth state: (1) live and bounded, running inside its allowed window; (2) cleaned up, reaped by normal completion, timeout escalation, or a sweep; (3) deferred-reconciliation; (4) abstained, suspected ours but unconfirmed, left alone and warned about; (5) escaped, identity erased and outside the boundary.

#### Scenario: Every spawned process is classifiable

- **WHEN** the daemon's diagnostics enumerate the processes Agent Monitors spawned
- **THEN** each one is in exactly one of: live and bounded, cleaned up, deferred-reconciliation, abstained, or escaped

#### Scenario: Only the escaped state is invisible

- **WHEN** a spawned process is in the deferred-reconciliation or abstained state
- **THEN** that state is visible and reported, not silent
- **AND** escaped is the only state the system neither sees nor claims to account for

### Requirement: Deferred-reconciliation state

An in-boundary process beyond the selected containment rung's deadline reach (a re-sessioned, identity-kept descendant on a lower ladder rung) SHALL be in the deferred-reconciliation state: attributable, reported in diagnostics, and reaped at the next daemon start. The system SHALL NOT describe it as bounded in the interim and SHALL NOT leave it silently unaccounted.

#### Scenario: Deferred descendant is attributed and reported

- **GIVEN** the daemon runs on a rung below kernel-enforced group containment
- **WHEN** a monitored command re-sessions a child that keeps its identity marks and the command times out
- **THEN** diagnostics attribute that child to its command and report it as deferred-reconciliation

#### Scenario: No daemon start means no reap, but the report stays honest

- **GIVEN** a descendant in the deferred-reconciliation state
- **WHEN** no subsequent daemon start occurs
- **THEN** the descendant may keep running
- **AND** no surface claims it was bounded

### Requirement: Only deadline-enforcing rungs claim a lifetime bound for out-of-group descendants

A containment rung SHALL describe itself as providing a lifetime bound for re-grouped or re-sessioned descendants only if its mechanism enforces the deadline for them, and the achieved-guarantee report SHALL reflect that distinction.

#### Scenario: Fallback rung report

- **WHEN** the selected rung is group/session escalation + self-bounding watchdog
- **THEN** the report claims a deadline bound for group-resident descendants only
- **AND** states that re-sessioned descendants are deferred to the next start's sweep

### Requirement: Automatic strongest containment mechanism selection

On startup the daemon SHALL probe the containment mechanisms the platform actually exposes and automatically select the highest capability-ladder rung whose probe succeeds on this machine.

#### Scenario: Highest succeeding rung is selected

- **GIVEN** capability-probe fixtures in which rung 1's probe fails and rungs 2 and 3 succeed
- **WHEN** the daemon starts
- **THEN** it selects rung 2 (group/session escalation + self-bounding watchdog)

### Requirement: No user-facing containment configuration

There MUST NOT be a user-facing reliability tier or configuration surface for choosing the containment mechanism; disclosure of the selected mechanism SHALL be a report, never a knob.

#### Scenario: No containment knob exists

- **WHEN** a user inspects `MONITOR.md` frontmatter, CLI flags, and daemon configuration
- **THEN** none of them selects or overrides the containment mechanism

### Requirement: Containment probing never prompts

Containment probing MUST NOT trigger user-facing permission prompts.

#### Scenario: Probe on a fresh machine

- **WHEN** the daemon probes containment mechanisms at startup
- **THEN** no OS permission prompt or interactive confirmation is shown to the user

### Requirement: Optional containment component never gates an install

Where the strongest platform primitive requires an optional component, its absence MUST NOT gate a working install: the strongest available fallback SHALL run, and the component SHALL be detected and used automatically when present.

#### Scenario: Optional component absent then installed

- **GIVEN** the optional component required by the strongest primitive is absent
- **WHEN** the daemon starts
- **THEN** it runs on the strongest available fallback rung
- **AND** after the component is installed, the next daemon start detects and uses it without configuration

### Requirement: Containment capability ladder ordering

"Strongest" SHALL be adjudicated against this ordering, each rung defined by the guarantee it enforces: (1) kernel-enforced group containment — an OS primitive that tracks and can tree-kill every descendant regardless of re-grouping or re-sessioning; (2) group/session escalation of the original group plus a daemon-death-independent self-bounding watchdog; (3) bookkeeping fallback — direct-child termination plus the identity-marked sweep at next start.

#### Scenario: Rung 1 guarantee

- **GIVEN** rung 1 is selected
- **WHEN** a command re-sessions a descendant and its timeout fires
- **THEN** the descendant is terminated at the deadline

#### Scenario: Rung 2 guarantee

- **GIVEN** rung 2 is selected
- **WHEN** a command's group-resident and re-sessioned descendants outlive its timeout
- **THEN** the group-resident descendants are terminated at the deadline
- **AND** the re-sessioned descendant is in the deferred-reconciliation state and is reaped by the next start's sweep

#### Scenario: Rung 3 guarantee

- **GIVEN** rung 3 is selected
- **WHEN** a command's timeout fires
- **THEN** the direct child is terminated
- **AND** every other in-boundary process is in the deferred-reconciliation state until the next start's sweep reaps it

### Requirement: Achieved containment guarantee reporting

The daemon SHALL be able to answer accurately, per machine, which containment guarantee is in effect, surfaced at minimum via `agentmonitors doctor`. The report SHALL name the mechanism selected and the guarantee level achieved, and SHALL NOT advertise a level the current environment cannot enforce.

#### Scenario: Doctor reports the selected rung

- **WHEN** `agentmonitors doctor` runs on a machine where rung 2 is selected
- **THEN** the output names the mechanism and its guarantee, e.g. "containment: process-group escalation + self-bounding watchdog (strongest available on this platform without optional kernel containment; escapes limited to identity-erasing detachment — see docs)"
- **AND** the reported guarantee matches the selected rung

### Requirement: Containment report tracks environment downgrades

When a previously selected containment mechanism becomes unavailable, the report SHALL change to the guarantee of the newly selected rung and SHALL NOT keep the old claim.

#### Scenario: Mechanism becomes unavailable

- **GIVEN** the daemon previously selected rung 1
- **WHEN** the rung-1 mechanism is unavailable at the next probe
- **THEN** `agentmonitors doctor` reports the lower rung's mechanism and guarantee, not rung 1's

### Requirement: Escape posture is documented for users

User-facing documentation SHALL state plainly that a process which both detached and erased its identity has left the containment boundary, that Agent Monitors cannot see or reap it, and that recovery is the user's ordinary OS tooling.

#### Scenario: Docs state escape recovery

- **WHEN** a user reads the reliability documentation on the public docs site
- **THEN** it states that escaped processes are outside Agent Monitors' visibility and are recovered with the user's ordinary OS tools

## MODIFIED Requirements

### Requirement: Out-of-group descendant coverage

An in-boundary descendant that leaves the command's original process group/session while keeping its identity SHALL be either bounded at the deadline (on a rung whose mechanism tracks descendants across re-grouping/re-sessioning, timeout termination reaches it directly) or placed in the reported deferred-reconciliation state (on lower rungs) — never silently unaccounted.

#### Scenario: Re-sessioned descendant survives escalation without a bound claim

- **GIVEN** the selected rung is below kernel-enforced group containment
- **AND** a monitored command starts a child in a new session (keeping its identity marks) and exceeds its `timeout`
- **WHEN** the original-group escalation completes
- **THEN** the re-sessioned child may still be running
- **AND** no surface reports that child as bounded; it is reported as deferred-reconciliation instead

#### Scenario: Kernel-containment rung terminates a re-sessioned child at the deadline

- **GIVEN** the selected rung is kernel-enforced group containment
- **WHEN** a monitored command re-sessions a child that keeps its identity marks and the timeout fires
- **THEN** that child is terminated at the deadline

#### Scenario: Fallback rung reaps the re-sessioned child at the next daemon start

- **GIVEN** the selected rung is below kernel-enforced group containment
- **WHEN** a monitored command re-sessions a child that keeps its identity marks and the command times out
- **THEN** the child is reported as deferred-reconciliation
- **AND** it is reaped by the next daemon start's restart sweep
