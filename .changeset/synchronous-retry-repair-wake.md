---
'@agentmonitors/core': patch
---

Wake a paused watcher when its host synchronously re-arms or skips terminal work from onError. Release the repair wait when the host callback throws, as well as on wake, timeout and watcher shutdown.
