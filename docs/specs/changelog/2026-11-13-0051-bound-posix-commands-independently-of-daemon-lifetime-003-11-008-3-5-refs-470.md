## 2026-11-13 — Bound POSIX commands independently of daemon lifetime (003 §11; 008 §3–§5) — Refs #470

Require a timer-armed in-group watchdog before authored command execution. Preserve the command
PID, original group and inherited ownership mark for restart reconciliation. The watchdog keeps
referenced absolute deadlines across daemon loss and closed command descriptors, signals only
its own current group. A normally completed finite observation releases its group after output
capture; no empty-table read may cancel a late fork's bound. Monotonic deadlines withstand wall-clock
corrections. Arming is
asynchronous and fails closed. Graceful daemon shutdown cancels admissions and identity-verifies
forceful cleanup of in-flight groups. macOS/Linux crash, SIGTERM/SIGINT, ordering, timer-failure,
restricted-PATH, responsiveness and maximum-timer regressions verify the contract; Windows and
re-sessioned-descendant limits remain explicit. Test-global restoration uses teardown hooks.

