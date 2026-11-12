---
'@agentmonitors/core': minor
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Verify a process's identity immediately before every cleanup signal. Core adds `sendVerifiedSignal` and `readProcessTable`: a target is signalled only while its spawned child is still unreaped, or when a recorded process (pid and start time, read from `/proc` on Linux or `/bin/ps` on macOS) is still present. Otherwise the signal is withheld and a warning names what was left alone and why.

`command-poll` timeouts still escalate from SIGTERM to SIGKILL across the command's process group. The SIGKILL follow-up now skips a group that has emptied, and leaves a group alone, with a warning, when none of its current members was present at the SIGTERM step, because its id may have been reused. `daemon run --detach` failure cleanup and `verify` teardown signal only their own unreaped child, never a pid left behind by a child that has already exited.
