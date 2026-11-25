## 2026-11-11 — Identity-verified live cleanup signals (008 §3.1, §5, §6.1; 003 §11.2; 004 §3.2, §3.5) — Refs #479

Moves 008 §5 to _current_ for live signal paths. Every cleanup or enforcement signal goes through
one shared gate in core that verifies the target at signal time, then signals or abstains. Evidence
is the live child handle while Node holds the child unreaped, a recorded `(pid, pgid, start time)`
read from `/proc` on Linux or `/bin/ps` on macOS, and process-group continuity: a group id cannot be
reused while any member exists, so a membership reading that started while the leader was unreaped,
started at the leader's exit, or still contains an earlier-confirmed member confirms every member it
lists. On request (`trackMembership`, used by the command-poll SIGTERM step) the gate also reads
the group's membership every 250 ms through the grace period, one read at a time, until the next
step, so a member that forks a process and later exits passes continuity to it. This keeps 008
§3.1's bound for group-resident descendants, including ones forked after the SIGTERM step by the
leader or handed off between members during the grace period. The step abstains only when
continuity is lost or the process table cannot be read. Lost continuity has two causes the gate
cannot tell apart: the group emptied and its id was reused, or, after the leader has exited, a
member forked and exited between two consecutive readings (within one 250 ms interval plus one
read, which grows under load up to the 5 s `ps` cap) while no other confirmed member was alive. The
second leaves a real descendant running, so §3.1 keeps its MUST and adds it as a stated exception
(the hand-off residual), and §5.1 names it beside the read-duration residual. §3.1 also states the
latency the verification reads add to each step. The Linux reader treats only ENOENT/ESRCH
as an exited process; any other read error makes the reading unsupported. Environment-variable marks
were rejected because macOS hides the environment of platform binaries. Adds the live signal-send
inventory (§5.2) and records the interim abstention surface: a warning line on the daemon's stderr.
The durable, deduplicated warning surface stays target under #507, and the restart sweep under #478.

