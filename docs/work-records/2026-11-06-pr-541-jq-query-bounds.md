# PR 541 jq execution and owned-query bounds

Start: clean local/index/live d354b5e4ebfee271f4888ecd24d9a9b92befc1c6.
Read the entire root jq/query follow-up brief, attack report and linked provider,
query, jq-hang and proc-guard proofs/results/logs. No production sources were changed
by those proofs or this follow-up. Accepted option B remains direct real jq running
canonical template programs against authored raw fixtures, with unchanged package
integration. Production 470/472 boundaries, all existing budgets, and the normal
diagnostic-drain uncertainty remain intact.

## Tests-first evidence

- New `jq-command-bounds.test.ts` runs the actual coverage/direct Vitest modules in
  private driver groups. A private negative executable ignores SIGTERM; the filter
  case returns from its version probe first. All three original module/probe/filter
  paths were still blocked at the 4-second watchdog before fixture force-cleanup.
  `/tmp/541-jq-query-red.log`. This negative executable is not a positive jq substitute.
- New `owned-query-handle.test.ts` uses an actual execFile ChildProcess with only its
  exact SIGKILL/9 request controlled to succeed without exit. Before repair, the
  200ms confirmation returned a deadline error while the actual child handle remained
  referenced. Natural live-to-terminal results, malformed output and query-failure
  diagnostics passed independently. `/tmp/541-query-handle-red.log`.
- The disappearing-proc regression now starts with a live fake-clock budget, reaches
  a listed entry's ENOENT and the fresh still-present group-zero probe, and asserts
  those calls before advancing time to expiry. A narrow false-success mutation fails
  this test; the original expired-at-entry regression could not catch it. An additional
  positive case confirms that fresh ESRCH after ENOENT permits success.

The real-query adapter preserves Node's promisified stdout/stderr shape when exercising
its predecessor implementation; an initial adapter-shape error was corrected before
accepting the isolated ref-lifetime red. The scoped successful-signal/no-exit model is
not an actual wedged ps or kernel D-state experiment.

## Repair and boundaries

`run-jq-command.mjs` is a private facility helper for the owned direct jq executable.
It supplies a nonblocking total verdict for both version probes and canonical filters
within the existing 1,000ms per-command budget. On failure/expiry it signals only that
exact child, destroys its streams, unreferences its handle and retains eventual callback
handling. Only actual ENOENT allows optional omission; hangs, invalid programs and
other command failures remain visible. Successful controls still use real host jq.

The Darwin membership query now retains its separate direct child handle. Its
failure/abort path releases stdin/readers and the process reference, with best-effort
SIGKILL and handled late callbacks. Existing absolute-budget checks still reject late
results before accepting terminal evidence or starting another scan. Handle release
is not a claim that cancellation terminated the query. Linux membership, zombie,
permission, malformed/missing-member and absolute-query rules remain distinct.

No arbitrary process supervisor, source observation mode, public API, dependency,
aggregate, workflow, timeout or cleanup-reservation expansion was added. The canonical
presets, authored expected reductions and unchanged real package integration remain.

## Independent controls and final checks

Retained independent directory: the path is recorded in
`/tmp/541-jq-query-independent-path`; summary/log stream:
`/tmp/541-jq-query-independent.log`. All mutations operate on copied sources only:

- Restoring only the two actual jq call-site files to their synchronous predecessor
  makes all three new module regressions fail at their watchdogs.
- Removing only the query handle's `unref()` makes the selected real-handle assertion
  fail; cancellation, deadline error and reader release remain in place.
- Changing only the final no-readable-members false verdict to true makes the selected
  disappearing-proc regression fail with success instead of deadline rejection.
- Fresh restored copies pass query, proc and actual jq regressions. Mutating only the
  canonical PR-review reducer to invalid jq and then valid-but-wrong `[]` makes the
  corresponding real-jq controls fail. Restoring the canonical reducer passes.

The exact copied root query proof, with only the provider import changed, returns its
200ms deadline error at about 203ms while the actual query is still present and its
handle is unreferenced. All owned streams are destroyed before fixture cleanup. That
standalone fixture explicitly refs its child only inside finally to await close after
force-cleanup; without that cleanup-only ref Node correctly has no referenced process
handle to keep its top-level cleanup await running. The earlier fixture query was also
verified gone. The controlled query is force-cleaned by exact PID, never a shared group.

The prior 400ms non-exiting direct-child proof still returns a visible error at about
402ms before forced cleanup, retaining the diagnostic while no exit has occurred.
`/tmp/541-jq-query-direct-exit-proof.log`. Prior reader-rejection, held-pipe, pending/late
query, nested/minimal-env and worker-state controls remain in the script suite.
Linux Node24 PID1/no-init again has zero nonterminal workers at helper return in 20
owned scopes; the no-network container and owned processes were cleaned up.
`/tmp/541-jq-query-linux.log`. This is not product Docker acceptance.

Final gates: 23 script files / 416 tests pass, including all prior 40 focused cases;
unchanged CLI preset integration has 80 passing tests. Repository check passes with
527 existing warnings and zero errors. Strict TS/JS compilation uses the installed CLI
Node type root and existing core ambient jq declaration, with repository library-check
policy. Focused ESLint, formatting and diff checks pass. Normal hooks and exact
verified-file/committed-tree equality are checked at delivery.

Logs: `/tmp/541-jq-query-scripts.log`, `/tmp/541-jq-query-integration.log`,
`/tmp/541-jq-query-check.log`, `/tmp/541-jq-query-types.log`,
`/tmp/541-jq-query-lint.log`. An initial standalone compiler invocation omitted the
existing ambient declaration and caught a readonly test-adapter assignment; both were
corrected without dependency or production-type changes.

Not run: full verify, complete package/serial suites, product Docker smoke, consumer,
fresh-install/publish workloads, API-report validation, live audit, Windows/site checks,
or successor CI completion. Normal diagnostic-drain remains unconfirmed. No agents,
reviews/review requests, remote-thread writes or merge; root owns successor review,
CI and acceptance. Delivery uses normal Mike author/committer hooks and append push.
