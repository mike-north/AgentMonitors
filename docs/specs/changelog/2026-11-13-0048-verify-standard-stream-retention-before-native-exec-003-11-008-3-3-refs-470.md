## 2026-11-13 — Verify standard-stream retention before native exec (003 §11; 008 §3.3) — Refs #470

Clear close-on-exec on stdin/stdout/stderr with the platform's variadic `fcntl` ABI, then read
each flag back. A failed setter/getter or retained `FD_CLOEXEC` refuses authored execution and
keeps the prior successful baseline with failing health. Native descriptor and injected
failure regressions verify the contract, including the Darwin arm64 variadic calling convention.

