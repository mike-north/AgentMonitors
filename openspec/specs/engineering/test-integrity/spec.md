# engineering/test-integrity Specification

## Purpose

The repository's test-suite obligations: which test layer is the proof surface for which kind of
behavior (runtime, CLI integration, fresh-install E2E), the guards that keep package suites from
passing vacuously, and the assertion style tests must follow so they can actually detect regressions.

## Requirements

### Requirement: Every major rule has a concrete proving test

Each major normative rule SHALL have at least one concrete, testable scenario backed by a named test; a rule whose required scenario has no covering test MUST be tracked as an explicit test gap rather than assumed covered.

#### Scenario: Required scenario without a test

- **WHEN** a requirement's scenario has no test that exercises it
- **THEN** it is recorded as a test gap with the missing assertion described, until a test closes it

### Requirement: Runtime tests prove durable runtime semantics

Runtime tests in `libs/core` SHALL be the primary proof surface for state persistence across runtime restarts, due scheduling, delivery lifecycle semantics, session projection, and hook state correctness.

#### Scenario: Restart persistence is proven at the runtime layer

- **WHEN** a change affects source-state persistence or delivery lifecycle rules
- **THEN** a runtime test in `libs/core/src/runtime/` constructs the runtime, restarts it over the same database, and asserts the persisted state and resulting deliveries

### Requirement: CLI integration tests prove command wiring

CLI integration tests in `apps/cli` SHALL be the primary proof surface for command wiring, output shape, argument validation, and round-trip behavior through the daemon/runtime interface.

#### Scenario: Command round-trips through the daemon

- **WHEN** a change affects a command that talks to the daemon
- **THEN** a CLI integration test invokes the command and asserts its output shape and exit code against a real daemon/runtime round trip

### Requirement: Fresh-install E2E proves the hooks path from a global install

A fresh-environment E2E (`pnpm test:e2e-fresh-install-hooks`, run in CI on every PR) SHALL globally install the packed `agentmonitors` launcher into an isolated npm prefix with no workspace `node_modules` access, bootstrap a project with `agentmonitors init`, fire a `file-fingerprint` monitor, and confirm delivery via `agentmonitors hook deliver` fed a real Claude Code `UserPromptSubmit` stdin payload.

#### Scenario: Install to first signal

- **GIVEN** every publishable package packed to tarballs and the launcher installed from them into an empty npm prefix
- **WHEN** a fresh project is initialized, a watched file is changed, and `hook deliver` is invoked with a `UserPromptSubmit` payload
- **THEN** the hook's stdout carries the monitor's signal

### Requirement: Fresh-install E2E runs the launcher's own entry point

Every CLI invocation in the fresh-install E2E MUST run the `agentmonitors` launcher package's own installed entry point (`<prefix>/lib/node_modules/agentmonitors/bin/agentmonitors.cjs`), not the `<prefix>/bin/agentmonitors` symlink. Rationale: `@agentmonitors/cli` also declares that bin name and always wins the global link, so the symlink would bypass the launcher's indirection.

#### Scenario: Bin symlink resolves to the CLI package

- **GIVEN** `@agentmonitors/cli` and `agentmonitors` are installed together in one global prefix
- **WHEN** the E2E invokes the CLI
- **THEN** it executes the launcher's `bin/agentmonitors.cjs`, exercising its resolution of `@agentmonitors/cli`

### Requirement: Package test suites fail when no tests run

Every test-bearing package's vitest config MUST leave `passWithNoTests` at `false` (never `true`), so that deleting, renaming, or excluding all of a package's test files fails its Nx `test` target. This applies to the default `vitest.config.ts` of every package in `PACKAGE_DIRS` and to `apps/cli/vitest.serial.config.ts` and `scripts/vitest.config.ts`.

#### Scenario: A package opts into passing with no tests

- **WHEN** any guarded vitest config resolves to `passWithNoTests: true`
- **THEN** `pnpm test:scripts` fails

#### Scenario: New publishable package is guarded automatically

- **WHEN** a package is added to `PACKAGE_DIRS` in `scripts/publish-release-packages.mjs`
- **THEN** its default vitest config is included in the guarded set without editing the guard

### Requirement: Zero-test guard loads the real config module

The zero-test guard SHALL determine each config's `passWithNoTests` value by dynamically importing the same config module `vitest run` loads, not by parsing its source text, and SHALL run under `pnpm test:scripts` in CI on every PR.

#### Scenario: Computed config value

- **WHEN** a vitest config computes `passWithNoTests` from an expression that evaluates to `true`
- **THEN** the guard detects it as `true` and fails

### Requirement: CLI parallel and serial suites partition the test files

The `apps/cli` default (parallel) and serial (daemon-spawn) vitest suites MUST together partition the package's git-tracked test files with no overlap and no gaps, as resolved by real `vitest list` against both configs.

#### Scenario: Test file in both suites

- **WHEN** a test file is matched by both `apps/cli/vitest.config.ts` and `apps/cli/vitest.serial.config.ts`
- **THEN** `pnpm test:scripts` fails, reporting the overlap

#### Scenario: Test file in neither suite

- **WHEN** a git-tracked `apps/cli` test file is matched by neither config
- **THEN** `pnpm test:scripts` fails, reporting the gap

### Requirement: Tests use structural assertions on spec-defined fields

Tests for event shape, hook state, and projection rules MUST assert on the specific fields the spec defines rather than on a serialized whole, and expected values MUST be hand-authored from the spec, not captured from current output.

#### Scenario: Asserting an event

- **WHEN** a test verifies a materialized event
- **THEN** it asserts individual spec-defined fields (e.g. `monitorId`, `objectKey`, `urgency`) with values written from the spec

### Requirement: Snapshot-only approval is insufficient

A test MUST NOT rely solely on snapshot or gold-master comparison of captured output to guard a runtime rule, because such a test cannot detect a regression in the rule it is meant to guard.

#### Scenario: Snapshot without structural assertions

- **WHEN** a test's only assertion is `toMatchSnapshot()` of runtime output
- **THEN** it does not count as coverage for the runtime rule

### Requirement: Intentionally preserved limits are asserted directly

When a limit is intentionally preserved as current behavior, a test MUST assert that limit directly.

#### Scenario: Coalesced claim returns null

- **GIVEN** a normal-urgency delivery has been claimed and not acknowledged
- **WHEN** a second `claimDelivery` runs for the same session
- **THEN** the test asserts it returns `null`

### Requirement: Timing-dependent tests use fake timers

Tests that depend on timing (settle windows, debounce) MUST use fake timers (`vi.useFakeTimers()` / `vi.setSystemTime()`) instead of real `setTimeout` waits. Integration tests that must exercise real process boundaries are exempt, and SHOULD use the shortest feasible polling intervals and document why fake timers cannot be used.

#### Scenario: Debounce settle test

- **WHEN** a test verifies that high urgency waits for its 15s settle window
- **THEN** it advances a fake clock past the window rather than sleeping 15 seconds

#### Scenario: Real daemon process test

- **WHEN** a test spawns a real daemon process and cannot use fake timers
- **THEN** it uses the shortest feasible poll interval and documents why fake timers cannot be used
