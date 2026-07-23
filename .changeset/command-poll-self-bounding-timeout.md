---
'@agentmonitors/source-command-poll': patch
---

Make a POSIX `command-poll` command self-bounding so it does not orphan when the daemon dies. The
command is spawned `detached` (its own process group, for the timeout group-kill), but the
SIGTERM→SIGKILL escalation lived only as timers inside the daemon process. If the daemon died
abruptly (`kill -9`, crash, OOM) before a hung command's timeout fired, those timers died with it
and the detached child reparented to launchd/init and survived **indefinitely** — a
reliability-fatal leak for a long-running background daemon, since nothing was left to reap it.

On POSIX each execution now also arms an independent, `detached` self-watchdog sibling that reaps
the command's process group at a backstop deadline (the command's `timeout` + the SIGKILL grace + a
small slack). Because it is its own detached process, it survives the daemon's death and reaps the
orphan on its own timer; on normal completion it disarms itself so it never lingers — the daemon
never proactively kills it. The backstop deadline is set strictly after the daemon's own escalation
window, so the daemon-resident timers stay authoritative in the normal case and the self-watchdog
only ever fires when they cannot.

The watchdog is made safe, not merely present:

- **It kills by identity, not a recyclable pgid — for the group members that hold that identity.**
  It binds to an un-recyclable liveness pipe whose only write end the command inherits at spawn; it
  signals the group **only** while a blocking read on that pipe proves a holder of that fd is still
  alive, so a command that exits on its own before the deadline can never have its
  (possibly-recycled) pgid signalled. A descendant the command backgrounds via plain shell/exec-based
  job control typically inherits the fd too; a descendant spawned through a process API that
  defaults to close-on-exec for non-explicit fds (the default for most modern high-level spawn
  APIs — Node's own `child_process.spawn` included) does not, so it is not currently covered by this
  guarantee if its spawning leader has already exited.
- **It stays armed regardless of how the execution resolves, until it independently proves the group
  is gone.** It is never proactively killed by the runtime on any outcome (success, failure, or
  timeout) — only by its own liveness-pipe proof or its own deadline — so a descendant backgrounded
  by an otherwise-successful command is bounded too, not just a descendant of a timed-out one.
- **It fails closed.** If no independent bound can be armed, the command is terminated and reported
  as an execution failure rather than run unbounded; and the watchdog never fabricates a kill (a
  missing `sleep` makes it exit without signalling, so a healthy command is never SIGKILLed early).
  Every execution now hard-depends on `mkfifo`, `sh`, and `sleep` being on `PATH`; on a
  binary-minimal image missing one, every execution fails closed instead of running (the monitored
  command itself still starts and can side-effect before that termination lands — only the reported
  result is suppressed).

The watchdog is a **sibling**, not a shell wrapper around the command, so the command is still
spawned directly (`shell: false`): no shell word-splitting, real spawn-failure (`ENOENT`/`EACCES`)
errors, and exact exit codes are all preserved unchanged. This backstop is **POSIX-only** and
best-effort — Windows keeps its daemon-resident `taskkill /T /F` (it has no process groups), and
startup sweeping of strays left by a prior daemon plus active graceful-shutdown reaping remain
target work (AP8, issue #426). Verified by regression tests that `kill -9` a live daemon mid-command
(both before its timeout and during the SIGKILL grace) and assert the orphaned descendant terminates
on its own within the watchdog deadline, plus fail-closed arming tests under a starved `PATH`.
