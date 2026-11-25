---
'@agentmonitors/cli': patch
---

Retain incompatible heartbeat evidence for 48 hours before write-path cleanup, and show an advisory for newer heartbeat formats without changing doctor exit status. Doctor continues to leave registry files untouched.

Preserve concurrent heartbeat refreshes by rechecking isolated cleanup candidates and restoring fresh records without overwriting newer writes.
