---
'@agentmonitors/source-command-poll': patch
---

Preserve exact parent open-file limits when starting bounded commands, including finite
values above 2^53 and unlimited. Read the native soft/hard pair directly through the
vendored binding without diagnostic reports or filesystem writes. After watchdog arming,
verify the inherited hard field, restore the soft value and read back the full pair.
Report an execution error and retain the prior baseline if capture or restoration fails.
