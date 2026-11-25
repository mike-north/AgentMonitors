## 2026-11-13 — Restore blocking native standard streams before exec (003 §11; 008 §3.3) — Refs #470

Clear `O_NONBLOCK` on all three standard descriptors using platform-specific variadic `fcntl`
constants and verify each status with a fresh `F_GETFL`. Preserve access mode, append mode and
unrelated flags. Failed status operations or surviving nonblocking mode refuse authored work
and retain the prior baseline through the existing stdio admission diagnostic. Native Perl
pressure writers and delayed-input reads exercise blocking I/O without a compiler; real flag
priming and injected read/write/read-back failures cover all standard streams and fail-closed
admission. Ordinary source stdin remains ignored. Signal, process-group, environment, descriptor
layout and watchdog ownership contracts remain unchanged.

