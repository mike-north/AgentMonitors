# PR 541 fixture scheduling and startup allowance

Start: clean local/index/live 54c7503297a386ed069c50c634e6640020ddfbd1.
Read the entire root scheduling brief, current version-driver record, exact CI
42231914563 failed log and run readback. Main succeeds; collateral fails one negative
version fixture while 422 tests pass. Unlike b5's diagnostic, this failure has no
complete report or inner deadline output: only RUN, elapsed 4,000ms and version PID 3858. Its command verdict, terminal state and exact internal delay are unknown from
that log. No same-cause assumption, blind rerun or flake classification was used.

Root explicitly superseded the private fixture's former absolute 4-second assumption,
authorizing evidence-based scheduling/startup changes while retaining strict command,
query, ownership, complete-phase and cleanup requirements. Production code is unchanged.

## Actual scheduling and tests-first behavior

The script config allowed default parallel files and CPU-derived worker counts. At
least the coverage, optional-host and negative-command files launch nested Vitest;
other files launch package-manager processes. Installed Vitest 4.0.18 defaults to
parallel files and available CPUs minus one worker, while fileParallelism false forces
one worker even when more are requested. This creates nested resource contention.

The new scheduling regression inherits the actual script config, requests two workers,
and executes two real fixture files contending for one exclusive capacity lease.
Parallel execution produces real EEXIST overlap and fails. It does not inspect or
mirror a config field. The fixture's initial directory-cleanup mistake was corrected
before accepting the isolated overlap red. `/tmp/541-scheduling-red.log`.

The script suite now sets fileParallelism false. The same behavior test passes with
acquire/release/acquire/release and both files executed. Removing only serial scheduling
in a copied config reproduces overlap; restoring it passes.
`/tmp/541-scheduling-green.log`, `/tmp/541-scheduling-policy-mutant.log`,
`/tmp/541-scheduling-policy-restored.log`; retained copy path:
`/tmp/541-scheduling-policy-control-path`.

This deliberately serializes the small private script suite, including its subprocess
fixtures. The host full suite takes about 25 seconds; package pnpm test scheduling,
aggregate commands, workflow structure and the separate daemon serial suite are unchanged.

## Instrumented Linux comparison

An owned read-only-repository Linux arm64 / Node24.14.0 / real jq 1.6 container uses
CPU affinity 0–3, a fixed quota of two CPUs and then one CPU, and three explicitly
requested outer workers. Node's availableParallelism is quota-aware: two then one.
This is a bounded contention model, not the CI runner's exact hardware/Node version.
Only copied-source observations record driver launch, actual helper command entry/
verdict, complete-report receipt and cleanup; no result or deadline is substituted.

The two-CPU parent run passes the 11 targeted cases. The one-CPU parent also passes,
but its version fixture reaches the cliff: 2,963ms before command entry, verdict at
1,001ms after entry, report at 3,974ms and cleanup at 3,994ms. The command is behaving
as a one-second command while framework work consumes the surrounding allowance.
`/tmp/541-scheduling-parent.log`, `/tmp/541-scheduling-parent-lowquota.log`,
corresponding .jsonl traces; driver `/tmp/541-scheduling-profile.py`.

Changing ONLY scheduling, with the same quota/requested workers and the copied fixture
still using its OLD 4-second bound, reduces that version fixture to 1,030ms before
entry, a 1,006ms verdict, report at 2,060ms and cleanup at 2,065ms.
`/tmp/541-scheduling-serial.log`, `/tmp/541-scheduling-serial.jsonl`.
This separates the scheduling improvement from any larger startup allowance. It does
not claim to have reproduced the exact original CI inner failure.

## Explicit startup/command partition

A separate controlled real-process proof gives only Vitest main-process startup a
three-second delay, modeled on the measured roughly three-second pre-command interval.
It does not delay jq or change its timer. The parent rejects at 4,001ms with no report;
its jq has entered but its one-second budget has not yet elapsed. This is a faithful
startup-bound false-failure reproduction, not the earlier completed-report/close case.
`/tmp/541-scheduling-startup-parent.log` and .jsonl.

The private fixture now explicitly allows 4 seconds for framework launch/import/report
work PLUS its single independently strict 1,000ms negative command: a 5-second complete
phase. Cleanup remains separately hard-bounded at 1 second; the outer test is 7 seconds,
including one second of harness margin. The jq command and child/query helper budgets
are unchanged. This is one documented partition decision, not an iterative raise until
CI happens to pass. Complete intended-run, exact selection, one-command and terminal
worker proof remain required before cleanup signals.

Under the same controlled startup, the repaired report arrives at about 4,688ms, with
jq's actual verdict at 1,001ms after entry and its worker terminal before force-cleanup.
Restoring ONLY the old combined-budget partition fails again; restoring the new one
passes. `/tmp/541-scheduling-startup-repaired.log`,
`/tmp/541-scheduling-startup-defect.log`, `/tmp/541-scheduling-startup-restored.log`,
and corresponding command .jsonl traces. Driver:
`/tmp/541-scheduling-startup-proof.py`; copy path:
`/tmp/541-scheduling-startup-proof-path`. Diagnostics also record the driver's absolute
start timestamp and allowance so future startup/entry/report gaps can be distinguished.

## Preserved independent negative controls

- Old synchronous jq calls still fail all three actual negative phases; restoring
  bad natural-close acceptance still fails under controlled reporter latency; removing
  the selector still fails the whole-phase/one-command contract; a denied live-driver
  cleanup still fails. Restored normal and reporter-latency cases pass.
  `/tmp/541-scheduling-preserved-controls.log`; copies in the path recorded by
  `/tmp/541-scheduling-controls-path`.
- A first-test publisher with another selected filter pending is rejected by the
  pending-phase assertion. Restoring the actual whole-run reporter and intended
  selector passes. A snapshot after the sole selected case may already be semantically
  complete; that was not used as negative evidence. The accepted partial control
  genuinely contains another pending test, rather than relying on a callback's name.
  `/tmp/541-scheduling-partial-report.log`, `/tmp/541-scheduling-partial-restored.log`.
- The exact-clock real-executable 1,000ms test remains independent of fixture timing.
  A constant-only 2,000ms command-budget mutation fails; restoring 1,000 passes.
  `/tmp/541-scheduling-budget-mutant.log`, `/tmp/541-scheduling-budget-restored.log`.
- Real-jq invalid and valid-but-wrong canonical reducer mutations fail, and restoring
  copied canonical source passes both positive reductions.
  `/tmp/541-scheduling-canonical-invalid.log`, `/tmp/541-scheduling-canonical-wrong.log`,
  `/tmp/541-scheduling-canonical-restored.log`.

## Current-tree validation and cleanup

Full scripts: 25 files / 424 tests PASS, including all prior jq/query/proc/reader/
direct-no-exit/whole-phase/cleanup controls and the new behavioral scheduling guard.
Unchanged CLI preset integration: 80 tests PASS. Repository check: 527 existing warnings,
zero errors. Strict TS/JS compilation and focused fixture lint pass. Config is typechecked
and formatted; repository ESLint intentionally ignores config files.
`/tmp/541-scheduling-scripts.log`, `/tmp/541-scheduling-integration.log`,
`/tmp/541-scheduling-check.log`, `/tmp/541-scheduling-types.log`,
`/tmp/541-scheduling-lint.log`.

The uninstrumented current-tree Linux proof retains the SAME one-CPU quota and three
requested workers: six files / 19 tests PASS, zero skips, including both real positive
canonical programs, all negative phases, transport/budget, optional host and actual
scheduling cases. `/tmp/541-scheduling-linux-current.log`,
`/tmp/541-scheduling-linux-current.json`. No live Node drivers remained. The exact owned
container and its terminal unreaped children were removed; no shared groups were
signaled. `/tmp/541-scheduling-linux-cleanup.log`.

The 400ms controlled direct-no-exit proof still returns its visible error around 401ms
before forced cleanup, preserving diagnostics. Linux Node24 PID1/no-init still has zero
nonterminal workers at helper return in 20 owned scopes; owned processes/containers are
cleaned. `/tmp/541-scheduling-direct-exit.log`, `/tmp/541-scheduling-linux20.log`.
These targeted probes are not product Docker or all-platform acceptance.

No production source 470/472, helper/query execution contract, public API, dependency,
workflow or aggregate expansion. Accepted option B, real canonical positives/authored
outputs, explicit local absence skip and CI absence failure remain. Normal diagnostic
drain remains unconfirmed. No retry, blanket skip or ignored cleanup failure was added.

Not run: full verify, complete package/daemon serial suites, product Docker smoke,
consumer/fresh-install/publish workloads, API-report validation, live audit, Windows/site
checks, or successor GitHub CI completion. Root owns reviews, CI and acceptance. No
agents, review requests, remote-thread writes or merge. Delivery uses normal Mike author/
committer hooks, tested-file/tree verification and ordinary append push/readback.
