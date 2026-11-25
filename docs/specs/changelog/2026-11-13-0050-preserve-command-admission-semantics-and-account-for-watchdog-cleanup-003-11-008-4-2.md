## 2026-11-13 — Preserve command admission semantics and account for watchdog cleanup (003 §11; 008 §4.2) — Refs #470

Clarify current direct-exec behavior: default signal dispositions and an empty signal mask match
normal spawn, helpers exclude authored/inherited Node options while the command retains them,
and ordinary exec failures report errno and the program without a native abort or crash artifact.
Unrepresentable NUL bytes in argv/environment fail closed instead of being truncated. ESM/CJS
consumers retain package-relative native binding resolution, including CommonJS eval callers.
A packaged native binding calls libc execve; a separate close-on-exec status pipe orders errors
before settlement. Native signal-state, preload-isolation and exec-error regressions verify both
platforms. Existing guarantees remain: kernel path traversal and authored environment values
survive admission, helper module mode does not change authored Node options, and native exec
failures retain failing health and the prior successful baseline. Settled callers release their
control-channel event-loop reference while the watchdog retains its independent kill grace.
Restart reconciliation includes the marked watchdog as an independently identified process;
a command with one descendant yields three Linux reaped outcomes. The existing identity gate
and terminal-evidence requirement apply to all three. Verified by source admission regressions,
the standalone consumer lifetime test and the restart-sweep integration suite.

