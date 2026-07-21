---
'@agentmonitors/core': minor
---

Harden `parseOperationTimeoutMs`'s `timeout` scope-field validation (issue #304 review, second
round): a present but non-string value (e.g. `timeout: 123` or `timeout: null`) is now rejected
instead of silently falling back to the default like a genuinely omitted field; a leading-zero
duration (`"01s"`) is now rejected, matching the JSON Schema `pattern`'s `[1-9]\d*` grammar (a
deliberate validation tightening — `parseDuration`'s own digit group previously accepted it); and a
duration exceeding Node's 32-bit `setTimeout` maximum (`2_147_483_647`ms, ~24.8 days — e.g. `"25d"`)
is now rejected instead of silently overflowing to a near-instant timer. Also exports the new
`MAX_OPERATION_TIMEOUT_MS` constant next to `DEFAULT_OPERATION_TIMEOUT_MS`.
