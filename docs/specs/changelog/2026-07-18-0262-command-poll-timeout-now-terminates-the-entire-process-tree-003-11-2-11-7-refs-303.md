## 2026-07-18 — `command-poll` timeout now terminates the entire process tree (003 §11.2/§11.7) — Refs #303

`command-poll`'s timeout handling previously signaled only the direct child (`child.kill()`). A
command that invokes a shell backgrounding a worker — `['sh', '-c', 'sleep 30 & wait']`, the
supported pipeline idiom from §11.1 — left the backgrounded process running after the shell was
killed: a resource leak across repeated polls, and a direct violation of §11.7's "no orphan
process" requirement. Worse, the prior implementation (`execFile`, whose completion is gated on the
child's stdio streams closing) could **hang the observation indefinitely**: an orphaned descendant
that inherited stdout/stderr keeps those pipes open even after the direct child is dead, so waiting
for `close` never resolves.

Fixed by spawning each command as the leader of its own POSIX process group/session
(`detached: true`) and signaling the **negative PID** on timeout (SIGTERM, then SIGKILL after the
existing 5s grace) — targeting the whole tree, not just the direct child. Resolution is driven by
the direct child's own `exit` event rather than stream `close`, so a descendant holding stdio open
can never hang the call; the same bounded-fallback principle also covers ordinary (non-timeout)
completions as a defensive measure, at no cost to well-behaved commands. Windows has no
process-group-signal equivalent and no reliable graceful signal for a non-console-attached spawned
process, so the documented choice there is `taskkill /PID <pid> /T /F` (forceful, tree-wide) at both
the timeout expiry and the grace follow-up — §11.2 now states this explicitly as a normative
platform-specific mechanism rather than leaving it undefined.

§11.7 gained a new validation bullet naming the regression test (`sh -c 'sleep 30 & wait'`,
asserting the descendant is dead by captured PID — not by process-tree membership, since an orphan
is reparented away the instant its true parent dies) and the end-to-end daemon-run/daemon-stop
integration test proving the same guarantee holds across a real daemon's own shutdown, not just a
single `observe()` call. No change to the failure-transition semantics of §11.5: a timeout still
keeps prior state and fires exactly one `ok → failing` observation.

