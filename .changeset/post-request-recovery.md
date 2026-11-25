---
'@agentmonitors/core': patch
'@agentmonitors/cli': patch
---

Prioritize due posts in bounded recaps and recover committed post IDs after interrupted replies with workspace-scoped request keys.

Keep post retries on the original workspace and daemon endpoint, including when the recipient moves.
