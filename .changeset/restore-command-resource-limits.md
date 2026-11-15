---
'@agentmonitors/source-command-poll': patch
---

Preserve the parent's soft and hard open-file limits when starting bounded commands. Report
an execution error and retain the prior baseline if the launcher cannot restore those limits.
