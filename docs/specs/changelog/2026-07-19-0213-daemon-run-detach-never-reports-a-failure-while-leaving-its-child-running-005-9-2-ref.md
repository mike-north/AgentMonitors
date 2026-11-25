## 2026-07-19 — `daemon run --detach` never reports a failure while leaving its child running (005 §9.2) — Refs #389

Review follow-up. `--detach`'s unproven-identity branch reported failure and returned **without
terminating the child it had spawned**. If our child was in fact the daemon that successfully bound
the socket but `daemon status` never proved it (persistent status errors, or no pid reported), the
command told the user it was not started, exited non-zero, and left an unowned daemon serving —
indefinitely under `--reap-after-ms 0` — so the retry its own error message suggested then collided
with the process that invocation orphaned.

Every non-success `--detach` outcome (readiness timeout, spawn error, race loss, unproven identity)
now terminates the spawned process and **confirms it is gone** — `SIGTERM`, escalating to `SIGKILL`
if it has not exited within a short grace window — before returning, and the error message states
whether that cleanup succeeded. Only the pid THIS invocation spawned is ever signalled: a daemon
proven to be serving under a different pid belongs to a concurrent lazy boot and is left untouched.

