## 2026-11-15 — Preserve command resource limits across launcher startup (003 §11.2) — Refs #631

Admitted authored commands preserve the resource limits of a plain spawn from the same
running parent. Capture the exact soft/hard `RLIMIT_NOFILE` pair directly with native
`getrlimit` through the lazily cached vendored binding. Encode finite fields with BigInt
and platform infinity as `unlimited`; capture neither generates diagnostics nor writes
files, and does not depend on daemon sockets, handles or worker progress. Linux native
admission checks glibc without a diagnostic report. After watchdog arming, verify the
inherited hard field against capture, restore the soft value and verify the full pair.
Native load/read failures refuse before spawn, preserving the baseline and committed
ownership mark without adding a PID suspicion. Native restore and pair mismatches also
refuse execution. Native macOS/Linux comparisons, macOS finite soft/hard values above
2^53, fault refusals, binding reuse, no-report/no-write capture and a busy-daemon
one-second observation cover the contract.

