---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Preserve the retry workspace in repair commands printed by explain and runtime diagnostics so pasted commands address the reported retry from any directory. Share the POSIX shell argument helpers between core diagnostics and CLI suggestions, including paths with quotes and shell metacharacters.

Place repair flags before `--` and monitor/retry IDs after it in explain, runtime diagnostics, and doctor suggestions so monitors whose names begin with `-` can be repaired by pasting the printed commands.
