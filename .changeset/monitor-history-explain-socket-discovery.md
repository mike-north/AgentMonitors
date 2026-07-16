---
'@agentmonitors/cli': patch
'agentmonitors': patch
---

`monitor history` and `monitor explain` now auto-discover the same per-workspace daemon socket
`doctor`, `daemon status`, and `session open` already do — flagless, from the current working
directory. Previously they fell back to the bare global-default socket instead of
`resolveManualDaemonSocketPath()`'s workspace-aware resolution, so a daemon already running for
the workspace (e.g. lazily booted by a Claude Code session) was invisible to `monitor
history`/`monitor explain` unless `--socket` was passed explicitly — surfacing as a misleading "No
daemon running and no persisted state to show" even while `doctor`/`daemon status` confirmed the
daemon was live (issue #374).

Their no-daemon in-process fallback now also reads the same workspace-resolved SQLite database
`doctor` reads, instead of the bare global default. When genuinely nothing is reachable and
nothing is persisted, an actionable remediation message is printed, worded according to whether the
workspace is actually enabled — i.e. whether a workspace-scoped socket was really derived, or the
probe fell through to the bare global default:

```
No daemon running for this workspace and no persisted state to show. Start it with `agentmonitors
daemon run` (or it starts automatically when a Claude Code session opens); if the daemon you want
lives at a different socket, point at it with `--socket <path>`. Or use `agentmonitors monitor
test <path>` for a one-shot check.
```

```
No daemon running at the default socket and no persisted state to show. Start it with
`agentmonitors daemon run`, enable this workspace so its socket is auto-discovered
(`agentmonitors init --enable-only`), or point at the daemon you want with `--socket <path>`. Or
use `agentmonitors monitor test <path>` for a one-shot check.
```

`monitor history --workspace <path>` (an existing opt-in row filter) now also selects which
workspace's daemon/db is reached, since the workspace whose history you're asking for is also the
daemon you want to talk to. The per-workspace socket/db derivation itself and `--socket`'s
explicit-override precedence are unchanged.
