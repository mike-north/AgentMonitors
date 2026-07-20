---
'@agentmonitors/core': minor
---

Export `parseOperationTimeoutMs`, `DEFAULT_OPERATION_TIMEOUT_MS`, and `OPERATION_TIMEOUT_PATTERN`
next to `parseDuration`, centralizing the `timeout` scope-field default/parse/pattern that
`api-poll` and `command-poll` had each hand-maintained as an identical copy. The helper also
rejects a zero-length duration (`"0s"`, `"0m"`, `"0h"`, `"0d"`) even though `parseDuration` itself
accepts one — a zero-length request/command deadline is never a meaningful configuration.
