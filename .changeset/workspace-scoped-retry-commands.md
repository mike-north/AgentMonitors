---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
---

Preserve the retry workspace in repair commands printed by explain and runtime diagnostics so pasted commands address the reported retry from any directory. Share the POSIX shell argument helpers between core diagnostics and CLI suggestions, including paths with quotes and shell metacharacters.

Place repair flags before `--` and monitor/retry IDs after it in explain, runtime diagnostics, and doctor suggestions so monitors whose names begin with `-` can be repaired by pasting the printed commands.

Apply the same option terminator to every follow-up explain/history hint printed by retry repairs and doctor, including dropped observations, pending retries and orphan retained work. Core and CLI share an internal monitor command builder that owns shell quoting and flag/ID ordering without adding a public API or changing runtime repair diagnostic text.
