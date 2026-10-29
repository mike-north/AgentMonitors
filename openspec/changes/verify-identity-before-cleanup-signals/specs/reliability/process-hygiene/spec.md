## ADDED Requirements

### Requirement: Identity verification before every cleanup signal

Before sending any cleanup signal on any path — live reaping, timeout-escalation follow-ups, the restart sweep, and `gc` — the daemon MUST positively verify, at signal time, that the target process is the one it believes it is, by comparing identity marks (start time, lineage, and the containment marks applied by the selected containment mechanism).

#### Scenario: Every live signal path routes through verification

- **WHEN** any cleanup path (live reaping, timeout escalation follow-up, restart sweep, or `gc`) is about to signal a process
- **THEN** that signal is preceded by the same signal-time identity verification

### Requirement: Recycled identifiers are never signalled

A stored pid, pgid, or session id whose identity marks no longer match — because the OS recycled the identifier onto unrelated work — MUST NOT be signalled.

#### Scenario: Recycled pid after a daemon crash

- **GIVEN** the daemon recorded pid 4242 for a poll command and then crashed
- **AND** by restart the OS has assigned pid 4242 to the user's dev server
- **WHEN** the restart sweep considers pid 4242
- **THEN** it compares identity marks, finds a mismatch, and sends no signal
- **AND** it produces an abstention warning naming pid 4242 and why confirmation failed

#### Scenario: Recycled-identifier fixture

- **GIVEN** a fixture in which a stored identifier now names a process with different identity marks
- **WHEN** any cleanup path runs against that identifier
- **THEN** the result is an abstention, not a signal

### Requirement: Verification failure abstains and never escalates

Identity-verification failure SHALL be an abstention, never an error path that escalates to force. Killing an unrelated process is prohibited in every failure mode; a missed cleanup is recoverable and reportable. Rationale: prefer a leak to a wrong kill.

#### Scenario: Verification cannot complete

- **WHEN** identity verification for a cleanup target fails or cannot be completed
- **THEN** no SIGTERM, SIGKILL, or `taskkill` is sent to the target
- **AND** the target is recorded as abstained
