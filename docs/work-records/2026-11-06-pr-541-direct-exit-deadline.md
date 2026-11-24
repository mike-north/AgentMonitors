# PR 541 total deadline across direct-child exit

Start: clean local/index/live head 51cf51ad3a2380bb238515bbb3bee1efd48d510c.
Read the root direct-exit faultcheck brief and all linked copied runner/provider/proof
files. This follow-up preserves accepted option B, direct shipped jq controls,
unchanged package integration, production source 470/472 boundaries and all existing
timeout budgets and cleanup reservations. It does not investigate normal diagnostic drain.

## Tests first and repair

Two real-process regressions failed before implementation: a direct child whose exact
SIGKILL request is controlled without exit, and an exited direct child whose worker
holds inherited pipes while confirmation remains pending. Both 400ms calls were still
blocked at the 650ms watchdog. Each fixture finally force-cleans only its registered
real process group and releases its confirmation gate. Numeric signal 9 and SIGKILL
are both recognized by the direct-child control. This is a scoped signal-failure model,
not an actual Linux D-state experiment.

The helper now races execution/exit, pipe closure and group confirmation against the
same existing absolute deadline. Expiry retains diagnostics and a visible error,
releases owned readers, attempts the owned group signal (nested helpers only their
direct child), and unreferences the child handle. Event/error listeners remain, and
late callbacks cannot revise the returned verdict. The known group is not falsely
declared terminated on an error return. Error-free return still requires timely
confirmation. The existing confirmation query deadline/abort handling remains intact.

The post-exit async rejection control now rejects 30ms before total expiry so it tests
that specific failure path independently of total-timer registration order. New natural
status 0/7 and spawn ENOENT controls preserve existing result semantics. The held-pipe
regression rejects confirmation after the deadline result to exercise handled late failure.

## Evidence

- Initial phase regressions: both fail on the deadline-before-cleanup assertion;
  `/tmp/541-direct-exit-red.log`.
- Focused completion/group suites: 17 tests pass; direct/no-exit and exited/held-pipe
  cases return around 403ms on the unchanged 400ms bound.
- Exact copied root proof with final repaired helper (only spawn-provider import changed)
  returns a visible deadline error at 403ms before forced cleanup, while the actual
  direct child is still present and no exit has occurred. The original direct diagnostic
  is retained. `/tmp/541-direct-exit-root-green.log`; copied proof directory recorded in
  `/tmp/541-direct-exit-proof-path`.
- Narrow copied-source mutation removes only the total verdict race, awaiting normal
  completion instead. The selected non-exiting-child regression alone fails at its
  watchdog without unrelated mock errors or unhandled rejection;
  `/tmp/541-direct-exit-mutant.log`, directory in `/tmp/541-direct-exit-mutant-path`.
- Full script suite: 21 files, 408 tests pass, including prior source-independent jq,
  minimal-env/nested cleanup, worker terminal-state, proc and deadline controls.
- Unchanged CLI preset integration suite: 80 tests pass.
- Repository check passes with 527 existing warnings and zero errors. Strict TS/JS
  compilation using installed CLI Node types and repository library-check policy,
  focused ESLint, formatting and diff checks pass.
- Linux Node24 PID1/no-init control: 20 owned scopes, zero nonterminal workers at
  helper return. The no-network container and owned workers were cleaned up.

Gate logs: `/tmp/541-direct-exit-scripts.log`, `/tmp/541-direct-exit-integration.log`,
`/tmp/541-direct-exit-check.log`, `/tmp/541-direct-exit-types.log`,
`/tmp/541-direct-exit-lint.log`, `/tmp/541-direct-exit-linux.log`.
An initial sandboxed broad script run failed process inspection with EPERM and cache
writes; the permitted rerun passed. Initial missing timer imports were corrected, and
the standalone compiler invocation was pointed at the existing package Node type root.

Only test driver/tests, spec clarification and this record changed. No production
source, dependency, public API, aggregate, workflow, timeout or reserve expansion.
No reviews, review requests, remote thread mutations, subagents or merge.

Not run: full verify, complete package/serial suites, product Docker smoke, consumer,
fresh-install/publish workloads, API-report validation, live audit, Windows/site checks,
or successor CI completion. The Linux probe is not product Docker acceptance. Root
owns successor-head review, CI and acceptance. Normal diagnostic-drain remains unconfirmed.
