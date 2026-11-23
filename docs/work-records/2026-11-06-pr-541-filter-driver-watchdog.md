# PR 541 negative filter driver scope

Start: clean local/index/live fa916582e625c4e39d66bf5450d1a45fa4c52311.
Read the full root watchdog brief, exact failed log/readback for CI 42220094347 and
current stdin work record. Main Check And Test succeeds and the prior discovery EPIPE
is gone; the collateral job fails one negative filter fixture at its 4-second watchdog
while 421 tests pass. No CI retry or fresh review was requested.

## Tests first and phase diagnosis

The negative filter driver selects the whole actual canonical test file. It therefore
runs both PR-review and my-prs hanging reductions, each with its own 1,000ms command
budget, plus Vitest startup/transform/teardown inside the single 4-second watchdog.
The archived CI log did not include child phases, so its exact inner phase at watchdog
expiry cannot be recovered from that log alone.

Before fixing selection, the fixture gained an outcome assertion requiring exactly one
registered negative command and failure diagnostics containing child output, phase
PID/timestamps and elapsed driver time. This fails on the existing harness: two actual
filter invocations report their own deadline errors around 1,007ms and 1,003ms; driver
return is around 2,857ms. `/tmp/541-filter-driver-red.log`. This demonstrates duplicate
negative work rather than an observed failure of either jq command's deadline.

A copied-source real-process proof adds 1,500ms of controlled overhead only to actual
Vitest main-process startup. The private jq executable and worker receive no such delay;
all command/driver/test budgets remain unchanged. With the old selection, the driver
hits its 4-second watchdog at 4,003ms after starting both filters: the first is terminal
and the second still live before finally force-cleans its exact owned group.
`/tmp/541-filter-driver-overhead-old.log`.

With identical overhead and only the intended negative selection repaired, the driver
returns status 1 with a visible deadline error around 3,353ms. Exactly one filter runs,
and it is terminal before fixture cleanup. `/tmp/541-filter-driver-overhead-repaired.log`.
All recorded phase PIDs were verified gone afterward. Proof driver:
`/tmp/541-filter-driver-overhead.py`; retained copy path:
`/tmp/541-filter-driver-proof-path`. This is a controlled reproduction of the verified
harness scope/timing issue, not a claim to have reproduced the CI runner's exact load
or repaired a query/runtime hang.

## Narrow change and independent control

The negative filter case now selects the actual PR-review canonical test by its precise
name. Both positive canonical reductions remain unchanged and execute in their normal
suite. The fixture asserts one registered negative command, visible deadline failure
before external cleanup, and terminal owned workers at that point. Failure diagnostics
now retain output and phase timing; a slow startup reports that no jq phase began.
The 1,000ms jq budget, 4-second driver watchdog and 6-second enclosing test timeout are
unchanged. No retry, optional negative control or broader process scope was added.

A separate copied-source mutation removes only the new selector. Without controlled
overhead, the one-command outcome assertion fails with two PIDs. Restoring the selector
in that same copy passes. `/tmp/541-filter-driver-mutant.log`,
`/tmp/541-filter-driver-restored.log`; copy path:
`/tmp/541-filter-driver-mutant-path`. Normal focused execution passes all three negative
phases, with the filter driver around 1,796ms. `/tmp/541-filter-driver-green.log`.

## Current-tree verification

- Full scripts: 24 files / 422 tests PASS, including prior 40+, jq transport/query/proc,
  held readers, late callbacks and direct-child deadline controls.
  `/tmp/541-filter-driver-scripts.log`.
- Unchanged real CLI preset integration: 80 tests PASS.
  `/tmp/541-filter-driver-integration.log`.
- Linux Node24.14.0 arm64 / real jq 1.6: all actual positive coverage/canonical modules,
  six stdin transport cases and all three negative phases PASS: 4 files / 14 tests,
  zero skips. Both positive canonical reductions run. The repository is mounted
  read-only; real jq and pinned native loader binaries exist only in the disposable
  container. No live Node drivers remain after the proof; the exact owned container
  is removed. `/tmp/541-filter-driver-linux-current.log`,
  `/tmp/541-filter-driver-linux-current.json`,
  `/tmp/541-filter-driver-linux-cleanup.log`.
- Invalid and valid-but-wrong canonical reducer mutations still fail their selected
  real-jq controls; restoring copied canonical source passes both positive reductions.
  `/tmp/541-filter-driver-canonical-invalid.log`,
  `/tmp/541-filter-driver-canonical-wrong.log`,
  `/tmp/541-filter-driver-canonical-restored.log`.
- Prior 400ms controlled no-exit proof returns a visible error around 402ms before
  forced cleanup, preserving diagnostics. `/tmp/541-filter-driver-direct-exit.log`.
- Linux Node24 PID1/no-init: 20 owned scopes, zero nonterminal workers at helper return;
  owned workers and the separate no-network container cleaned up.
  `/tmp/541-filter-driver-linux20.log`. This is not product Docker acceptance.
- Repository check: 527 existing warnings / zero errors. Strict TS/JS compilation,
  focused lint, formatting and diff checks PASS. `/tmp/541-filter-driver-check.log`,
  `/tmp/541-filter-driver-types.log`, `/tmp/541-filter-driver-lint.log`.

Only the negative fixture and its spec/work-record clarification change. The jq runner,
query/child helpers, both canonical positive controls, production 470/472 boundaries,
public API, dependencies, aggregates and workflows remain unchanged. Accepted option B,
local missing-jq skip/CI absence failure, authored outputs and normal diagnostic-drain
uncertainty remain intact.

Not run: full verify, complete package/serial suites, product Docker smoke, consumer,
fresh-install/publish workloads, API-report validation, live audit, Windows/site checks,
or successor GitHub CI completion. Targeted Linux proof is not all-platform or successor
CI acceptance. Root owns successor reviews, CI and acceptance. No agents, reviews/review
requests, remote-thread writes or merge; normal Mike author/committer hooks, verified
file/tree bytes and ordinary append push/readback are used for delivery.
