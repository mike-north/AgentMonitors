## 2026-11-15 — Bound token replacement refusal and recover failed admission (008 §3.3, §4.2; 003 §11.2) — Refs #626

Open committed tokens nonblocking before validating their regular-file identity, so FIFO
replacement cannot strand an unarmed launcher after daemon loss. Directory, socket and symlink
replacements also refuse before authored execution while preserving the baseline. On a handled
life-row INSERT failure, release only the uncommitted reservation's exact device/inode and
rotate its nonce for retry, including when release fails. Confirm row absence before release;
SQLite errors that retain a row preserve its file. Committed life authority stays stable;
leftover unjournaled files remain inert. Admission regressions cover prompt refusal, control EOF,
same-journal recovery, failed release and replacement preservation.

