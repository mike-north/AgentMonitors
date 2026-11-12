---
'@agentmonitors/core': patch
---

Flush held debounce and rollup work on time while a monitor's source keeps failing. A debounce batch now flushes at its original deadline, and a rollup batch at its matching window, even when every `observe()` rejects. The source baseline and scheduling time stay unchanged, the failure is still reported beside the flushed events and stays the newest history outcome, and a failed flush keeps the work held for the next tick. Schema-invalid and missing definitions still keep held work blocked.
