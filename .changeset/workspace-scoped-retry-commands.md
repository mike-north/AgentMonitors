---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Preserve the retry workspace in repair commands printed by explain and runtime diagnostics so pasted commands address the reported retry from any directory. Share the POSIX shell argument helpers between core diagnostics and CLI suggestions, including paths with quotes and shell metacharacters.
