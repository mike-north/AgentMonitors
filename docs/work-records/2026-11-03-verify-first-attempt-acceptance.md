# Issue #452 verification investigation

Base: `adb3cebf9a58b8a0a43b241df97259048f5ef0cc` (main on 2026-11-03).

The October 31 failure in run [41254592967](https://github.com/mike-north/AgentMonitors/actions/runs/41254592967)
was the `verifyReport.ok` assertion, before the later genuine file creation. The July issue's title
alone does not establish that the post-verify create was lost. Per-attempt workspace/socket isolation
already exists in the test. Its first failure is a product verification verdict, not a fixed wait
before reading a materialized row.

Main already includes #533 (Refs #532): verification uses observation identities rather than comparing
second-rounded SQLite history timestamps against a millisecond trigger-completion clock. It also keeps
positive observations recorded during a trigger command. No additional runtime change is included here.

A reversible comparison rebuilt only the CLI with the two pre-#533 verification modules and ran
`literal-glob|non-auto-triggerable|keeps a real daemon observation` with `--retry 0` three times.
All three runs failed the controlled command-boundary regression: durable triggered history existed
before command completion, yet verification returned observe/no-change. The ordinary #413 and literal
tests passed all three comparison runs. Thus the defect is reproduced, but those runs do not prove
causal attribution to each historical CI failure. Current source and build were restored afterward.

The strengthened literal test requires the literal file and verify events to be absent after cleanup,
then checks the user's exact contents and event identity, and proves survival over two completed
observations rather than a fixed sleep. Existing budgets are retained for materialization; the survival
check uses bounded condition polling inside the existing outer test limit. Assertion messages retain
verification reports and, for the literal case, daemon observation history.

## Command-trigger investigation

Used `gh run list` for October CI and `gh run view --log-failed`; also inspected full logs for
successful/cancelled jobs, where failed test attempts can be hidden by retries. The #413 single-call
case consumed retry x1 in runs [41077672111](https://github.com/mike-north/AgentMonitors/actions/runs/41077672111),
[41078780306](https://github.com/mike-north/AgentMonitors/actions/runs/41078780306), and
[41254592967](https://github.com/mike-north/AgentMonitors/actions/runs/41254592967).
The historical reports/history are missing. [#540](https://github.com/mike-north/AgentMonitors/issues/540),
assigned with `gh-milestones assign 540 7` to M0, tracks that remaining attribution gap. The controlled
command-boundary failure shares the repaired #532 cause; a distinct cause for the older ordinary test
has not been demonstrated.

## Validation

The initial current-main file run passed 17/17 tests with `--retry 0` in 99.58 s. A sandboxed
attempt could not bind Unix sockets (`listen EPERM`); all reported daemon acceptance runs use the
unrestricted execution permission and real Unix sockets. Raw local logs are `/tmp/m0-452-*.log`.

Repeated acceptance runs use this command from the repository root:

```sh
pnpm --filter @agentmonitors/cli exec vitest run --config vitest.serial.config.ts \
  src/commands/verify.integration.test.ts --retry 0 --reporter verbose
```

Runs 1–2 use the shared machine's ambient load. Runs 3–5 add eight Python CPU workers continuously
computing square roots. Each worker monitors a private supervisor pipe for EOF and self-expires after
600 seconds; the supervisor closes every pipe, waits, and kills/reaps any worker that does not exit
within three seconds. At one sample during run 3 the eight workers each used 66.5–75.3% CPU.
Worker PIDs: 15612, 15613, 15614, 15615, 15616, 15618, 15619, 15620.

## Retry decision

The complete serial audit with `--retry 0` passed 64/64 tests in nine files (190.80 s), including
the Docker runtime smoke. No test required a retry in that audit; the configuration now explicitly
sets `retry: 0`. `scripts/vitest-serial-retry.test.ts` failed against the former value of 2 and
passes against 0. This is a first-attempt gate commitment, not a claim that one audit proves the
absence of every possible environmental failure.

The October log inventory found these historical retry counts (additional attempts, not total
attempts). These are historical evidence, not exceptions retained in the configuration:

| Test                                                          | Observed retries     |
| ------------------------------------------------------------- | -------------------- |
| Literal-glob post-verify create                               | 1, 2                 |
| Scratch-file cleanup and later real delivery                  | 1, 2                 |
| File-fingerprint PASS                                         | 1                    |
| Debounce PASS                                                 | 1                    |
| #413 single-call command trigger                              | 1                    |
| #416 blocking command trigger                                 | 1                    |
| Transport health: muted reminders with scoped ack remediation | 2 (terminal failure) |

The last historical test's behavior has since changed on main; the current transport-health suite
passed in the no-retry audit. Other M0 issues and their branches are outside this change's scope.

## Repeated-file acceptance results

| Run | Added CPU workers | Tests | Result        | Wall time |
| --- | ----------------- | ----- | ------------- | --------- |
| 1   | 0                 | 17    | PASS, retry 0 | 101.51 s  |
| 2   | 0                 | 17    | PASS, retry 0 | 104.88 s  |
| 3   | 8                 | 17    | PASS, retry 0 | 108.78 s  |
| 4   | 8                 | 17    | PASS, retry 0 | 102.83 s  |
| 5   | 8                 | 17    | PASS, retry 0 | 102.93 s  |

All 85 test executions passed on their first attempt; no retry marker appears in any of the five logs.
All eight workers exited with code 0 and were reaped. The literal-glob case passed in every run.

## Full local gate

All runs used `NX_DAEMON=false NX_SKIP_NX_CACHE=true`.

| Command                             | Result | Wall time |
| ----------------------------------- | ------ | --------- |
| `pnpm build`                        | PASS   | 10.64 s   |
| `pnpm check`                        | PASS   | 30.26 s   |
| `pnpm check:api-report`             | PASS   | 19.44 s   |
| `pnpm test`                         | PASS   | 300.69 s  |
| `pnpm test:scripts`                 | PASS   | 5.79 s    |
| `pnpm test:standalone-consumer`     | PASS   | 20.63 s   |
| `pnpm test:e2e-fresh-install-hooks` | PASS   | 41.43 s   |

`pnpm test`: 1,822 tests across 101 files; `pnpm test:scripts`: 319 tests across 12 files.
The separate serial audit passed 64 tests across nine files, including Docker, with retries disabled.
The full check emitted existing lint warnings but no errors. API reports did not change.
The fresh-install proof reached nonempty hook additionalContext and confirmed claiming did not
acknowledge the event.

No published behavior or public type changes are introduced by this PR, so it needs no additional
Changeset or API regeneration. The existing #533 product repair already has its own Changeset.

Not verified: Windows, Linux execution locally, arbitrary CPU starvation, or causal reconstruction of
the historical #413 failed attempts. GitHub CI on the final PR head is separate from these local
results. No human product decision is needed; #540 remains open for the historical attribution gap.
