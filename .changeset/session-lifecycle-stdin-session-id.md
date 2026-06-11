---
'@agentmonitors/cli': patch
---

Fix `session start`/`session end` to read the host session id from the hook stdin payload (`session_id`) instead of the nonexistent `CLAUDE_CODE_SESSION_ID` env var; the activation lifecycle now actually registers the session in a real Claude Code session.
