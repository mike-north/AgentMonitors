## 2026-07-19 — Manual-CLI ergonomics: `daemon run --detach`, an always-on no-socket diagnostic on `hook deliver`, and `events` help that names the required `--session` (005 §3, §9.2, §11.1, §12.2/§12.2.1) — Refs #389

Three independent papercuts on the "drive the CLI directly, no plugin" path, all surfaced by a blind
usability evaluation. None blocks success alone; together they cost a first-time manual user a
"is this broken?" moment each.

**P1 — `daemon run` gained `--detach` (005 §9.2, §3).** `init` tells manual users to "start the
daemon yourself: `agentmonitors daemon run`", which then blocks their terminal — leaving `& disown`
and log redirection to be discovered. The issue allowed either a real flag or documenting the shell
idiom; the flag is what shipped, because the daemon already has a supported detached-spawn path
(`spawnDetachedDaemon()`, used by the hook-driven lazy boot) and reusing it keeps one background
daemon story instead of two. `--detach` re-invokes `daemon run` (without `--detach`) as a detached
`unref`'d child with every value resolved by the parent and passed explicitly, appends the child's
output to `--log` (default `<workspace data dir>/daemon.log`), waits up to 15s for the socket to
answer, and prints the pid/socket/log. It composes with `--reap-after-ms 0` — the supported way to
keep a daemon alive while no agent session is open — and reports "reaping disabled" for that pair.
The already-running guard runs before anything is backgrounded. `init`'s next-steps line now names
the `--detach` form. This is deliberately **additive** and independent of the open question in #435
about whether a channel-attached session should count as reaper activity; it changes no reaping rule.

**P2 — `hook deliver` warns on stderr when no per-workspace socket is configured (005 §12.2 step 3,
§12.2.1).** That branch previously returned empty stdout + exit 0 with the explanation gated behind
`--debug`, making it indistinguishable from "nothing pending" — a state that never self-resolves.
It joins the always-on stderr diagnostics (now four, not three). A workspace that is **not enabled**
remains silent on both streams: that is an opt-out, not a misconfiguration. `hook deliver`'s stdout
stays byte-identical in every mode (the hook wire contract, 006 §5.1) — an explicit non-goal to change.

**P3 — `events list`/`events ack` summaries name the required `--session` (005 §11.1).** `events
--help` renders only the summary line per subcommand, so the requirement was discoverable only by
running the command and reading commander's `required option '--session <id>' not specified`. Both
summaries now say `(requires --session <id>)`. `--session` remains **required** on both — a non-goal
to relax; only the documentation changed.

