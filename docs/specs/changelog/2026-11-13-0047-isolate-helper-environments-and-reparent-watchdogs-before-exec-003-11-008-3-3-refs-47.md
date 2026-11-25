## 2026-11-13 — Isolate helper environments and reparent watchdogs before exec (003 §11; 008 §3.3) — Refs #470

Keep authored and inherited environment values out of helper startup, using absolute runtime
paths and only the life mark in the environment. Pass the intended command environment through the
configuration pipe to native envp, preserving the plain-spawn environment budget. Linux sets
the authored PATH at the execvpe boundary. Distinguish native-module load errors from other
initialization failures. Start the watchdog through an intermediate, forward its armed
acknowledgement, reap that intermediate and drain its IPC before exec regardless of event order.
The marked watchdog keeps its original
group and independent timers without becoming a waitable child of authored work. The journal,
recorded command PID and watchdog reap accounting are unchanged. Near-limit plain-spawn controls,
helper environment captures, a portable Perl wait-all fixture and process-relationship/failure
regressions verify the contract.

