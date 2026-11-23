# Real-daemon crash recovery acceptance evidence

Base: current upstream `e1bafcfa15244972db4728ca0f4be4106ff10007`.
Worktree: `/Users/mnorth/.codex/worktrees/daemon-crash-recovery/agentmonitors`.
Branch: `codex/daemon-crash-recovery-proof`.

## Existing coverage inspected first

- `daemon-detach.integration.test.ts`: real detached startup, persistent reap=0,
  socket collision, startup failure diagnostics and terminated-child cleanup.
- `daemon-reaper-lease.integration.test.ts`: real channel heartbeat keeps a dormant
  workspace ticking; stale/foreign leases and hook heartbeats do not pin the daemon.
- `cli.integration.test.ts`: doctor reports a registered-session daemon-down failure,
  but the fixture uses graceful stop and does not restart or recover unread work.
- #435 already has lease integration coverage; #513 concerns unexplained loaded-CI
  daemon death; #514 improves Docker diagnostics and remains separate. This change
  neither diagnoses #513's unknown original cause nor duplicates #514's harness.

## Bounded new proof

A new serial acceptance test creates a source baseline using the real CLI, starts
an owned daemon, opens a lead session, produces a file change, and waits for its
unread event. It SIGKILLs and waits for that child's signal exit, verifies doctor
reports the registered-session outage, explicitly starts a new owned child on the
same database/socket, and confirms the same host-session identity resumes the same
session with the exact unread event. A real hook claim delivers the normal reminder;
the event stays unread until an explicit acknowledgment.

No production code change was necessary: the acceptance test passes current upstream.
The first harness run exposed an incorrect IPC helper call signature in the test,
corrected with a single socket-pinned RPC helper before successful acceptance runs.
That failed readiness attempt did not execute session or event mutations. The CLI's
normal check excludes tests; a separate temporary TypeScript config explicitly checks
this new test and its imports as well.

All child handles are locally owned; cleanup signals only those handles, awaits exit,
and removes temporary state only after confirmed exit. Every CLI command is time-bounded;
readiness and event polling distinguish child exit from a slow live child and retain its
bounded output. No user daemon, monitor, or service is modified. HOME, XDG_DATA_HOME,
database and socket are isolated for subprocesses; all IPC explicitly targets the test socket.

Limits: already-committed unread work only; no power failure, kill-during-SQL-commit,
automatic supervisor restart, OS service installation, existing host session delivery,
or pending #482/#483 runtime adoption claim. Independent review is required before merge.

## Validation

- `pnpm build`: all seven publishable build targets pass.
- `pnpm check`: all package typechecks, lint (0 errors; existing warnings), formatting,
  test naming, and marketplace validation pass.
- Explicit TypeScript check including the new test and imported CLI modules passes.
- Serial acceptance selection with `--retry=0`: detach (12), reaper lease (5),
  crash recovery (1), 18 total pass. The final crash-recovery file also passes alone
  after cleanup and delivery-mode assertions were tightened.
- `git diff --check` passes. No API or published behavior change; no Changeset needed.
