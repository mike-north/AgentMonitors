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
small slack). It runs on the daemon's own Node binary — not a shell — so its timer is a `setTimeout`
that cannot be missing, cannot return early, and cannot hang, and it depends on nothing in `PATH`.
Because it is its own detached process, it survives the daemon's death and reaps the orphan on its
own timer; on normal completion it disarms itself so it never lingers — the daemon never proactively
kills it. The backstop deadline is set strictly after the daemon's own escalation
window, so the daemon-resident timers stay authoritative in the normal case and the self-watchdog
only ever fires when they cannot.

The watchdog is made safe, not merely present:

- **It kills by identity, not a recyclable pgid — for the group members that hold that identity.**
  It binds to an un-recyclable liveness pipe whose only write end the command inherits at spawn; it
  signals the group **only** while a blocking read on that pipe proves a holder of that fd is still
  alive, so a command that exits on its own before the deadline can never have its
  (possibly-recycled) pgid signalled. A descendant the command backgrounds via plain shell/exec-based
  job control typically inherits the fd too; a descendant spawned through a process API that
  defaults to close-on-exec for non-explicit fds does not, so it is not currently covered by this
  guarantee if its spawning leader has already exited. Node's own `child_process.spawn` is
  platform-dependent: the macOS characterization closes the fd, while Linux CI retains it.
- **It stays armed regardless of how the execution resolves, until it independently proves the group
  is gone.** It is never proactively killed by the runtime on any outcome (success, failure, or
  timeout) — only by its own liveness-pipe proof or its own deadline — so a descendant backgrounded
  by an otherwise-successful command is bounded too, not just a descendant of a timed-out one.
- **The watchdog spawns the command, so the bound exists before the command does.** Arming after the
  spawn left the command running unbounded for the whole of the watchdog's launch — a command whose
  first action was to kill the daemon escaped that way in 40 of 40 concurrent Linux runs. Arming
  first but still spawning from the daemon only narrowed it (34 of 40). Having whoever creates the
  command own its deadline closes it outright (0 of 40). Node still performs the spawn, so the
  no-shell guarantee, real `ENOENT`/`EACCES` spawn errors, and exact exit codes are unchanged, and
  the command's output still streams straight to the daemon.
- **It fails closed, and now before anything runs.** If no independent bound can be armed — the
  liveness pipe cannot be created, the watchdog cannot be launched, or it does not confirm arming
  within a bounded deadline — the execution is reported as a failure and the command is never
  spawned at all, rather than spawned and terminated after the fact. The arming handshake is itself
  bounded, so it can never leave an observation pending forever or strand a detached watchdog
  subtree. Every execution hard-depends on `mkfifo` being on `PATH` (for the liveness pipe) and
  nothing else; on an image without it, every execution fails closed instead of running.

The watchdog is a **sibling**, not a shell wrapper around the command, so the command is still
spawned directly (`shell: false`): no shell word-splitting, real spawn-failure (`ENOENT`/`EACCES`)
errors, and exact exit codes are all preserved unchanged. This backstop is **POSIX-only** and
best-effort — Windows keeps its daemon-resident `taskkill /T /F` (it has no process groups), and
startup sweeping of strays left by a prior daemon plus active graceful-shutdown reaping remain
target work (AP8, issue #426). Verified by regression tests that `kill -9` a live daemon mid-command
(both before its timeout and during the SIGKILL grace) and assert the orphaned descendant terminates
on its own within the watchdog deadline, plus fail-closed arming tests under a starved `PATH`.
