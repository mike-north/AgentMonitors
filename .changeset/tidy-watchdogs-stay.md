---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Preserve a command group's watchdog when restart cleanup cannot verify a group member. Record why the group bound remains active and retain per-process ownership checks for fully verified cleanup.
