---
'@agentmonitors/core': patch
---

Preserve the complete source span and held work when SQLite aborts an admission transaction. Stop fallback retry and checkpoint writes after native rollback, retain prior committed events and recipient cache, and preserve the original failure for diagnosis. Route failed held observations through their captured source after a source-type edit.
