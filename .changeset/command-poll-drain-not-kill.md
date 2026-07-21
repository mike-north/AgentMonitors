---
'@agentmonitors/source-command-poll': patch
---

Fix a P1 correctness defect in `command-poll`: excess `stdout`/`stderr` no longer kills the child
process. `stdout` is streamed and retains only its leading 1 MiB; `stderr` is streamed and retained
independently of the stdout cap for failure diagnostics. Neither cap ever terminates the command —
a command producing more than the cap on either stream still runs to its real completion (side
effects included) and reports its actual exit code, instead of being killed mid-write and having its
exit status silently fabricated as a truncated success.
