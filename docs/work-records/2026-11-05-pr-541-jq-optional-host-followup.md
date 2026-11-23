# PR 541 optional-jq outer-host follow-up

Start: clean `d6bedc61ed86df45482a33f617a6ba9d5a7235fd`. This repair restores the
existing optional-local-jq contract; it does not change the specification's intent,
aggregate sequence, mandatory-job scheduling guard, fixture repairs, audit exclusion,
source behavior, or dependencies. t137 was notified before HEAD changed.

## Failure and repair

The positive control inherited the outer host PATH unconditionally. With a private
Node-only outer PATH and CI unset, the real script suite produced two passes and one
failure, contradicting the documented optional local facility. The new durable
outer-host regression failed before the repair, while its CI-missing control passed.

Only the positive control now skips when the outer host lacks jq locally. The two
missing-facility controls still execute. CI presence is preserved for the positive
control, so a CI host without jq still fails. A real jq host executes actual preset
reductions rather than faking a positive result.

The outer regression selects only the positive control in the child file; it never
selects its own suite, preventing recursion. Its child bound is 25 seconds under a
30-second test deadline; nested real preset children are bounded at 20 seconds under
their existing 30-second test deadlines. The shared test driver uses async spawn's
private process groups, killing surviving workers on exit before awaiting pipe closure.
A focused case confirms a one-second child timeout also removes its worker that inherits
the parent's pipes. Temp directories are removed in finally. No existing test timeout,
retry, CI meaning, or product/source policy was broadened.

## Evidence

- Before repair: actual jq-free outer local host exited 1, two passed / one failed.
- After repair: outer local host exited 0, two passed / one skipped; outer CI host
  without jq exited 1; real jq host exited 0, all three controls passed.
- A copied-source reversion to unconditional positive-control execution makes precisely
  the new outer-local regression fail again (one failed test, exit 1).
- Focused parity/facility/outer-host suites and the owned-worker cleanup control passed.
- Strict TypeScript/JavaScript compilation with `--allowJs --checkJs` and focused ESLint
  passed after correcting an intermediate invalid synchronous-spawn option.

Final gates: uncached build/check/API-report validation passed; the complete script
suite passed 374 tests across 16 files, and the unchanged real preset suite passed all
80 tests. Lint reported 527 existing warnings and zero errors. Formatting and diff checks
passed. The final focused gate/facility coverage totals 42 tests including cleanup.

Host harness: `/tmp/541-optional-host-proof.mjs`; red and green results:
`/tmp/541-outer-host-{red,green}.log`. Narrow reversion evidence is retained under
`541-host-mutant-final-*` in the OS temporary directory. Gate log:
`/tmp/541-jq-host-gates-final.log`.

No reviews, review requests, thread writes, PR merge, subagents, or other branches were
used. No full `pnpm verify` success is claimed. Full package/serial suites, Docker,
standalone consumer, fresh-install E2E, publish dry-run, live advisory audit, Windows,
website build/link/examples, and new-head CI completion were not verified here.
