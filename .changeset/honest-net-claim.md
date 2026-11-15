---
'@agentmonitors/core': patch
---

Keep net-collapse claims aligned with the rendered delivery. A high-urgency interrupt leaves
newer normal versions of the same object pending, while independent monitor reminders still
coalesce. Recaps claim only the net groups represented within their event limit, preserving
unseen work for later delivery and across restarts.
