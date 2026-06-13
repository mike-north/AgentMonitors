---
'@agentmonitors/source-api-poll': patch
'@agentmonitors/source-command-poll': patch
---

Add caller-held cursor threading for poll sources, including `{{state}}` templating, JSON `next-state` extraction, and cursor-only suppression for `json-diff`.
