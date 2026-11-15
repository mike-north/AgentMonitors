---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
'@agentmonitors/source-command-poll': patch
---

Identify watchdog roles in command ownership evidence. Preserve a command group's watchdog when restart cleanup cannot verify a group member. Record why the group bound remains active and retain per-process ownership checks for fully verified cleanup.

Keep per-process cleanup for groups without verified watchdogs, reconcile late forks beside terminal identities, and bound restart terminal scans and durable receipt writes.

Commit preservation decisions before awaiting unrelated terminal evidence, keeping receipt writes bounded. Persist invalid stored PID diagnostics before further identity queries.
