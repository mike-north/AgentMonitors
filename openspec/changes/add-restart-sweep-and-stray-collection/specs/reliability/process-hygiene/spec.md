## ADDED Requirements

### Requirement: Restart sweep of strays from a dead daemon life

On startup the daemon MUST sweep strays left by a previous daemon life: any process still within the containment boundary (identity kept) that belongs to a dead daemon life MUST be identity-verified and reaped. This includes orphaned poll-command process trees and descendants that detached but kept their identity marks.

#### Scenario: Orphaned tree from a killed daemon life is reaped

- **GIVEN** a daemon was killed while a monitored command's process tree (identity kept) was running
- **WHEN** a new daemon starts
- **THEN** the sweep identity-verifies and reaps that tree

#### Scenario: Detached but identifiable descendant is caught

- **GIVEN** a spawned descendant detached into an independent session but kept its identity marks, and its daemon life is dead
- **WHEN** a new daemon starts
- **THEN** the sweep reaps it

### Requirement: Sweep diagnostics record what was reaped

The restart sweep SHALL record each reaped process in diagnostics with its pid, the identity evidence that confirmed it, and the daemon life it belonged to, so a sweep that silently did nothing is distinguishable from one with nothing to do.

#### Scenario: Successful reap is recorded

- **WHEN** the sweep reaps an orphaned process
- **THEN** diagnostics contain its pid, the identity evidence used, and the daemon life it belonged to

#### Scenario: Nothing to sweep

- **WHEN** a daemon starts with no strays from a previous life
- **THEN** diagnostics distinguish "swept, nothing found" from a sweep that did not run

### Requirement: Unverifiable sweep targets are abstentions

A sweep target that cannot be positively identity-verified SHALL be an abstention — left alone and warned about — and SHALL never be signalled.

#### Scenario: Three separately asserted sweep outcomes

- **GIVEN** one orphan whose identity is confirmed and one suspected orphan whose identity cannot be confirmed
- **WHEN** a new daemon starts and sweeps
- **THEN** the confirmed orphan is reaped with a diagnostic record
- **AND** the unconfirmed process is left alone and an abstention warning is produced
- **AND** no process outside the containment boundary is signalled

### Requirement: Stray daemon, channel server, and socket collection

Stray daemons, stray channel servers, and stale sockets left by a previous daemon life MUST be detectable and collectable, subject to the same identity verification as every other cleanup path.

#### Scenario: Stray channel server and stale socket after a hard kill

- **GIVEN** a daemon was hard-killed, leaving a channel server process and its socket file behind
- **WHEN** stray collection runs
- **THEN** the identity-verified stray channel server is reaped and the stale socket is removed

### Requirement: Hardware failure is reconciled at the next start

After a hardware failure such as power loss, the next daemon start SHALL reconcile leftover in-boundary processes through the restart sweep; the system SHALL NOT claim that orphaning through hardware failure never occurs.

#### Scenario: Hard kill plus restart leaves a clean process list

- **GIVEN** the daemon and its in-flight commands are killed abruptly
- **WHEN** the daemon is started again
- **THEN** the process list contains no in-boundary process from the dead daemon life, without manual intervention, except abstained ones that were warned about
