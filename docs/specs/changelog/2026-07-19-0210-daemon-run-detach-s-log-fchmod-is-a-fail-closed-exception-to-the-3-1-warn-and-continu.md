## 2026-07-19 — `daemon run --detach`'s log `fchmod` is a fail-closed exception to the §3.1 warn-and-continue rule, not an oversight (002 §3.1) — Refs #389

Round-7 review follow-up. `openLogFd`'s final `fchmodSync` on the opened log descriptor already
closed the descriptor and threw an actionable error when `fchmod` failed (e.g. `EPERM` because a
pre-existing `--log` file is owned by another user). The review correctly flagged that this reads
as contradicting §3.1's general "degrade gracefully where the artifact is not ours" rule — warn
once to stderr and continue on `EPERM`/`EACCES` — which was written for artifacts the daemon merely
tightens incidentally to a write that happens regardless (hook-state files, the database, sockets,
directories).

That general rule was never meant to cover this case, and the spec did not say so explicitly. The
`--detach` log is different in kind: whether it can be made owner-only gates whether the daemon
starts logging at all, and once started the log accumulates workspace paths and monitor-failure
details for the process's lifetime. Continuing to write those into a file the daemon cannot secure
to `0600` would be strictly worse than refusing to start — it is the one artifact in this section
where the mode check is the whole point of the operation, not incidental to it. §3.1 now states
this fail-closed behavior as its own bullet, and calls out the exception explicitly from the
warn-and-continue bullet so the two are not read as contradictory.
`apps/cli/src/open-log-fd-fail-closed.test.ts` adds a regression asserting the fail-closed outcome
(descriptor closed, spawn refused) by forcing `fchmodSync` to throw.

