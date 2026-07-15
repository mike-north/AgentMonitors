---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
'agentmonitors': patch
---

Persist local data owner-only (P1 security/privacy). Agent Monitors stores private snapshot, event,
diff, and source-state data — plus hook state and an unauthenticated IPC socket — on the local
machine, previously created with umask-derived default modes. On a multi-user host with permissive
home/XDG directory modes, another local user could read the database or connect to the socket to
inspect/claim/ack events or stop the daemon.

- The SQLite database and its WAL/SHM sidecars, hook-state files, the startup-lock pid file, and the
  `.claude/agentmonitors.local.md` coordination file are now owner-only (`0600`); the per-workspace
  data directory, session directories, socket directory, and startup-lock directory are owner-only
  (`0700`); the Unix domain socket is chmod'd `0600` and lives inside an owner-only directory.
- The long-socket-path fallback now binds inside an owner-only per-uid directory
  (`/tmp/agentmonitors-<uid>/…`) instead of a predictable `/tmp/agentmonitors-<hash>.sock` other
  local users could connect to.
- **Migration:** existing world-readable artifacts from an earlier version are tightened on the next
  daemon start. Tightening is symlink-safe (it never `chmod`s through an attacker-controlled
  symlink) and never re-modes a user-chosen (`--socket`/`AGENTMONITORS_SOCKET`) or shared system
  socket directory.
- POSIX-only; on Windows the paths are created without mode enforcement.
