# PR 541 complete jq phase evidence and separate driver cleanup

Start: clean local/index/live b5b086571fd74fb3334a0383f64ac146130462b1.
Read the full root version-driver brief, exact CI 42222998954 failed log/readback and
current filter-watchdog work record. The main job fails one version-negative case,
421 tests pass, and collateral succeeds. Captured inner output already contains its
1,000ms jq deadline failure before the parent rejects natural driver close at 4,007ms.
That CI log does not prove whether PID 18248 was terminal or why the driver had not
closed. No retry, flake classification or fresh review was requested.

## Tests first: prove the outcome/close distinction

The fixture first gained a complete Vitest JSON end-of-run report and strict intended
module/test assertions while retaining its old natural-close acceptance. Installed
Vitest 4.0.18 source confirms JsonReporter writes the full module/test snapshot from
onTestRunEnd (dist/chunks/index.M8mOzt4Y.js, JsonReporter), rather than publishing on
the first individual failure. Both existing positive canonical controls remain intact.

A copied-source reporter delays only its onTestRunEnd completion for 5 seconds. Actual
jq/module work and all bounds stay unchanged. The old harness rejects at 4,004ms even
though the complete failed-module report exists, names the expected version phase and
its 1,000ms deadline error, and the sole registered jq is already terminal before any
fixture cleanup. `/tmp/541-version-driver-latency-old.log`,
`/tmp/541-version-driver-red.log`. The driver is an actual owned Vitest process;
this is a controlled reporter-latency model, not a claim about the CI runner's exact
internal delay. All owned processes are finally force-cleaned by their exclusive group.

Under identical latency, the repaired phase is established around 1,694ms with the
same complete report and terminal jq; driver cleanup completes around 1,785ms.
`/tmp/541-version-driver-latency-repaired.log`. Normal focused execution also passes
all three negative cases. `/tmp/541-version-driver-green.log`.

## Intended phase evidence and hard cleanup boundaries

The 4-second phase bound now covers receipt and validation of the complete end-of-run
report plus terminal state of the sole registered jq. A fresh partially written JSON
file is not accepted. Expired reads/validation cannot become success. The report must
identify exactly the requested actual module, its failure and deadline diagnostic.
Version discovery failure has zero registered tests. The filter report must contain
both collected canonical cases, exactly the intended PR-review failure, no positive
results and only the other filtered case skipped. The existing one-filter selector
and one-negative-command assertion remain. A first filter error or console text alone
cannot authorize success before another selected command runs.

Natural Vitest reporter/pool/process close is incidental to that command outcome.
After phase proof, finally signals only the exclusively owned detached driver group
and requires BOTH child close and independent group-terminal confirmation within a
separate hard 1-second cleanup reservation. This fits inside the unchanged 6-second
outer test: 4 seconds for the complete phase and at most 1 second for cleanup. This is
an explicit fixture boundary change from requiring natural driver close within 4s;
it does not increase the 1,000ms jq budget, the 4s phase bound or the 6s test timeout.
Resources are released on cleanup failure and late lifecycle errors remain handled.
Phase and cleanup failures are preserved together rather than one masking the other.

A normal Darwin coverage driver exposed a signal/close race: an owned-group snapshot
already showed no members while Node had not delivered close. A failed redundant
signal is not evidence either way. Cleanup accepts only independently confirmed close
AND terminal state; if confirmation fails, the original signal failure remains visible.
The actual permission rule was not weakened. A scoped negative control denies SIGKILL
for an actual live delayed driver and proves cleanup still fails with EPERM before the
fixture restores its real signal and cleans that exact group.

## Strict independent command budget and counterfactuals

The real-jq transport suite also proves the unchanged 1,000ms command verdict with a
deterministic clock. It runs the actual executable/lifecycle, withholds only its final
callback, verifies pending at 999ms and deadline failure at 1,000ms, then releases the
late callback without turning failure into success. Its imported-timer test seam uses
the same fake clock as Date; an initial global-only clock adapter was corrected before
accepting this control. `/tmp/541-version-driver-command-budget.log`.
Changing only JQ_COMMAND_TIMEOUT from 1,000 to 2,000 makes this selected test fail at
the exact-budget assertion; restoring it passes. `/tmp/541-version-driver-budget-mutant.log`,
`/tmp/541-version-driver-budget-restored.log`. Production command code is unchanged.

Independent copied-source controls all fail their intended assertions, and restored
normal/latency cases pass. `/tmp/541-version-driver-counterfactuals.log`; retained
control directory in `/tmp/541-version-driver-controls-path`:

- Restoring only the bad natural-close acceptance rejects the valid complete phase
  under controlled reporter latency with blocked instead of reported.
- Restoring old synchronous jq calls fails all three actual probe/filter negative
  phases because no complete run report can arrive inside their bound.
- Removing only the filter selector completes a two-failure report and fails the
  intended one-command/one-failure contract, rather than accepting the first failure.
- Denying only the live owned driver's cleanup group signal fails cleanup with EPERM;
  the control itself then restores the real signal and awaits owned group/child cleanup.

## Current-tree gates and scope

- Full scripts: 24 files / 423 tests PASS, including prior 40+, query/proc/reader/
  direct-no-exit controls, exact input-error behavior and the new strict budget test.
  `/tmp/541-version-driver-scripts.log`.
- Unchanged real CLI preset integration: 80 tests PASS.
  `/tmp/541-version-driver-integration.log`.
- Linux Node24.14.0 arm64 / actual jq 1.6: 4 files / 15 tests PASS, zero skips,
  including both positive canonical reductions, the seven transport/budget cases
  and all three actual negative phases. Repository mounted read-only; jq/native
  loader tools exist only in the disposable test container. No live Node drivers
  remain afterward and the exact owned container is removed.
  `/tmp/541-version-driver-final-linux-current.log`,
  `/tmp/541-version-driver-final-linux-current.json`,
  `/tmp/541-version-driver-final-linux-cleanup.log`.
- Real-jq invalid and valid-but-wrong canonical reducer mutations fail, and restored
  copied canonical source passes both positive reductions.
  `/tmp/541-version-driver-canonical-invalid.log`,
  `/tmp/541-version-driver-canonical-wrong.log`,
  `/tmp/541-version-driver-canonical-restored.log`.
- Prior controlled 400ms no-exit proof retains its visible deadline error/diagnostic
  before forced cleanup. Linux Node24 PID1/no-init retains zero nonterminal workers
  at helper return in all 20 owned scopes; owned workers/containers are cleaned.
  `/tmp/541-version-driver-direct-exit.log`, `/tmp/541-version-driver-linux20.log`.
  These are targeted probes, not product Docker acceptance.
- Repository check: 527 existing warnings / zero errors; strict TS/JS compilation,
  focused lint, formatting and diff checks PASS. `/tmp/541-version-driver-check.log`,
  `/tmp/541-version-driver-types.log`, `/tmp/541-version-driver-lint.log`.

Only validation fixtures/tests, spec clarification and this record change. Production
sources 470/472, jq/query/child helpers, public API, dependencies, aggregates, workflows,
accepted option B, real canonical positive controls and authored outputs remain intact.
Normal diagnostic-drain remains unconfirmed. No arbitrary supervisor, retries or
blanket skip/error suppression was added.

Not run: full verify, complete package/serial suites, product Docker smoke, consumer,
fresh-install/publish workloads, API-report validation, live audit, Windows/site checks,
or successor GitHub CI completion. Targeted Linux proof is not successor/all-platform
acceptance. Root owns reviews, CI and acceptance. No agents, reviews/review requests,
remote-thread writes or merge. Normal Mike author/committer hooks, exact tested-file/
committed-tree verification and ordinary append push/readback are used for delivery.
