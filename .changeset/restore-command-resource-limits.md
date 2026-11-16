---
'@agentmonitors/source-command-poll': patch
---

Preserve the parent's open-file limits when starting bounded commands. Nonnegative safe
soft integers through 9007199254740991 and unlimited are reproduced exactly, while finite
soft limits at or above 2^53 are refused before spawning. Keep the native hard limit exact,
including finite values above 2^53, and restore the soft value after watchdog arming without
writing a diagnostic report to disk. Report an execution error and retain the prior baseline
if capture or native restoration cannot be verified.
