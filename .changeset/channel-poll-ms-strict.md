---
'@agentmonitors/cli': patch
---

`channel serve --poll-ms` now accepts only a whole number from 100 to 2147483647. Negative, zero, fractional, partly numeric or out-of-range values are rejected with a one-line error and exit code 1 before the MCP server starts, instead of being silently truncated or replaced by the default. Omitting the flag still polls every 3000 ms.
