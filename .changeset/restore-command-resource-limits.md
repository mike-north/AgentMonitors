---
'@agentmonitors/source-command-poll': patch
---

Preserve the parent's open-file limits when starting bounded commands, including finite
values above JavaScript's safe-integer range. Keep the native hard limit and restore the
exact soft value. Capture unsafe soft values from raw diagnostic reports in private temporary
directories that are removed after capture. Report an execution error and retain the prior
baseline if exact capture or native restoration cannot be verified.
