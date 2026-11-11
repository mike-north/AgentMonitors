---
'@agentmonitors/core': patch
---

Use durable materialization order to break equal observation-time event ties across processes. Keep net delivery previews, claims and recipient cursors aligned while preserving public event IDs and observation-time priority.
