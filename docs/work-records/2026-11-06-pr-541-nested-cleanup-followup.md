# PR 541 nested helper ownership follow-up

Start: clean `379d94ad12e9218d6158dffb4c45c0e4c3b48513`. Read the current standard
review and the operator's exact-helper nested leak probe. t137 was notified before HEAD
changed. No reviews, review requests, thread mutations, subagents, or PR merge occurred.

## Failure and repair

The tests-first outer-timeout regression failed at the starting head: the nested worker
survived in a detached group after the outer timeout killed the owner of its inner timer.
The natural-exit control passed. Both fixtures record a live owned descendant before
checking termination, and their finally blocks clean the exact exposed worker even during
negative proofs. The test does not rely on the relative inner/outer timeout durations.

The outermost helper now owns one process-group boundary. An internal marker propagates
that boundary to children; nested helpers inherit the group instead of creating detached
escape groups. Ownership is read from the helper process's environment, not its next
child's environment, so replacing a child's environment with an empty mapping cannot revoke
ownership. That strengthened control initially failed the timeout case and passes now.

Only the outermost owner signals the group. Nested helpers never signal their shared
ancestor group. On direct child exit they release their pipe readers so descendants that
retain inherited pipes cannot prevent the owner from naturally completing. Nested results
report direct-child evidence; the outermost helper's completion establishes subtree cleanup.
The outer owner's timeout also terminates nested descendants if an inner timeout owner dies.
Existing 20s/25s child bounds and 30s parent deadlines are unchanged. No product/runtime/API,
jq facility policy, zombie-liveness policy, parity guard, or audit boundary was changed.

## Proof and gates

- New nested regressions: outer timeout and natural outer completion both pass. The nested
  helper receives a minimal child environment, proving ownership cannot be dropped that way.
- A narrow copied-source reversion of only `detached: ownsGroup` to unconditional detachment
  makes both regressions fail. The negative fixture cleans up its exposed workers.
- A real Node 24 Linux container, Node PID 1 without `--init`, passes both nested scenarios
  and their live controls. The previous exact zombie/live probe also still passes. All
  owned containers were removed. This is targeted fixture evidence, not a full Docker gate.
- Repository `pnpm check`: passed, with 527 existing lint warnings and zero errors.
- Final `pnpm test:scripts`: 18 files, 388 tests passed.
- Focused guard/jq/outer-host/liveness/nested tests passed; direct strict TS/JS compile,
  focused ESLint, formatting and diff checks passed.

Evidence: `/tmp/541-nested-red.log`, `/tmp/541-nested-minimal-env-red.log`,
`/tmp/541-nested-final-check.log`, `/tmp/541-nested-linux-final.log`,
`/tmp/541-nested-zombie-control.log`, and `/tmp/541-linux-nested-proof.mjs`.
Copied mutation results/logs are under `541-detach-mutant-final-*` in the OS temp directory.
An intermediate test cleanup lint error was corrected without hiding cleanup failures;
the final gate above supersedes that failed attempt.

Not run: full `pnpm verify`, full package/serial suites, product Docker smoke,
consumer/fresh-install/publish workloads, API-report validation, live advisory audit,
Windows/site checks, or successor CI completion. There is no full-gate claim. The source
helper changed only in test-driver ownership, with no dependency/lockfile/API changes.
