---
'@agentmonitors/core': patch
---

Preserve pending rollup batches when a not-due window flush cannot commit its events, retry outbox, and notify state atomically.
