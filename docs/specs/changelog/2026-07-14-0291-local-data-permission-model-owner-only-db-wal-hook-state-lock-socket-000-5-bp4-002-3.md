## 2026-07-14 — Local-data permission model: owner-only db/WAL/hook-state/lock/socket (000 §5 BP4, 002 §3.1, §10.2–§10.3) — Refs #292

Agent Monitors persisted its database, WAL/SHM sidecars, hook state, and IPC socket with
umask-derived default modes, and the long-socket-path fallback wrote a predictable
`/tmp/agentmonitors-<hash>.sock`. On a multi-user host with permissive home/XDG modes another local
user could read the database or connect to the unauthenticated socket. All entries below are
_current_.

- **000 §5 — new BP4 (current).** Added the boundary property "Local artifacts are owner-private":
  the single-user local trust boundary requires owner-only creation (dirs `0700`, files `0600`,
  owner-only sockets inside owner-only directories) and symlink-safe tightening of pre-existing
  world-readable artifacts on startup. Added to the 000 §7 cross-reference row for 002.
- **002 §3.1 — new normative section (current).** Defines the local-data permission model: which
  artifacts are `0700`/`0600`, the restricted-umask creation invariant, the tighten-on-startup
  migration, and the symlink-safe (`lstat` + `O_NOFOLLOW` + `fchmod`) rule. Notes that a
  user-chosen (`--socket`/`AGENTMONITORS_SOCKET`) or shared system socket directory is _not_
  tightened, and that Windows has no mode enforcement.
- **002 §10.3 — changed (current).** The long-socket-path fallback now resolves to
  `/tmp/agentmonitors-<uid>/agentmonitors-<hash>.sock` — an owner-only per-uid directory
  (atomic-`mkdir`-or-verify-owned) — instead of a predictable socket directly under world-writable
  `/tmp`. The base stays `/tmp` (not the platform temp root) so the substituted socket stays under
  the 100-char AF_UNIX limit on macOS.
- **002 §10.2 — clarified (current).** `daemon run`'s socket, socket directory, and startup-lock
  directory are owner-only.

