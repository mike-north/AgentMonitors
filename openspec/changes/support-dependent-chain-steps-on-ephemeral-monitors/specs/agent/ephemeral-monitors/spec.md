## ADDED Requirements

### Requirement: Daemon-armed chain steps are ephemeral monitors

The ephemeral-monitor primitive SHALL be sufficient to serve as a step of a declarative dependent chain (#124): when a prior step fires, the daemon MUST be able to register the next step as an ephemeral monitor itself (daemon-armed), session-scoped to the chain's declaring lead session, on the same pipeline as any other ephemeral monitor (AP7). A chain MUST NOT be implemented as a parallel monitoring system.

#### Scenario: Next step armed when prior step fires

- **GIVEN** a session-scoped chain "when monitor A fires, arm monitor B" declared by lead session `S1`
- **WHEN** monitor A fires
- **THEN** the daemon registers B as an ephemeral monitor bound to `S1`, with an `ephemeral:S1/<ulid>` id, without any further agent command
- **AND** B is evaluated on the normal tick and its events project into `S1` only

### Requirement: Chain step reaped when satisfied

An ephemeral monitor serving as a chain step MUST be reaped when its step is satisfied, in addition to being reaped when its declaring session ends, with the same retention of already-materialized events as any other reap.

#### Scenario: Satisfied step reaped

- **GIVEN** an armed chain step B bound to `S1`
- **WHEN** B's step is satisfied
- **THEN** B's status becomes `reaped`, it is no longer observed, and its materialized events remain

#### Scenario: Session end reaps an unsatisfied step

- **WHEN** `S1` closes while step B is armed and unsatisfied
- **THEN** B is reaped and is not re-armed after a daemon restart
