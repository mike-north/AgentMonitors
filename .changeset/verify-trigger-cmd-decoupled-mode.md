---
'@agentmonitors/cli': minor
'agentmonitors': minor
---

`agentmonitors verify` gains a decoupled `--trigger-cmd '<shell>'` mode so a source it can't
auto-trigger (`command-poll`, `api-poll`, `schedule`, `incoming-changes`) can be verified in a
single, self-contained, non-interactive invocation. After establishing baseline, `verify` runs the
given shell command itself (via `/bin/sh -c`, `cwd` = the workspace) to cause the watched change,
then observes/materializes/delivers — exactly like file-fingerprint's auto-trigger, but for any
source. For a `command-poll` watching `git status --porcelain`, that's e.g.
`--trigger-cmd 'touch new-file.txt'`.

This closes a real gap for agent harnesses that run one shell command per tool call
(call-and-return): `--manual` blocks for the detect budget and does **not** read stdin, so such a
harness had no way to make the change while `verify` waited and its honest first attempt FAILed
`budget-exceeded` on a correctly-configured monitor. `--trigger-cmd` needs no second interleaved
command.

Also: the `--manual` `budget-exceeded` FAIL message now names `--trigger-cmd` and the
background-and-interleave workaround instead of a bare "did you make a change?"; `--manual` and
`--trigger-cmd` are mutually exclusive; and a `--trigger-cmd` that exits non-zero is a `setup`
failure on the `trigger` stage (fix the command), distinct from a `no-change` verdict (the command
ran but changed nothing observed). The command's effects are not reverted (an arbitrary command has
no known inverse). The file-fingerprint auto-trigger happy path and runtime notify/debounce timing
are unchanged.
