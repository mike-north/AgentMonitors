---
'@agentmonitors/core': minor
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Verify a process's identity immediately before every cleanup signal. Core adds `sendVerifiedSignal` and `readProcessTable`: a target is signalled only while its spawned child is still unreaped, when a recorded process (pid and start time, read from `/proc` on Linux or `/bin/ps` on macOS) is still present, or, for a process group, while the group can be shown to be the same one (a member confirmed earlier is still in it). Otherwise the signal is withheld and a warning names what was left alone and why.

`command-poll` timeouts still escalate from SIGTERM to SIGKILL across the command's process group, including processes the command forks after the SIGTERM step and commands that exit while that step is checking the group. The SIGKILL follow-up now skips a group that has emptied, and leaves a group alone, with a warning, only when none of its current members was ever confirmed as part of it (its id may have been reused) or the process table cannot be read. `daemon run --detach` failure cleanup and `verify` teardown signal only their own unreaped child, never a pid left behind by a child that has already exited.
