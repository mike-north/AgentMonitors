# PR 541 main integration

The owned `worktree-m0-gate-parity-458` checkout was clean at
`d4425c321eff7cbd9d06e0c756dbd36f63305ff3`, matching GitHub's PR head. After fetching
main, the author notified t137 before merging `447f3da2` normally. The merge applied
without conflicts and preserves both spec-changelog histories. No rebase, force push,
review submission, review request, or PR merge was performed.

Main supplies the merged dependency/security and Shape-admission changes from #542
and #552, including Zod 4 and its checked-in API report. This integration adds no new
runtime behavior and does not manually edit generated reports. `pnpm verify`, the partial
`pnpm test` notice, website exclusions, and the execution-context guard remain intact.

## Current execution-context proof

The previously unresolved comment 4462114874 describes behavior before the context
fix. An isolated copy of the merged workflow, manifest, and unchanged guard selected
its real-file parity assertion for each mutation. Current results:

| Input                                                 | Expected / observed exit |
| ----------------------------------------------------- | ------------------------ |
| Ordinary root workflow                                | 0 / 0                    |
| Reversed job mapping order                            | 0 / 0                    |
| Renamed root-check display label                      | 0 / 0                    |
| Root `pnpm check` step with website working directory | 1 / 1                    |
| Job default with website working directory            | 1 / 1                    |
| Workflow default with website working directory       | 1 / 1                    |
| Root check step with unfamiliar shell                 | 1 / 1                    |
| Job default with unfamiliar shell                     | 1 / 1                    |
| Workflow default with unfamiliar shell                | 1 / 1                    |

All six faults are rejected before command deduplication; all three controls pass.
The existing regression suite also passes, including the original duplicate-command
fault. No additional implementation or duplicate regression was needed. The old
job-order review is already resolved; its current control passes. The partial-test
notice describes the nested test invocation accurately and is unchanged.

## Validation

- Frozen dependency installation: passed without modifying the merged lockfile.
- Uncached build, check, and API-report validation with `NX_DAEMON=false` and
  `NX_SKIP_NX_CACHE=true`: passed. Lint reports 527 existing warnings and zero errors.
- `pnpm test:scripts`: 14 files, 363 tests passed, including 31 local-gate tests.
- Focused core parser, monitor-schema, and Zod-security suites: 124 tests passed.
- Focused CLI code-point truncation regression suite: 5 tests passed.
- `pnpm check:dependency-audit`: clean, no unresolved high/critical advisories.
- Isolated execution-context experiment: all nine expected outcomes confirmed.

Local logs are `/tmp/541-integrate-{install,gates,audit,context-proof}.log`; the mutation
harness is `/tmp/541-context-proof.mjs`, which prints its isolated evidence directory.
All commands completed; no daemon, server, container, or background test was started.

Not rerun: the full `pnpm verify` aggregate, complete package/serial tests, Docker smoke,
standalone consumer, fresh-install hooks E2E, publish dry-run, Windows, website build/link
checks, or semantic documentation examples. These results establish the integration's
listed gates, not fresh end-to-end or cross-platform acceptance. GitHub CI results for
the eventual merge head must be assessed separately.
