## Why

The reliability claims are only as credible as the gate that verifies them. Today the local
verification gate does not match CI, at least one test exhausts its full retry budget on every run
(a masked flake), nondeterministic CI failures get re-rolled instead of owned, and some CI-only
failures cannot be root-caused from their artifacts. Refs #452, Refs #458, Refs #475, Refs #477,
Refs #509 (milestone M3; gate expectations from #504; #506 is the fixed exemplar).

Source: 008 §10, §12 (row "The verification gate is trustworthy (parity, no masked flakes)").

## What Changes

- Local gate ≡ CI gate: what the workspace verification scripts run locally matches what CI
  enforces; a suite that runs only in CI or only locally is drift (#458).
- No masked flakes: retry budgets absorb the environment, never hide defects; a test that consumes
  its full retry budget on every run is a defect (#452); a nondeterministic failure on an unrelated
  diff is a tracked defect with an owner, never re-rolled as routine (#509, #475, #477).
- Failures are diagnosable from artifacts: a CI-only failure captures enough state (spawned
  daemon/subprocess logs) to be root-caused without re-running (#509).
- Executable checks: gate parity, retry-disabled runs, teardown restoration of mutated global state,
  and forced-failure diagnostic dumps.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `engineering/test-integrity`: adds the verification-gate trust commitments. 008 §10 states them as
  part of the reliability posture, but they are obligations on the repo's test suite and gate, so
  they live beside the existing test-integrity requirements (004 §2.5–§2.8, §4).

## Impact

- Code/config: root `package.json` scripts, `nx.json` targets, `.github/workflows/*`, vitest retry
  configuration, test harness teardown (`plugins/source-command-poll` tests for #477), Docker smoke
  harness (#509).
- Principles: PP7 (per `principles`).
- Contradictions resolved: none.
- No published package behavior changes; no changeset or api-report needed unless a fix touches
  published code.
