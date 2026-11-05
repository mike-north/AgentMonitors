# Launcher first-attempt acceptance

Base: `adb3cebf9a58b8a0a43b241df97259048f5ef0cc` (main on 2026-11-03).

`apps/agentmonitors/vitest.config.ts` set `retry: 2` on the assumption that launcher failures were
transient contention. They were not: the retry masked a race between two suites over the CLI build.

## What the retry was added for

PR #256 added the retry after one failure on main, run
[28460527611](https://github.com/mike-north/AgentMonitors/actions/runs/28460527611):
`--version` exited 1 in 108 ms. The test printed no stderr at that time. The same run's
unknown-subcommand test passed, which it would also do if the launcher could not load at all.
An exit of 1 in about 100 ms is not what a slowed process looks like.

## Root cause

`apps/cli/src/commands/cli.integration.test.ts` ran `pnpm build` in `beforeAll`, and the CLI's `tsup`
config sets `clean: true`, so `apps/cli/dist` is deleted before it is rewritten. `nx run-many
--target=test` runs `@agentmonitors/cli:test` and `agentmonitors:test` concurrently. A launcher
started in that window exits 1 with `Cannot find module .../apps/cli/dist/index.cjs` in about 30 ms.

The self-build existed because `@agentmonitors/cli:test` inherited only `^build`, so nothing else
built the package's own bundle for its own target.

### Evidence

The high-volume sampler spawns the real launcher with concurrency 8 and no retries.

| Condition                                      | `--version` spawns | Failures                 |
| ---------------------------------------------- | ------------------ | ------------------------ |
| Sampler alone; `dist` mtime unchanged          | 500                | 0                        |
| Sampler plus only the `beforeAll`, run 3 times | 750                | 88, all MODULE_NOT_FOUND |

The second row selected a single trivial test with `-t 'shows help text'`, and `dist`'s mtime changed
on each of the three runs.

Before the fix, with the real package suites running in parallel, the launcher suite with `--retry 0`
failed 1 of 40 runs on its first attempt with that same error, and `dist`'s mtime showed a rebuild
during the run. That run is supporting evidence only, because a brief manual `dist` move for another
check may have overlapped its start. The controlled comparison above is the causal proof.

CPU contention alone did not reproduce it. Before the fix, 140 no-retry runs (280 test executions)
passed with no failure: 50 ambient, then 30 each with 18, 36 and 72 CPU workers on this 18-core
machine.

The June failure's cause cannot be proven because its stderr was not captured. It matches this race:
exit 1, about 100 ms, and the launcher suite started two seconds after the CLI suite.

## A second defect: the 30-second bound never applied

Vitest's default `testTimeout` is 5 s, and it fails a synchronous test on return once that has passed.
A throwaway test whose child ran 6 s and exited 0 failed with `Test timed out in 5000ms`, and its
assertion message never rendered. So the launcher's effective limit was already about 5 s, and hitting
it lost the diagnostics added by #256.

No timeout was raised. The bound is now 4.5 s, inside the test's budget, and a test asserts that it
stays there. An overrun now reports status, signal and output.

## Changes

- `apps/cli/project.json`: `test` and `test:serial` depend on `build`.
- `cli.integration.test.ts`: the self-build is gone.
- `apps/agentmonitors/vitest.config.ts`: the retry is gone.
- `launcher.test.ts`: the unknown-subcommand test requires the CLI's own error. Forced crash and hang
  cases prove the evidence renders.
- `scripts/cli-build-ownership.test.ts` and `scripts/vitest-launcher-retry.test.ts` guard the wiring.
  Both failed before the fix (four assertions). With `dist` removed, both launcher behavior tests now
  fail, where the unknown-subcommand test previously passed.

## Results after the fix

Load workers exit on stdin EOF or at a 300 s deadline, and the driver reaps them. All workers exited
normally, and none remained after any run. `dist`'s mtime did not change across the first two rows or
the rest of the sequence. Sampler checks now also require the expected stdout or stderr content.

| Condition                                | Runs | Executions | Failures | Max test or spawn |
| ---------------------------------------- | ---- | ---------- | -------- | ----------------- |
| Sampler, integration `beforeAll` 3 times |      | 1,500      | 0        | 307 ms            |
| Sampler, real suites in parallel         |      | 3,000      | 0        | 552 ms            |
| Launcher suite, real suites in parallel  | 40   | 200        | 0        | 355 ms            |
| Launcher suite, ambient                  | 50   | 250        | 0        | 205 ms            |
| Launcher suite, 18 CPU workers           | 30   | 150        | 0        | 252 ms            |
| Launcher suite, 36 CPU workers           | 30   | 150        | 0        | 315 ms            |
| Launcher suite, 72 CPU workers           | 30   | 150        | 0        | 1,350 ms          |

Launcher runs used `--retry 0`. The machine was shared with other sessions; 1-minute load ranged from
about 10 to 113.

## CI history

Vitest logs a test that passes on retry only if its summed attempts exceed 300 ms, so a clean log is
weak evidence. Of 474 CI runs from 2026-07-16 to 2026-11-04, 167 logs showed the launcher file, with
no retry marker and file times of 485–1,528 ms. The other logs showed no launcher line, so they say
nothing either way. Across 100 scanned failed runs, June's is the only launcher failure.

## Not verified

- First-attempt behavior on GitHub's Linux runners beyond the CI for this change. All soak runs were
  local on macOS.
- Windows.
- Causation of the June failure, as above.
- Whether this race explains any other historical failure in a suite that executes the CLI bundle.

## Full local gate

From `pnpm clean`, with Node 24 on macOS. `pnpm test` ran the CLI build before both the launcher and
CLI suites, and no retry marker appears anywhere in its output.

| Command                             | Result                                                |
| ----------------------------------- | ----------------------------------------------------- |
| `pnpm build`                        | PASS                                                  |
| `pnpm check:packages`, `check:aipm` | PASS                                                  |
| `pnpm check:lint-ts`                | PASS, 0 errors (existing warnings)                    |
| `pnpm check:format`                 | FAIL on one local session file; see below             |
| `pnpm check:test-ext`               | PASS                                                  |
| `pnpm check:api-report`             | PASS                                                  |
| `pnpm test`                         | 1 FAIL of 1,826 tests, unrelated; launcher 5/5 passed |
| `pnpm test:scripts`                 | PASS, 323 tests                                       |
| `pnpm test:serial`                  | PASS, 64 tests (its own retry setting is unchanged)   |
| `pnpm test:standalone-consumer`     | PASS                                                  |
| `pnpm test:e2e-fresh-install-hooks` | PASS                                                  |

## Other failures seen

Neither of these involves the launcher, and both remain open.

- `hook-deliver-commit-ordering.test.ts` failed with `spawn EBADF` in the full `pnpm test` above and
  in the pre-fix parallel run, before any code here changed. It passed in the post-fix parallel run
  (877 of 877 CLI tests). No open issue was found. A likely but unproven cause: the preceding test
  closes an fd, then `stream.destroy()` closes the same number again asynchronously, which can hit the
  fd reused by the next test's `spawn`.
- `libs/core/src/runtime/diff.test.ts` failed once in the pre-fix parallel run (1145 ms against a
  1000 ms bound), tracked by #515.
- `pnpm check:format` fails locally when the Agent Monitors plugin is active in a checkout, because
  `.agentmonitors/sessions/*/hook-state.json` is neither ignored nor Prettier-formatted. CI does not
  have that file. With only that directory excluded, the format check passes.
