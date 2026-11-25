## 2026-11-13 — Validate complete admission status and match native executable lookup (003 §11; 008 §3.3) — Refs #470

Require complete status writes and reject missing, truncated, unknown or invalid frames before
accepting command output; fragmented valid frames remain supported. Preserve the baseline if
status cannot be delivered. Match plain spawn's PATH search, exhaustion errno and relative script
spelling: Linux delegates to libc execvpe (glibc shell fallback on ENOEXEC; musl reports ENOEXEC),
while macOS retries EINTR, continues EACCES/ENOENT/ENOTDIR, stops on other errnos and prefers
EACCES at exhaustion. Preserve kernel traversal and literal argv. Explain native support load
failure with loader detail. Verified by command-poll admission and real-spawn comparison tests.
The native binding is pinned to eligible 3.3.7 with no release-age exemptions or build permission.

