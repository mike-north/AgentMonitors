# PR 541 final parity repairs

Starting checkout: clean `0c383f697012af3d5fc01f048e6487890f28e1a1`.
The operator's four confirmed findings were handled narrowly. t76 was notified before
editing the shared preset test's jq registration block; its branch was not edited.
t137 was notified before the repair commit changed HEAD. No reviews, review requests,
thread writes, PR merge, subagents, or dependency changes were performed.

## Repairs and red evidence

- Four command/action/step-condition/error-propagation fixtures now preserve the valid
  job metadata. An isolated runner-only guard fails all four; the intact guard passes.
  Separate command, action, `if`, and `continue-on-error` bypasses each fail the intended
  regression, independently of the runner assertion.
- A new prerequisite regression failed before the fix. The mandatory test job now rejects
  unreviewed `needs`, since a skipped website prerequisite could otherwise skip it.
  Removing only this check makes the new test fail; the ordinary root control still passes.
  The publish dry-run condition and website exclusion are unchanged.
- Actual Vitest child-process controls use a private Node-only PATH to prove jq absence.
  Before the fix, local absence registered one passing no-op and failed the new control.
  Local absence now reports omitted jq reductions as skipped; CI absence still fails with
  the jq diagnostic; real installed jq runs the actual reductions. Only jq registration
  changed in the existing preset test, with no source/runtime semantics changed.
- The independent live dependency audit is documented and guarded as a separate security
  cadence, invoked with `pnpm check:dependency-audit`. Tests pin its known command and
  reject missing/new commands or unfamiliar execution context. Three mutation assertions
  failed against a no-op exclusion validator before implementing it. The audit workflow,
  triggers, cadence, and guarantee are unchanged. Audit fixtures/version floors in the
  script suite are explicitly distinguished from the live advisory query.

Isolated narrow guard reversions were performed in temporary copies, never on the
tracked workflow. Harness: `/tmp/541-final-mutants.py`; results:
`/tmp/541-final-mutants.log`. It prints the retained per-case JSON/log directory.
The execution-context guard and semantic job-order control remain intact.

## Validation and limits

- Focused local-gate and jq-control suites: 39 tests passed.
- Full edited preset test file: 80 tests passed with real jq installed.
- Uncached build, check, and API-report gates: passed with `NX_DAEMON=false` and
  `NX_SKIP_NX_CACHE=true`; lint reported 527 existing warnings, zero errors.
- Full script suite: 15 files, 371 tests passed.
- Direct strict TypeScript compile of both script test files: passed.
- Formatting and diff checks: passed.

Logs: `/tmp/541-final-{needs-red,jq-red,audit-red,gates,presets,types}.log`.
All subprocesses finished, and the facility-test temporary directories are removed in
`finally`. No daemon, server, or container was started. The aggregate sequence and fast
suite workload are unchanged; the fast-path notice now discloses jq-dependent skips.
The independent audit workflow and dependencies have no diff.

Not run for these repairs: full `pnpm verify`, complete package/serial suites, Docker,
standalone consumer, fresh-install hooks E2E, publish dry-run, live advisory audit,
Windows, website build/link/example checks, or new-head CI completion. No full-gate
success is claimed. These results verify the listed repairs and local gate checks.
