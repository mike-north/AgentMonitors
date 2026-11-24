---
'@agentmonitors/core': patch
---

A recipient's per-object cursor no longer moves backward when a claim surfaces only events older than one it was already shown, such as a normal event claimed after a newer high event or a recap of older unread rows. The next delta now always starts from the newest event the recipient has seen. A repeat claim keeps the projection's first claim time and updates only the last-claim fields. Existing databases gain two cursor columns on open, filled from each cursor's baseline event.
