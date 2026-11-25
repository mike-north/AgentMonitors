## 2026-07-14 — Local-data permission hardening: no split-brain, no daemon crash, degrade gracefully (002 §3.1, §10.3) — Refs #292

Review of the owner-only permission work surfaced correctness gaps in the same change; these
clarifications keep 002 §3.1/§10.3 _current_.

- **002 §10.3 — changed (current).** The long-socket-path fallback location _moved_ in #292
  (`/tmp/agentmonitors-<hash>.sock` → `/tmp/agentmonitors-<uid>/…`). `resolveSocketPath`'s fallback
  branch now **probes the legacy path** and, if a live daemon still answers there, returns it so
  upgraded clients keep talking to the pre-upgrade daemon instead of lazy-booting a second daemon on
  the same database (split-brain). The daemon only ever binds the new path, so one restart of the
  legacy daemon completes the migration.
- **002 §3.1 — clarified (current), degrade-gracefully rule.** Tightening is best-effort: when an
  artifact exists but is owned by another user (`EPERM`/`EACCES` — e.g. a hook-state path aimed into
  a shared group-writable directory), the helpers emit one structured stderr warning per path per
  process and continue rather than throwing. A single malformed/unexpected IPC request is answered
  with an error response, never allowed to crash the daemon.
- **002 §3.1 — clarified (current), socket birth + `:memory:` + per-process tightening.** The socket
  is bound under a restricted (`0o077`) umask so it is born `0600` (the post-bind `chmod` is
  defense-in-depth; the owner-only parent directory is the load-bearing guard because `chmod` follows
  symlinks). The Agent-Monitors-owned default socket directory is re-tightened on startup even for a
  `:memory:` database (no `createDb` file-tighten call site). Re-application is idempotent and
  performed once per process, so steady-state hook-state writes skip the `lstat`/`open`/`fchmod`
  cycle after first verification.

