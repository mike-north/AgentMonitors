---
'@agentmonitors/source-command-poll': patch
---

Fix `command-poll` timeout handling to terminate the entire process tree, not just the direct
child. A command that backgrounds a worker via a shell (e.g. `['sh', '-c', 'sleep 30 & wait']`)
previously left the backgrounded process running — and could hang the observation indefinitely
waiting on its inherited stdout/stderr — after the shell itself was killed on timeout. Each command
now runs as the leader of its own process group on POSIX (signaled as a group on timeout) and is
torn down via `taskkill /T /F` on Windows; timeout resolution no longer waits on stdio stream
closure, so an orphaned descendant can never hang the call.
