## ADDED Requirements

### Requirement: Local verification gate matches CI

What the workspace verification scripts run locally MUST match what CI enforces; a suite that runs only in CI, or only locally, SHALL be treated as drift (#458).

#### Scenario: Gate-parity check

- **WHEN** the gate-parity check runs
- **THEN** it asserts every test command in the CI workflow is derivable from the workspace scripts
- **AND** it fails if a suite (e.g. `test:serial` or the standalone-consumer check) runs in CI but not under the local gate

### Requirement: Retry budgets never mask defects

Retry budgets SHALL absorb environmental noise only; a test that consumes its full retry budget on every run MUST be treated as a defect (#452).

#### Scenario: Guarded suite with retries disabled

- **WHEN** the guarded suite runs with retries disabled (`--retry=0`)
- **THEN** it passes, so a budget-exhausting test fails loudly instead of being masked

### Requirement: Nondeterministic failures are owned defects

A nondeterministic failure on an unrelated diff SHALL be tracked as a defect with an owner, never re-rolled as routine (#509, #475, #477).

#### Scenario: Flake on an unrelated pull request

- **WHEN** CI fails nondeterministically on a diff unrelated to the failing test
- **THEN** the failure is tracked as an owned defect issue rather than resolved by re-running CI

### Requirement: Test teardown restores mutated global state

A suite that mutates process-global state such as `PATH` SHALL restore it in teardown even when a test times out (#477).

#### Scenario: Timed-out test that mutated PATH

- **GIVEN** a test that modifies `PATH` and then exceeds its timeout
- **WHEN** suite teardown runs
- **THEN** `PATH` is restored to its original value before subsequent tests run

### Requirement: CI-only failures are diagnosable from artifacts

A CI-only failure MUST capture enough state — spawned daemon and subprocess logs — to be root-caused without re-running (#509).

#### Scenario: Forced failure renders the diagnostic dump

- **WHEN** a forced-failure test runs for an instrumented subprocess harness (the Docker-smoke forced-failure cases are the pattern)
- **THEN** the harness's diagnostic dump of spawned daemon/subprocess logs actually renders
