# PR 541 confirmation failure and deadline follow-up

Start: clean local/index/live head b4e360ecb39cfa65fd2a7c6ecef8709c13a400fb.
Read both root failure probes. t137 was notified before HEAD changed. Accepted option B,
real shipped jq controls, unchanged package integration, source 470/472 boundaries, and
existing timeout budgets remain intact. No normal diagnostic-drain repair was attempted.

## Tests-first evidence and repairs

The actual held-pipe regression suppresses SIGKILL only for the exact registered owned
group, and injects a confirmation rejection at its original 400ms deadline. The real
worker retains both pipes. Before repair the result stayed blocked until the fixture's
finally force-cleaned its group; the regression failed. Asynchronous rejection now uses
the same failure handler as synchronous signal failure: capture the error and release
both readers. The error result returns before forced cleanup, preserving captured direct
child stdout/stderr. The worker is deliberately still live in this controlled model;
reader release is not evidence it was forcibly stopped. This is not an actual D-state
kernel experiment. The exact copied root proof returned around 403ms before forced
cleanup, versus the old 650ms blocked observation.

Deterministic clock/proc regressions established late-success and sequential-scan bugs:
a query starting at 1000 with deadline 1010 received terminal data at 1020 and previously
resolved successfully. It now fails its budget. Checks occur before/after asynchronous
queries, between proc reads, and before accepting final success. Expired queries do not
begin, and a pending query yields a deadline verdict without starting later proc reads.

The existing deadline now races the query verdict and aborts supported operations
best-effort. Pending kernel I/O is not claimed synchronously interrupted; continuations
check the aborted/expired budget before further work. Timers are cleared. Existing
ESRCH/zombie/live, permission, malformed and missing-member distinctions remain. The
helper also confirms ESRCH within budget and rejects late error-free completion. Bounds
and cleanup reservation are unchanged; confirmation errors remain visible.

## Independent controls and results

- Initial actual-pipe and late/expired/scan tests failed before implementation. The
  pending-query regression also failed before adding the bounded verdict race.
- Three copied-source narrow reversions independently fail exactly their selected
  regressions: async reader release, absolute late-success checks, and pending-query
  verdict race. The race mutation handles its unused timeout rejection so no unrelated
  unhandled rejection is needed to produce the failure.
- Exact copied repaired runner/provider and deterministic proc probes passed their
  expected failure-result assertions. Retained proof directory: OS temp prefix
  `541-confirmation-green-proofs-*`; narrow mutations: `541-confirmation-final-mutants-*`.
- Focused failure/deadline suites: 12 tests passed.
- Final repository check passed: 527 existing lint warnings, zero errors.
- Full script suite: 21 files, 403 tests passed.
- Unchanged real CLI preset integration suite: 80 tests passed.
- Strict TS/JS compilation (repository library-check policy), focused ESLint, formatting
  and diff checks passed.
- Linux Node24 PID1/no-init probe retained zero nonterminal workers at helper return in
  20 scopes. Owned workers/groups and container were cleaned up.

Logs: /tmp/541-failure-deadline-red.log, /tmp/541-pending-query-red.log,
/tmp/541-confirmation-followup-gates.log, /tmp/541-confirmation-linux-final.log.
Only test drivers/tests, specification clarification and this work record changed.
No source, dependency, API, aggregate or workflow changes; no reviews, review requests,
thread mutations, subagents, or PR merge. Normal diagnostic-drain candidate remains
unconfirmed, not declared disproved by finite positive probes.

Not run: full verify, complete package/serial suites, product Docker smoke, consumer,
fresh-install/publish workloads, API-report validation, live audit, Windows/site checks,
or successor CI completion. Targeted Linux probes are not product Docker acceptance.
