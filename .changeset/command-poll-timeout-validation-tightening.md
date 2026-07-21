---
'@agentmonitors/source-command-poll': patch
---

Tighten `timeout` scope-field validation via core's hardened `parseOperationTimeoutMs` (issue #304
review, second round). Two compat-affecting changes: a leading-zero duration (`"01s"`) is now
**rejected** — previously accepted by the parser even though the JSON Schema `pattern` already
rejected it, a schema/parser mismatch this closes by tightening the parser to match the schema; and
a present but non-string `timeout` (e.g. `timeout: 123` or `timeout: null`) is now rejected instead
of silently falling back to the 30s default like a genuinely omitted field. Also rejects a duration
exceeding Node's `setTimeout` maximum (`2_147_483_647`ms, ~24.8 days — e.g. `"25d"`), which
previously would have silently overflowed to a near-instant timer instead of the author's intended
deadline.
