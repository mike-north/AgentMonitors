---
'@agentmonitors/core': patch
---

Start the materialization retry backoff when the retry is queued rather than when the tick began, so a slow source no longer makes a newly failed observation retry immediately. Observation timestamps are unchanged. A retry row's `createdAt`/`updatedAt` record when it was enqueued.
