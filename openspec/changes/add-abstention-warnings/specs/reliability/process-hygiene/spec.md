## ADDED Requirements

### Requirement: Abstentions produce active user-visible warnings

An abstention — a suspected-ours process left alone because its identity could not be confirmed — MUST produce an active, durable, user-visible warning, not merely a diagnostics record. The warning SHALL be retrievable via `agentmonitors doctor` and SHALL be delivered into the next active lead session through the normal delivery machinery (per the `delivery/session-projection` capability).

#### Scenario: Live-path abstention reaches doctor and the session

- **GIVEN** a lead session is active
- **WHEN** a live cleanup path abstains on a process
- **THEN** `agentmonitors doctor` shows the warning
- **AND** the warning is delivered into the active lead session

### Requirement: Abstention warnings persist without a session

An abstention that occurs with no session open (typical for a startup sweep) MUST persist, surviving daemon restarts, and MUST surface when a user surface next exists. It MUST NOT silently expire.

#### Scenario: Startup-sweep abstention with no session

- **GIVEN** no session is open
- **WHEN** the startup sweep abstains on a process and the daemon is then restarted
- **THEN** the abstention warning still exists after the restart
- **AND** it is delivered when the next lead session opens

### Requirement: Abstention warnings state uncertainty honestly

An abstention warning SHALL name what was left alone (pid, observed identity marks, and why confirmation failed), SHALL state uncertain confidence plainly — never presenting a suspicion as a certainty — and SHALL tell the user what they can do (inspect or end the process themselves).

#### Scenario: Startup-sweep warning wording

- **WHEN** the startup sweep abstains on pid 4242 running `sh -c poll.sh`
- **THEN** the warning names pid 4242 and its command, says it looks like it may be ours because it matches the spawn lineage of a previous daemon life, says its identity marks could not be confirmed so it was not touched, and says the user can end it themselves with details in `agentmonitors doctor`

#### Scenario: Certainty phrasing is a failure

- **WHEN** an abstention warning's text asserts the process is definitely Agent Monitors' (e.g. "this is our stray process")
- **THEN** the warning violates this requirement

### Requirement: Abstention warnings are deduplicated

The same abstained process observed across N ticks or sweeps SHALL yield one warning, re-raised only on a meaningful change.

#### Scenario: Repeated observations of one abstained process

- **WHEN** the same abstained process is observed on 5 consecutive sweeps with no change in its identity evidence
- **THEN** exactly one warning exists for it
