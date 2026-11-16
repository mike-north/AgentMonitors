---
'@agentmonitors/core': patch
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Reap orphaned stock macOS shell and curl commands after a daemon restart using each process's own inherited, journaled vnode. Preserve fail-closed ownership checks, watchdog bounds, and authored-command resource limits.
