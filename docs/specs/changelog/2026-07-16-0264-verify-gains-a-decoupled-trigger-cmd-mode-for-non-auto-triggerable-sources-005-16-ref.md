## 2026-07-16 — `verify` gains a decoupled `--trigger-cmd` mode for non-auto-triggerable sources (005 §16) — Refs #413

`agentmonitors verify --manual` — the verification path for sources `verify` can't fabricate a
change for (`command-poll`, `api-poll`, `schedule`, `incoming-changes`) — **blocks** for the detect
budget waiting for an out-of-band change and is **not** an interactive stdin prompt. A human
switches windows and edits a file; a persistent-shell agent backgrounds the run. But an agent
harness that runs one shell command per tool call (call-and-return) can't make the change while
`--manual` blocks, so its honest first attempt FAILs `budget-exceeded` on a correctly-configured
monitor (usability evidence, #413).

Resolved by adding a third **trigger mode** to §16 (`auto` | `command` | `manual`). The new
**command** mode, `--trigger-cmd '<shell>'`, has `verify` run the given shell command itself (via
the OS default shell — `/bin/sh -c` on POSIX — `cwd` = the workspace) after baseline to cause the watched change, then
observes/materializes/delivers — so any non-auto-triggerable source is verifiable in a single,
self-contained, non-interactive invocation, exactly like file-fingerprint's auto-trigger. A
`--trigger-cmd` that exits non-zero is a `setup` failure on the `trigger` stage (fix the command),
distinct from `no-change` (the command ran but changed nothing observed). Its effects are not
reverted (an arbitrary command has no known inverse); because they are real operator-caused changes
(not a verify scratch artifact), they are never swept by the `--use-workspace-daemon` retraction
(#407). `--manual` and `--trigger-cmd` are mutually exclusive. The `--manual` `budget-exceeded` FAIL
message now names `--trigger-cmd` and the background-and-interleave workaround instead of a bare
"did you make a change?", and the getting-started + skill Phase-5 guides document `--manual`'s
blocking, stdin-less nature with `--trigger-cmd` as the recommended path for non-interactive /
call-and-return agents. No change to runtime notify/debounce timing or the file-fingerprint
auto-trigger happy path.

