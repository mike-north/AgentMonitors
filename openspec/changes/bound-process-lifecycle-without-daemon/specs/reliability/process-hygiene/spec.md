## ADDED Requirements

### Requirement: In-flight spawned work cleanup without a live daemon

Cleanup of in-flight spawned work MUST NOT depend on the daemon being alive to perform it; the crash-survival guarantee is that in-flight work stays bounded across daemon death.

#### Scenario: Daemon crashes with several commands in flight

- **GIVEN** several monitored commands are running with pending timeouts
- **WHEN** the daemon crashes
- **THEN** each command's covered tree still terminates no later than its own hard upper bound, with no daemon present

### Requirement: Restart sweep is not a substitute for the lifetime bound

The restart sweep SHALL be treated as complementary reconciliation only; a command's lifetime bound SHALL NOT be satisfied by relying on a later daemon start to reap it.

#### Scenario: Deadline case versus sweep case

- **WHEN** the daemon is killed mid-command
- **THEN** the covered tree is asserted to terminate at its deadline without waiting for any restart
- **AND** a close-on-exec descendant that survives daemon death is asserted only as a sweep-reconciliation case at the next daemon start, never as a deadline case

### Requirement: Close-on-exec descendant residual

A close-on-exec descendant that survives daemon death SHALL be treated as unbounded once the daemon is gone, and SHALL be reconciled by the next daemon start's restart sweep; the system SHALL NOT claim a lifetime bound for it while this residual gap remains open under #470.

#### Scenario: Close-on-exec survivor reconciled at next start

- **GIVEN** a close-on-exec descendant survived a daemon SIGKILL
- **WHEN** the daemon next starts
- **THEN** the restart sweep identity-verifies and reaps it
- **AND** no surface claimed it was bounded in the interim

## MODIFIED Requirements

### Requirement: Lifetime bound across daemon death

The command lifetime bound (configured `timeout` plus the 5-second grace) SHALL hold even if the daemon dies before the timeout fires: spawned work SHALL be self-bounding, with the mechanism enforcing the window surviving daemon death, so the command's covered tree terminates at its deadline with no daemon present.

#### Scenario: Daemon hard-killed mid-command

- **GIVEN** a monitored command with a pending `timeout`
- **WHEN** the daemon is killed with SIGKILL before the timeout fires
- **THEN** the command's covered tree (the original-group mechanism class) still terminates at its deadline with no daemon present
- **AND** no descendant in that covered tree reparents to the OS supervisor and keeps running
