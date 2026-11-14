---
'@agentmonitors/source-command-poll': minor
'@agentmonitors/cli': patch
---

Bound macOS and Linux command groups with a watchdog armed before command execution, so timeout cleanup survives daemon death and closed output streams. Release remaining background work when a finite observation completes. Preserve command ownership for restart reconciliation and terminate in-flight command groups on graceful daemon shutdown. The command source factory accepts an optional shutdown signal.
