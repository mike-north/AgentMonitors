---
'@agentmonitors/core': minor
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Verify a process's identity immediately before every cleanup signal. Core adds `sendVerifiedSignal` and `readProcessTable`: a target is signalled only while its spawned child is still unreaped, when a recorded process (pid and start time, read from `/proc` on Linux or `/bin/ps` on macOS) is still present, or, for a process group, while the group can be shown to be the same one (a member confirmed earlier is still in it). Otherwise the signal is withheld and a warning names what was left alone and why.

`sendVerifiedSignal` also accepts `trackMembership` (`GroupMembershipTracking`): after a step signals a process group, the gate keeps reading the group's membership every 250 ms, one read at a time, until the next step starts, so a member that forks a process and later exits passes the group on to it. Tracking stops on an empty group, on lost continuity, at `untilMs`, or when its abort signal fires, and its timers never keep the process alive.

`command-poll` timeouts still escalate from SIGTERM to SIGKILL across the command's process group, including processes the command forks after the SIGTERM step, processes a member that ignores SIGTERM forks during the grace period before exiting, and commands that exit while the SIGTERM step is checking the group. The SIGKILL follow-up now skips a group that has emptied, and leaves a group alone, with a warning, only when none of its current members was ever confirmed as part of it or the process table cannot be read. One case still escapes the timeout's bound: after the command itself has exited, a member that forks a process and exits within one 250 ms reading interval, while no other confirmed member is alive, leaves that process unconfirmed, and it is left alone with a warning. `daemon run --detach` failure cleanup and `verify` teardown signal only their own unreaped child, never a pid left behind by a child that has already exited.
