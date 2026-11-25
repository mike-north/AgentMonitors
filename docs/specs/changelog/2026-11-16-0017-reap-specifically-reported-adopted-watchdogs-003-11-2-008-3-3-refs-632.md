## 2026-11-16 — Reap specifically reported adopted watchdogs (003 §11.2; 008 §3.3) — Refs #632

Linux PID 1 observers and existing child subreapers now reap their own adopted watchdog zombies.
The watchdog directly reports PID, initial parent and kernel birth time on a separate private
pipe before arming any deadline, so intermediate death cannot lose that report. Pending adoption
never grants wait authority. Linux intermediates reap unarmed watchdogs before reporting startup
failure. A fresh check requires that lifetime to be this observer's zombie child in the original group and session.
Resource capture and reaping share one lazy parent-side native binding and libc handle.
Only positive-PID nonblocking waits are permitted, with no wildcard waits, signals or changes
to libuv child ownership. Ordinary Linux processes and macOS do not reap. Unit refusal cases,
a native Linux subreaper test, and a PID 1 Docker regression cover identity, eligibility, real
command exit statuses and repeated observations without zombie accumulation.

