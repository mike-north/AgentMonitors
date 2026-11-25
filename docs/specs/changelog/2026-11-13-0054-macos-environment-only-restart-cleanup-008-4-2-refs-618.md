## 2026-11-13 — macOS environment-only restart cleanup (008 §4.2) — Refs #618

macOS ownership now comes from kernel `KERN_PROCARGS2` envp, after counting argv by
argc. One asynchronous stock `/usr/bin/osascript -l JavaScript` helper calls sysctl
through Foundation-owned buffers for discovery batches and fresh signal-time checks.
No developer tools or Python shim are involved. Empty/padded argv entries, title rewrites
and unproven envp boundaries are per-PID unreadability, never readable/unmarked evidence.
Unavailable helpers and unreadable process environments retain explicit abstentions. Batch macOS final identity checks, individual signal gates, terminal
evidence and receipt writes without weakening boot, mark or start-time verification.
Helper completion, failure and timeout cleanup also uses the shared live-child
signal gate; an already reaped helper receives no cleanup signal.
Real restart tests require macOS command/descendant reaps. Reader tests cover argv-only
marks, empty arguments, Homebrew-free PATH, optional tools and malformed evidence.

