# PR 541 Linux zombie fixture follow-up

Starting checkout: clean `1f6ba5b07f856a8d1c7cf3744faf681ca6a0e408`.
Read current cloud finding 4488800624 without writing review threads. t137 was notified
before HEAD changed. The existing jq optional-local/required-CI behavior, process-group
cleanup, deadlines, CI parity/prerequisite guards, and audit boundary are unchanged.

## Red proof and narrow repair

An owned `node:24-bookworm` container ran Node as PID 1, without `--init`, with the exact
current `runJqTestChild` and worker fixture. The original kill-zero predicate failed:
helper status was null, helper error absent, pipes closed, worker PID 21 was `Z (zombie)`
with `kill(pid, 0)` still succeeding. The probe assertion exited 1. This reproduces the
fixture's Linux failure without claiming a full containerized Vitest run.

The fixture now calls a test-only liveness utility. ESRCH proves termination on all
hosts. On Linux, an existing PID is accepted only when `/proc/<pid>/status` proves
zombie/dead state (`Z`, `X`, or `x`). Running, sleeping, and stopped states fail the
termination check. Signal permission errors, unreadable proc data, and malformed state
remain errors. A missing proc file is accepted only after a fresh signal probe confirms
ESRCH. The utility uses Node APIs, without proc tools or jq on PATH. The helper itself
and its 20s/25s child bounds and 30s enclosing test deadlines have no diff.

Twelve focused regressions cover terminated/live states, ESRCH, permission/read errors,
malformed evidence, and disappearance between probes. Six initially failed against the
old kill-zero predicate. The actual Linux probe now passes with the same unreaped zombie;
its positive live-worker control still rejects termination.

A narrow copied-helper mutation replaces only group SIGKILL with a signal-zero probe.
The same Linux fixture then fails to close inherited pipes, and inspection confirms a
surviving worker in sleeping state `S`. The bounded outer driver detects the failure;
its owned container and Docker CLI are cleaned up in finally. Normal red/green owned
containers were also removed. No helper behavior was weakened to appease the fixture.

## Validation and limits

- Focused guard/jq/outer-host/liveness cases passed; liveness suite: 12 tests.
- Repository `pnpm check` passed (527 existing warnings, zero errors).
- Final `pnpm test:scripts`: 17 files, 386 tests passed.
- Strict TypeScript/JavaScript compilation of changed tests/utilities and focused ESLint
  passed; formatting and diff checks passed.
- Actual no-init Linux fixture red/green and live control passed their expected outcomes.
- Narrow worker-cleanup removal was detected, with owned-container cleanup verified.

Logs/harnesses: `/tmp/541-linux-zombie-{red,green}.log`,
`/tmp/541-zombie-{unit-red,mutation,gates,scripts-final}.log`,
`/tmp/541-linux-zombie-probe.mjs`, `/tmp/541-run-linux-zombie.py`, and
`/tmp/541-zombie-mutation.py`.

Not run: full `pnpm verify`, full package/serial suites, the repository Docker smoke,
consumer/fresh-install/publish workloads, API-report regeneration/validation, live advisory
audit, Windows/site checks, full Linux container Vitest suite, or successor CI completion.
The targeted Docker probe is evidence for this fixture, not the product's Docker gate.
No dependencies, lockfiles, public APIs, or product contracts changed. No reviews, thread
mutations, subagents, or PR merge were performed.
