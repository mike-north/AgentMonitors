---
'@agentmonitors/core': patch
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Refuse non-regular command life tokens promptly before execution and recover command admission after a failed journal commit, preserving committed ownership and unrelated replacement files.
