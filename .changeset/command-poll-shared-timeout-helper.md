---
'@agentmonitors/source-command-poll': patch
---

Adopt core's shared `parseOperationTimeoutMs`/`OPERATION_TIMEOUT_PATTERN` for the `timeout` scope
field instead of a hand-maintained copy of the default/parse/pattern. Behavior is unchanged except
that a zero-length `timeout` (`"0s"`, `"0m"`, `"0h"`, `"0d"`) is now rejected — previously it
silently aborted every execution instantly.
