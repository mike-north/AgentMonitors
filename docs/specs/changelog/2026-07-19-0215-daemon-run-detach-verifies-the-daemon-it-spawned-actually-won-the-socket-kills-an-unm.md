## 2026-07-19 — `daemon run --detach` verifies the daemon it spawned actually won the socket, kills an unmanaged child on timeout, `--log` requires `--detach`, and the no-socket warning gets a boot-failed variant (005 §9.2, §9.3, §12.2/§12.2.1) — Refs #389

PR review follow-ups on the `--detach`/no-socket-diagnostic work above.

**Finding 1 — identity check on `--detach` success.** The readiness wait only proved SOME daemon
answers on the socket, not that it is the child THIS invocation spawned: concurrent lazy-boot
elsewhere (`session start`'s check-then-spawn has no cross-process pre-spawn lock; only the
bind-time startup lock serializes) can make the spawned child lose the race and exit while a
different daemon answers. `daemon status`'s response (005 §9.3) now carries `pid` and `reapAfterMs`
— additive fields, CLI-layer only (not a core `RuntimeStatus` change) — so `--detach` can compare the
serving pid against its own spawned pid and, on a mismatch, report the OTHER daemon's actual pid and
reap setting instead of assuming success.

**Finding 2 — ready-timeout no longer leaves the child unmanaged.** On a genuine readiness timeout
the spawned child (whose pid is now known) is sent `SIGTERM` before the command exits, and a
synchronous spawn failure (`ENOENT`/`EACCES`) is now raced against the readiness poll and reported
immediately with the real cause, rather than waiting out the full 15s and pointing at a log file the
daemon never got the chance to write.

**Finding 3 — `--log` without `--detach` now errors.** It was previously accepted and silently
ignored outside the detach branch — the same "silently ignored flag" papercut class the parent
change exists to close.

**Finding 4 — the `--reap-after-ms 0` persistence test was tautological.** It asserted survival at
2,500ms, but the boot-grace window is 10,000ms — every freshly booted daemon survives 2.5s
regardless of whether the flag ever reached it. Fixed by asserting the CONFIGURATION directly via
`daemon status`'s new `reapAfterMs` field (finding 1's addition) instead of a timing window.

**Finding 6 — the no-socket warning's "manual path only" framing was incomplete (005 §12.2.1).** A
`session start` lazy boot that times out mid-session leaves the workspace enabled with no socket
persisted — the SAME shape as a workspace that has never had a session start at all, and reachable
from the automated path, not just manual invocation. `.local.md` gained a `lastBootFailureAt` marker
(written on boot-timeout, cleared on the next successful boot) so `hook deliver` can tell the two
apart and give each an accurate remediation — the never-configured message is unchanged; the
boot-failed variant leads with automatic retry rather than "run daemon run --detach yourself."

**Finding 7 — the spawn-then-poll readiness loop had three near-identical copies.** `daemon run
--detach`, `session start`'s lazy boot, and `verify --use-workspace-daemon` each hand-rolled the same
poll-until-`daemonAvailable` loop with slightly different timeout/poll constants. Extracted into one
`waitForDaemonAvailable(socketPath, timeoutMs, pollMs?)` next to `daemonAvailable`
(`daemon-ipc.ts`); each call site keeps its own pre-existing timeout/poll values — no behavior change.

Finding 5 (test teardown pid fallback) is test-infrastructure-only, no spec change.

