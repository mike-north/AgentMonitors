---
'@agentmonitors/cli': patch
'@agentmonitors/source-api-poll': patch
---

Treat non-2xx api-poll responses as observation errors instead of establishing or advancing baselines.
