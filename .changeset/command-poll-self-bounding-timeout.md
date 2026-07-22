---
'@agentmonitors/source-command-poll': patch
---

Make a `command-poll` command self-bounding so it can never orphan when the daemon dies. The
command is spawned `detached` (its own process group, for the timeout group-kill), but the
SIGTERM→SIGKILL escalation lived only as timers inside the daemon process. If the daemon died
abruptly (`kill -9`, crash, OOM) before a hung command's timeout fired, those timers died with it
and the detached child reparented to launchd/init and survived **indefinitely** — a
reliability-fatal leak for a long-running background daemon, since nothing was left to reap it.

On POSIX each execution now also arms an independent, `detached` self-watchdog sibling: given the
command's process-group id, it sleeps until a backstop deadline (the command's `timeout` + the
SIGKILL grace + a small slack) and then SIGKILLs that whole group. Because it is its own detached
process, it survives the daemon's death and reaps the orphan on its own timer; on normal completion
the daemon reaps the watchdog promptly so its `sleep` never lingers. The backstop deadline is set
strictly after the daemon's own escalation window, so the daemon-resident timers stay authoritative
in the normal case and the self-watchdog only ever fires when they cannot.

The watchdog is a **sibling**, not a shell wrapper around the command, so the command is still
spawned directly (`shell: false`): no shell word-splitting, real spawn-failure (`ENOENT`/`EACCES`)
errors, and exact exit codes are all preserved unchanged. Windows keeps its daemon-resident
`taskkill /T /F` (it has no process groups); the self-bounding backstop is POSIX-only. Verified by a
regression test that `kill -9`s a live daemon mid-command and asserts the orphaned descendant
terminates on its own within the watchdog deadline.
