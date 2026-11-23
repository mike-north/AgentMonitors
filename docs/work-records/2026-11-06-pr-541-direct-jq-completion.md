# PR 541 accepted direct-jq boundary and terminal completion

Start: clean local/index/live PR head `58667e1fc1369c3ce389f4facaec264ca7ea1eca`.
The operator explicitly accepted option B: facility controls execute actual shipped jq
programs directly; unchanged package tests retain real command-poll/preset integration.
t137 was notified before the successor commit changed HEAD. No supervisor A, production
470/472, API, dependency, review/thread, subagent, or PR merge work was performed.

## Confirmed failures before repair

The exact real-observation probe failed its no-survivor assertion: detached command-poll
observation PID 9836 survived in its own group, PPid1, state Ss. Its recorded group was
killed in finally and an exact subsequent PID inspection confirmed it gone. The exact
Linux Node24/PID1/no-init completion probe found nonterminated workers immediately after
helper return in 14 of 20 scopes. That assertion failed without post-return polling;
recorded workers and the owned container were cleaned up. Both failures were established
before implementation. Diagnostic-drain loss remains unconfirmed: supplied byte logs
report lost [] on both hosts, and no speculative normal-drain repair was made.

## Accepted facility proof

`scripts/jq-direct-presets.test.ts` parses the exported canonical TEMPLATES and extracts
the jq program from each shipped scaffold command. It invokes real jq directly against
authored raw-GitHub fixtures and asserts structural expected results for pr-review and
my-prs. It does not evaluate the shell wrapper or invoke commandPoll.observe. There are
no copied substitute filters or fake positive executables. The facility driver's positive
assertion failed against the old source-observation child selection before switching it.

An invalid-expression mutation in the copied canonical shipped reduction fails the control;
a valid-but-wrong reduction mutation also fails its authored result. Installed jq executes
both real programs. Local missing jq still reports an explicit skip; CI missing jq fails.
The existing CLI preset integration file has no diff and its 80 real integration tests
passed. Those source/preset cases remain in the normal package suite and pnpm test/verify.
The script control does not independently prove that observation lifecycle. The original
arbitrary real-observation escape is not claimed to be repaired in production; the facility
control no longer starts such separately detached scopes, as explicitly accepted.

## Known-group completion

The driver retains inherited boundary ownership, minimal child environments, nested
non-self-signaling, and natural/timeout cleanup. It now reserves cleanup time _inside_
its existing total bound (at most one second, or one quarter of a short bound), rather
than extending child/parent deadlines. The outermost owner signals its known group and
awaits actual terminal evidence before returning without a cleanup error. Confirmation
errors are returned visibly and inherited readers are released on failed cleanup.

Linux uses kernel proc group membership/state and accepts Z/X/x or ESRCH, not R/S/T or
pending SIGKILL alone. Permission/proc errors fail; a missing proc entry cannot establish
termination while the group still exists. Darwin group-zero probes produced EPERM even
outside the sandbox, so Darwin queries OS membership/state with absolute /bin/ps (bounded
by the same remaining deadline, independent of the test PATH). Query failures fail.
This is narrow confirmation of an already-owned Node/jq group, not arbitrary descendant
adoption, source-process discovery, or a detached-production-observation supervisor.

Two deterministic completion regressions failed against the old driver. They now prove
it waits past direct-child close while terminal confirmation is pending, and propagates
confirmation failure. Removing only the cleanup await makes the regression fail. A real
ignored-stdio worker regression checks terminal state immediately at helper return, with
no caller-side polling. The same 20-scope Linux PID1 probe now has zero nonterminal
workers at return. Removing only terminal-state confirmation restores the failure (17 of
20 scopes in that mutation run). All owned mutation containers were removed.

## Gates and limits

- Final repository check passed; 527 existing lint warnings, zero errors.
- Complete script suite: 21 files, 398 tests passed.
- Unchanged real CLI preset package file: 80 tests passed.
- Focused controls, strict TS/JS compilation, lint, formatting and diff checks passed.
  Standalone compilation uses the repository's skipLibCheck policy and existing ambient
  jq-browser declaration for imported template dependencies.
- Direct shipped-program mutations and completion-await/terminal-confirmation mutations
  failed their intended regressions; Linux at-return red/green proofs were verified.
- No source-command-poll, existing package integration test, package.json, lockfile, or
  public report changes. Parity/prerequisite/audit guard and aggregate remain unchanged.

Logs: `/tmp/541-direct-boundary-red.log`, `/tmp/541-completion-unit-red.log`,
`/tmp/541-direct-final-focused.log`, `/tmp/541-direct-jq-final-gates.log`,
`/tmp/541-observation-cleanup-red.log`, and
`/tmp/541-worker-completion-{red,green,mutant}.log`. Retained copied-source evidence is
under `541-direct-jq-mutants-*` and `541-completion-await-mutant-*` in the OS temp directory.

Not run: full pnpm verify, complete package/serial suites, product Docker smoke,
consumer/fresh-install/publish workloads, live advisory audit, API-report validation,
Windows/site checks, or successor CI completion. The targeted Linux probes do not
constitute product Docker acceptance. No full-gate or universal diagnostic-drain claim.
