---
'@agentmonitors/core': minor
---

Add a bounded durable outbox for retrying failed observation materialization.

Reject values that JSON would silently normalize, including negative zero and customized observation timestamps, before persisting any retry batch member.
