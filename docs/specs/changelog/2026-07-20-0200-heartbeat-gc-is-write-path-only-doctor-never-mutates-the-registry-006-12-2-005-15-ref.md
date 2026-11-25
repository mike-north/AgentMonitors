## 2026-07-20 — Heartbeat GC is write-path only; `doctor` never mutates the registry (006 §12.2, 005 §15) — Refs #425

Opportunistic reaping ran on the READ path, so the health surface destroyed the evidence of the
failure it had just reported. Two consecutive `doctor` runs, with the active lead and daemon
unchanged and nothing recovered, disagreed: the first reported `[heartbeat-stale]` and exited 1; the
second found no record at all, took the "no transport has ever reported in" branch, and exited 0. A
dead channel server looked fixed purely because somebody had looked at it — and `doctor` was
mutating state, which 005 §15 explicitly says it never does.

Reaping now belongs solely to `writeTransportHeartbeat`: an expired record is removed when a
transport re-registers, which is the real reconciliation event, not when a bystander reads the
registry. `readTransportHeartbeats()` is a pure read. A lapsed transport keeps reporting its failure
on every health check until something actually writes again. Guarded by a three-consecutive-run
integration regression and a repeated-read unit test.

