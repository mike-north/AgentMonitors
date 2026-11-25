## 2026-11-12 — Restart command cleanup records crash-safe ownership and conservative outcomes (008 §2.2/§4.2–4.3/§5; 004 §3.5.1a) — Closes #478

The macOS/Linux daemon commits an inherited random life mark in a workspace-scoped journal before
commands spawn. Startup finds marked survivors regardless of re-sessioning, excludes live owners,
and rechecks boot, mark and start-time identity inside the existing recorded-process signal gate.
Unconfirmed candidates survive with durable abstention reasons; detached mark-erased escapes remain
unattributed. Receipts distinguish empty, completed, incomplete and interrupted passes. This makes
POSIX command restart reconciliation current; #470's daemon-independent deadline bounds, #480's
full-boundary deadline reporting, #507's active warnings and #426's adjacent hygiene remain target.

Integration coverage proves killed-daemon tree cleanup, detached retained/erased marks, responsive
unrelated identifier survival, boot-scale reuse and empty passes. Core coverage exercises missing
spawn-PID records and signal-time evidence changes. The new signal site is inventoried in 008 §5.2. Empty-journal startup performs no host identity
queries; the first command awaits its durable admission mark, while actual previous lives are
still swept before readiness. Capture fixtures record their own wrapper identities and use
verified per-process cleanup instead of signalling a PGID guessed from a PPID.
Unreadable ownership marks retain their affected PIDs as discovery abstentions, without attributing
those processes to a command. Escape silence is per process: unrelated unreadable marks can make
the overall pass incomplete while positively confirmed work is reaped.
Later discovery skips ownership reads for positively terminal incarnations while still inspecting
reused PIDs whose process identities differ.

