---
'@agentmonitors/source-command-poll': patch
'@agentmonitors/cli': patch
---

Preserve kernel executable-path traversal and authored environment values during command admission, retain failing health and the previous baseline on exec failure, reject unrepresentable NUL bytes without truncating argv or environment values, restore native signal dispositions and masks, report ordinary exec errno without native crashes, isolate helpers from authored and inherited Node options while preserving them for the command, and release settled callers while independent watchdog deadlines remain armed.
